import { randomUUID } from 'crypto';
import { getDatabase } from '../db/database';
import { describeCondition, notificationFor, parseNotifyUrls, probeAgentNotification, withEmbeds } from './delivery';
import { sendNotification, type DeliveryResult } from './apprise';
import type { Alert, AlertEvent, AlertMetric, AlertRule, AlertSettings, AlertTargetState, ProbeResult, Target } from '@/types/probe';
import { LOCAL_PROBE, type ProbeAgentState } from '@/types/probe-agent';
import type { AlertCombine, AlertCondition, AlertScopeEntry, ConditionResult, ProbePolicy, ProbeVerdict } from '@/types/alert-rules';
import { isProbeAgentDown } from '../probe-agents/store';
import { probeNames } from '../probe-agents/probes';
import { recordAlertEvent } from './history';
import { coveredProbes, isScopeEntry } from './scope';
import { conditionsOf, describePolicy, FRESH_PROBE_STATE, judgeMonitor, policyOf, stepProbe, type ProbeRuleState, type ProbeStanding } from './rules';
import {
  ALERT_METRIC_LABELS,
  DEFAULT_TRACE_COOLDOWN_MINUTES,
  DEFAULT_TRACE_KEEP_COUNT,
  DEFAULT_TRACE_KEEP_DAYS,
  MAX_TRACE_COOLDOWN_MINUTES,
  MAX_TRACE_KEEP_COUNT,
  MAX_TRACE_KEEP_DAYS,
  TRACEABLE_ALERT_METRICS,
  tracesByDefault,
} from '@/types/probe';

export const ALERT_METRICS = Object.keys(ALERT_METRIC_LABELS) as AlertMetric[];

/**
 * Alerts, and how each target stands against the ones it is ticked for.
 *
 * The tables are created by the migrations in migrations.ts, which run when
 * the database is opened; there is nothing to set up here.
 */

interface AlertRow {
  id: string;
  name: string;
  metric: AlertMetric;
  threshold: number;
  consecutive_probes: number;
  notify_urls: string | null;
  trace_on_fire: number;
  probe_agent_offline?: number;
  trace_cooldown_minutes: number;
  trace_keep_count: number;
  trace_keep_days: number;
  enabled: number;
  created_at: number;
  conditions: string | null;
  combine: string | null;
  for_minutes: number | null;
  clear_after: number | null;
  probe_policy: string | null;
  probe_quorum: number | null;
  probes: string | null;
}

interface AlertTargetRow {
  alert_id: string;
  target_id: string;
  state: 'ok' | 'firing';
  streak: number;
  last_fired_at: number | null;
  last_resolved_at: number | null;
}

function parseUrls(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function policyFromRow(row: AlertRow): ProbePolicy {
  switch (row.probe_policy) {
    case 'all':
      return { kind: 'all' };
    case 'atLeast':
      return { kind: 'atLeast', count: row.probe_quorum ?? 1 };
    case 'share':
      return { kind: 'share', percent: row.probe_quorum ?? 100 };
    default:
      return { kind: 'any' };
  }
}

function settingsFromRow(row: AlertRow): AlertSettings & { id: string; enabled: boolean; createdAt: Date } {
  return {
    id: row.id,
    conditions: parseJson<AlertCondition[]>(row.conditions),
    combine: parseJson<AlertCombine>(row.combine) ?? 'any',
    ...(row.for_minutes ? { forMinutes: row.for_minutes } : {}),
    ...(row.clear_after ? { clearAfter: row.clear_after } : {}),
    policy: policyFromRow(row),
    probes: parseJson<string[]>(row.probes) ?? null,
    name: row.name || undefined,
    metric: row.metric,
    threshold: row.threshold,
    consecutiveProbes: row.consecutive_probes,
    notifyUrls: parseUrls(row.notify_urls),
    traceOnFire: row.trace_on_fire === 1,
    probeAgentOffline: row.probe_agent_offline === 1,
    traceCooldownMinutes: row.trace_cooldown_minutes,
    traceKeepCount: row.trace_keep_count ?? DEFAULT_TRACE_KEEP_COUNT,
    traceKeepDays: row.trace_keep_days ?? DEFAULT_TRACE_KEEP_DAYS,
    enabled: row.enabled === 1,
    createdAt: new Date(row.created_at),
  };
}

function stateFromRow(row: AlertTargetRow): AlertTargetState {
  return {
    targetId: row.target_id,
    state: row.state,
    streak: row.streak,
    lastFiredAt: row.last_fired_at ? new Date(row.last_fired_at) : null,
    lastResolvedAt: row.last_resolved_at ? new Date(row.last_resolved_at) : null,
  };
}

async function run(sql: string, params: unknown[] = []): Promise<number> {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
  });
}

// ─── Reading and writing alerts ─────────────────────────────────────────────

export async function getAlerts(): Promise<Alert[]> {
  const [alerts, states, breaching, scopes] = await Promise.all([
    all<AlertRow>('SELECT * FROM alerts ORDER BY created_at ASC'),
    all<AlertTargetRow>('SELECT * FROM alert_targets'),
    all<{ alert_id: string; target_id: string; probe: string }>(
      `SELECT s.alert_id, s.target_id, s.probe FROM alert_probe_states s
       JOIN target_probes p ON p.target_id = s.target_id AND p.probe = s.probe AND p.removed_at IS NULL
       WHERE s.in_breach = 1`
    ),
    all<{ alert_id: string; kind: AlertScopeEntry['kind']; ref: string }>('SELECT alert_id, kind, ref FROM alert_scope'),
  ]);

  const holding = new Map<string, string[]>();
  for (const row of breaching) {
    const key = `${row.alert_id}|${row.target_id}`;
    holding.set(key, [...(holding.get(key) ?? []), row.probe]);
  }

  const byAlert = new Map<string, AlertTargetState[]>();
  for (const row of states) {
    const list = byAlert.get(row.alert_id) ?? [];
    const probes = row.state === 'firing' ? holding.get(`${row.alert_id}|${row.target_id}`) : undefined;
    list.push({ ...stateFromRow(row), ...(probes ? { breachingProbes: probes } : {}) });
    byAlert.set(row.alert_id, list);
  }

  const scopeOf = (id: string): AlertScopeEntry[] => scopes.filter(row => row.alert_id === id).map(row => ({ kind: row.kind, ref: row.ref }));
  return alerts.map(row => ({ ...settingsFromRow(row), scope: scopeOf(row.id), targets: byAlert.get(row.id) ?? [] }));
}

export async function getAlert(id: string): Promise<Alert | null> {
  return (await getAlerts()).find(alert => alert.id === id) ?? null;
}

/** Every alert a target is ticked for, each with that target's state. */
export async function getAlertRules(targetId: string): Promise<AlertRule[]> {
  const rows = await all<AlertRow & AlertTargetRow>(
    `SELECT a.*, t.target_id, t.state, t.streak, t.last_fired_at, t.last_resolved_at
     FROM alert_targets t
     JOIN alerts a ON a.id = t.alert_id
     WHERE t.target_id = ?
     ORDER BY a.created_at ASC`,
    [targetId]
  );
  return rows.map(row => ({ ...settingsFromRow(row), ...stateFromRow(row) }));
}

/**
 * What making or changing an alert takes. Whether it traces, and how often,
 * may be left out: an alert made without saying traces if its metric is one
 * that always used to (see tracesByDefault).
 */
export type AlertInput = Omit<AlertSettings, 'traceOnFire' | 'traceCooldownMinutes' | 'traceKeepCount' | 'traceKeepDays'> &
  Partial<Pick<AlertSettings, 'traceOnFire' | 'traceCooldownMinutes' | 'traceKeepCount' | 'traceKeepDays'>> & {
    targetIds: string[];
    enabled?: boolean;
  };

const MAX_CONDITIONS = 6;
const MAX_DURATION = 7 * 24 * 60;

function parseConditions(raw: unknown): { ok: true; conditions: AlertCondition[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CONDITIONS) return { ok: false, error: `conditions is a list of 1 to ${MAX_CONDITIONS}` };
  const conditions: AlertCondition[] = [];
  for (const entry of raw) {
    const each = entry as Partial<AlertCondition> | null;
    if (!each || !ALERT_METRICS.includes(each.metric as AlertMetric)) return { ok: false, error: `Each condition's metric is one of: ${ALERT_METRICS.join(', ')}` };
    const threshold = each.metric === 'unreachable' ? 0 : Number(each.threshold);
    if (!Number.isFinite(threshold) || threshold < 0) return { ok: false, error: 'A threshold must be a non-negative number' };
    const condition: AlertCondition = { metric: each.metric as AlertMetric, threshold };
    if (each.clearThreshold !== undefined && each.clearThreshold !== null && each.metric !== 'unreachable') {
      const clear = Number(each.clearThreshold);
      if (!Number.isFinite(clear) || clear < 0) return { ok: false, error: 'A clear threshold must be a non-negative number' };
      condition.clearThreshold = clear;
    }
    if (each.window !== undefined && each.window !== null) {
      if (!Number.isInteger(each.window) || each.window < 1 || each.window > 100) return { ok: false, error: 'A window is from 1 to 100 readings' };
      if (each.window > 1) condition.window = each.window;
    }
    conditions.push(condition);
  }
  return { ok: true, conditions };
}

function parsePolicy(raw: unknown): { ok: true; policy: ProbePolicy } | { ok: false; error: string } {
  if (raw === 'any' || raw === 'all') return { ok: true, policy: { kind: raw } };
  const each = raw as { kind?: unknown; count?: unknown; percent?: unknown } | null;
  if (each?.kind === 'any' || each?.kind === 'all') return { ok: true, policy: { kind: each.kind } };
  if (each?.kind === 'atLeast' && typeof each.count === 'number' && Number.isInteger(each.count) && each.count >= 1 && each.count <= 1000) {
    return { ok: true, policy: { kind: 'atLeast', count: each.count } };
  }
  if (each?.kind === 'share' && typeof each.percent === 'number' && each.percent > 0 && each.percent <= 100) {
    return { ok: true, policy: { kind: 'share', percent: Math.round(each.percent) } };
  }
  return { ok: false, error: 'policy is "any", "all", { kind: "atLeast", count } or { kind: "share", percent }' };
}

/**
 * Check and tidy what the API was sent for an alert.
 *
 * With `partial`, only the fields present are checked: that is an edit, which
 * may be nothing more than switching the alert off.
 */
export function parseAlertInput(
  body: Record<string, unknown>,
  partial = false
): { ok: true; input: Partial<AlertInput> } | { ok: false; error: string } {
  const input: Partial<AlertInput> = {};
  const fail = (error: string) => ({ ok: false as const, error });
  const given = (field: string) => body[field] !== undefined;

  if (given('name')) input.name = String(body.name ?? '').trim().slice(0, 80);

  const conditions = given('conditions') ? parseConditions(body.conditions) : null;
  if (conditions && !conditions.ok) return fail(conditions.error);
  if (conditions?.ok) {
    // The first condition is also the alert's metric and threshold, which an older client and image read.
    input.conditions = conditions.conditions;
    input.metric = conditions.conditions[0].metric;
    input.threshold = conditions.conditions[0].threshold;
  }

  if (!conditions && (given('metric') || !partial)) {
    if (!ALERT_METRICS.includes(body.metric as AlertMetric)) {
      return fail(`Invalid metric. Expected one of: ${ALERT_METRICS.join(', ')}`);
    }
    input.metric = body.metric as AlertMetric;
  }

  if (!conditions && (given('threshold') || !partial)) {
    // 'unreachable' has no threshold to compare against; everything else does.
    const threshold = body.metric === 'unreachable' ? 0 : Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 0) return fail('Threshold must be a non-negative number');
    input.threshold = threshold;
  }

  if (given('consecutiveProbes') || !partial) {
    const consecutiveProbes = Number(body.consecutiveProbes ?? 3);
    if (!Number.isInteger(consecutiveProbes) || consecutiveProbes < 1 || consecutiveProbes > 100) {
      return fail('consecutiveProbes must be between 1 and 100');
    }
    input.consecutiveProbes = consecutiveProbes;
  }

  if (given('notifyUrls') || !partial) {
    // None is an alert that is only shown in the app, and an empty list is
    // how an edit stops one being sent.
    const notifyUrls = parseNotifyUrls(body.notifyUrls);
    if (!notifyUrls) {
      return fail('notifyUrls must be Apprise URLs, such as discord://… or mailto://…, as a list or one to a line');
    }
    input.notifyUrls = notifyUrls;
  }

  if (given('probeAgentOffline')) {
    if (typeof body.probeAgentOffline !== 'boolean') return fail('probeAgentOffline must be a boolean');
    input.probeAgentOffline = body.probeAgentOffline;
  }

  if (given('traceOnFire')) {
    if (typeof body.traceOnFire !== 'boolean') return fail('traceOnFire must be a boolean');
    input.traceOnFire = body.traceOnFire;
  }

  if (given('traceCooldownMinutes')) {
    const minutes = Number(body.traceCooldownMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TRACE_COOLDOWN_MINUTES) {
      return fail(`traceCooldownMinutes must be a whole number of minutes from 1 to ${MAX_TRACE_COOLDOWN_MINUTES}`);
    }
    input.traceCooldownMinutes = minutes;
  }

  if (given('traceKeepCount')) {
    const count = Number(body.traceKeepCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_TRACE_KEEP_COUNT) {
      return fail(`traceKeepCount must be a whole number from 1 to ${MAX_TRACE_KEEP_COUNT}`);
    }
    input.traceKeepCount = count;
  }

  if (given('traceKeepDays')) {
    const days = Number(body.traceKeepDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_TRACE_KEEP_DAYS) {
      return fail(`traceKeepDays must be a whole number of days from 1 to ${MAX_TRACE_KEEP_DAYS}`);
    }
    input.traceKeepDays = days;
  }

  if (given('combine')) {
    const combine = body.combine as unknown;
    if (combine === 'any' || combine === 'all') input.combine = combine;
    else {
      const count = typeof combine === 'number' ? combine : (combine as { atLeast?: unknown } | null)?.atLeast;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_CONDITIONS) return fail(`combine is "any", "all", or { atLeast: 1 to ${MAX_CONDITIONS} }`);
      input.combine = { atLeast: count };
    }
  }

  for (const [field, column] of [['forMinutes', 'minutes'], ['clearAfter', 'clear time']] as const) {
    if (!given(field)) continue;
    const value = body[field];
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_DURATION) return fail(`${field} is a whole number of ${column} from 1 to ${MAX_DURATION}, or null`);
    input[field] = value;
  }
  if (given('forMinutes') && body.forMinutes === null) input.forMinutes = 0;
  if (given('clearAfter') && body.clearAfter === null) input.clearAfter = 0;

  if (given('policy')) {
    const policy = parsePolicy(body.policy);
    if (!policy.ok) return fail(policy.error);
    input.policy = policy.policy;
  }

  if (given('probes')) {
    const probes = body.probes;
    if (probes !== null && (!Array.isArray(probes) || !probes.every(each => typeof each === 'string' && each))) {
      return fail('probes is a list of probe ids ("local" for the dashboard\'s own), or null for every probe');
    }
    input.probes = probes === null ? null : [...new Set(probes as string[])];
  }

  if (given('scope')) {
    if (!Array.isArray(body.scope) || !body.scope.every(isScopeEntry)) return fail('scope is a list of { kind: "monitor" | "group" | "probe", ref }');
    input.scope = body.scope.map(entry => ({ kind: entry.kind, ref: entry.ref }));
  }

  if (given('targetIds') || (!partial && !given('scope'))) {
    if (!Array.isArray(body.targetIds)) return fail('targetIds must be a list of target ids');
    input.targetIds = [...new Set(body.targetIds.map(String))];
  }

  if (given('enabled')) {
    if (typeof body.enabled !== 'boolean') return fail('enabled must be a boolean');
    input.enabled = body.enabled;
  }

  return { ok: true, input };
}

/** The ids among `targetIds` that are real targets, so a stale tick cannot fail the insert. */
async function existingTargets(targetIds: string[]): Promise<string[]> {
  const known = new Set((await all<{ id: string }>('SELECT id FROM targets')).map(row => row.id));
  return targetIds.filter(id => known.has(id));
}

export async function createAlert(input: AlertInput): Promise<Alert> {
  const id = randomUUID();

  await run(
    `INSERT INTO alerts
      (id, name, metric, threshold, consecutive_probes, notify_urls, trace_on_fire, trace_cooldown_minutes, trace_keep_count, trace_keep_days, enabled, created_at,
       conditions, combine, for_minutes, clear_after, probe_policy, probe_quorum, probes, probe_agent_offline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name ?? '',
      input.metric,
      input.threshold,
      input.consecutiveProbes,
      JSON.stringify(input.notifyUrls),
      (input.traceOnFire ?? tracesByDefault(input.metric)) ? 1 : 0,
      input.traceCooldownMinutes ?? DEFAULT_TRACE_COOLDOWN_MINUTES,
      input.traceKeepCount ?? DEFAULT_TRACE_KEEP_COUNT,
      input.traceKeepDays ?? DEFAULT_TRACE_KEEP_DAYS,
      input.enabled === false ? 0 : 1,
      Date.now(),
      input.conditions ? JSON.stringify(input.conditions) : null,
      input.combine !== undefined ? JSON.stringify(input.combine) : null,
      input.forMinutes || null,
      input.clearAfter || null,
      ...policyColumns(input.policy),
      input.probes ? JSON.stringify(input.probes) : null,
      input.probeAgentOffline ? 1 : 0,
    ]
  );

  await writeScope(id, { monitors: input.targetIds ?? [], scope: input.scope });
  return (await getAlert(id))!;
}

/** The two columns a policy is stored in. */
function policyColumns(policy: ProbePolicy | undefined): [string, number] {
  if (!policy || policy.kind === 'any' || policy.kind === 'all') return [policy?.kind ?? 'any', 1];
  return policy.kind === 'atLeast' ? ['atLeast', policy.count] : ['share', policy.percent];
}

/**
 * Where an alert applies. A `scope` replaces everything; monitors alone (the
 * ticks an older client sends) replace only the monitor entries and leave the
 * groups and probes as they are. Ticked monitors are also kept
 * as `alert_targets`, which is where each one's state lives.
 */
async function writeScope(alertId: string, change: { monitors?: string[]; scope?: AlertScopeEntry[] }): Promise<void> {
  const known = change.monitors ? await existingTargets(change.monitors) : undefined;
  const entries = change.scope
    ? change.scope
    : (await all<ScopeRow>('SELECT alert_id, kind, ref FROM alert_scope WHERE alert_id = ? AND kind != ?', [alertId, 'monitor'])).map(row => ({ kind: row.kind, ref: row.ref }));
  const monitors = known ?? (change.scope ? await existingTargets(change.scope.filter(entry => entry.kind === 'monitor').map(entry => entry.ref)) : null);

  if (monitors) {
    await run('DELETE FROM alert_scope WHERE alert_id = ? AND kind = ?', [alertId, 'monitor']);
    const ticked = (await all<{ target_id: string }>('SELECT target_id FROM alert_targets WHERE alert_id = ?', [alertId])).map(row => row.target_id);
    // Targets that stay ticked keep their state: unticking one must not make
    // the others forget that they are firing.
    for (const targetId of ticked.filter(targetId => !monitors.includes(targetId))) {
      await run('DELETE FROM alert_targets WHERE alert_id = ? AND target_id = ?', [alertId, targetId]);
      await run('DELETE FROM alert_probe_states WHERE alert_id = ? AND target_id = ?', [alertId, targetId]);
    }
    for (const targetId of monitors) {
      await run('INSERT OR IGNORE INTO alert_targets (alert_id, target_id) VALUES (?, ?)', [alertId, targetId]);
      await run('INSERT OR IGNORE INTO alert_scope (alert_id, kind, ref) VALUES (?, ?, ?)', [alertId, 'monitor', targetId]);
    }
  }
  if (change.scope) {
    await run('DELETE FROM alert_scope WHERE alert_id = ? AND kind != ?', [alertId, 'monitor']);
    for (const entry of entries.filter(each => each.kind !== 'monitor')) {
      await run('INSERT OR IGNORE INTO alert_scope (alert_id, kind, ref) VALUES (?, ?, ?)', [alertId, entry.kind, entry.ref]);
    }
  }
}

export async function updateAlert(id: string, changes: Partial<AlertInput>): Promise<Alert | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (changes.name !== undefined) set('name', changes.name);
  if (changes.metric !== undefined) set('metric', changes.metric);
  if (changes.threshold !== undefined) set('threshold', changes.threshold);
  if (changes.consecutiveProbes !== undefined) set('consecutive_probes', changes.consecutiveProbes);
  if (changes.notifyUrls !== undefined) set('notify_urls', JSON.stringify(changes.notifyUrls));
  if (changes.traceOnFire !== undefined) set('trace_on_fire', changes.traceOnFire ? 1 : 0);
  if (changes.probeAgentOffline !== undefined) set('probe_agent_offline', changes.probeAgentOffline ? 1 : 0);
  if (changes.traceCooldownMinutes !== undefined) set('trace_cooldown_minutes', changes.traceCooldownMinutes);
  if (changes.traceKeepCount !== undefined) set('trace_keep_count', changes.traceKeepCount);
  if (changes.traceKeepDays !== undefined) set('trace_keep_days', changes.traceKeepDays);
  if (changes.enabled !== undefined) set('enabled', changes.enabled ? 1 : 0);
  if (changes.conditions !== undefined) set('conditions', JSON.stringify(changes.conditions));
  if (changes.combine !== undefined) set('combine', JSON.stringify(changes.combine));
  if (changes.forMinutes !== undefined) set('for_minutes', changes.forMinutes || null);
  if (changes.clearAfter !== undefined) set('clear_after', changes.clearAfter || null);
  if (changes.policy !== undefined) {
    const [kind, quorum] = policyColumns(changes.policy);
    set('probe_policy', kind);
    set('probe_quorum', quorum);
  }
  if (changes.probes !== undefined) set('probes', changes.probes ? JSON.stringify(changes.probes) : null);

  if (fields.length > 0) {
    const changed = await run(`UPDATE alerts SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
    if (changed === 0) return null;
  } else if (!(await getAlert(id))) {
    return null;
  }

  // `scope` replaces everywhere it applies; `targetIds` alone, only the monitors ticked.
  if (changes.scope !== undefined || changes.targetIds !== undefined) {
    await writeScope(id, { monitors: changes.targetIds, scope: changes.scope });
  }

  // A count of readings towards a condition says nothing about a different
  // condition, duration or policy, and a re-enabled alert must not resume
  // part-way through a breach it was not watching.
  const ruleChanged =
    changes.metric !== undefined || changes.threshold !== undefined || changes.consecutiveProbes !== undefined ||
    changes.conditions !== undefined || changes.combine !== undefined || changes.forMinutes !== undefined ||
    changes.clearAfter !== undefined || changes.policy !== undefined || changes.probes !== undefined;
  if (ruleChanged || changes.enabled !== undefined) {
    await run('UPDATE alert_targets SET streak = 0 WHERE alert_id = ?', [id]);
    await run('UPDATE alert_probe_states SET streak = 0, memory = NULL WHERE alert_id = ?', [id]);
  }

  return getAlert(id);
}

export async function deleteAlert(id: string): Promise<boolean> {
  // Removed explicitly as well as by the cascade, as measurements are.
  await run('DELETE FROM alert_probe_states WHERE alert_id = ?', [id]);
  await run('DELETE FROM alert_targets WHERE alert_id = ?', [id]);
  await run('DELETE FROM alert_scope WHERE alert_id = ?', [id]);
  await run('DELETE FROM alert_events WHERE alert_id = ?', [id]);
  return (await run('DELETE FROM alerts WHERE id = ?', [id])) > 0;
}

// ─── Judging a probe ────────────────────────────────────────────────────────

export { isBreaching, nextRuleState, observedValue } from './rules';

async function persistRuleState(
  rule: Pick<AlertRule, 'id' | 'targetId'>,
  next: { streak: number; state: AlertRule['state'] },
  transition: 'firing' | 'resolved' | null,
  at: number
): Promise<void> {
  const fields = ['streak = ?', 'state = ?'];
  const values: (string | number)[] = [next.streak, next.state];

  if (transition === 'firing') {
    fields.push('last_fired_at = ?');
    values.push(at);
  } else if (transition === 'resolved') {
    fields.push('last_resolved_at = ?');
    values.push(at);
  }

  await run(`UPDATE alert_targets SET ${fields.join(', ')} WHERE alert_id = ? AND target_id = ?`, [
    ...values,
    rule.id,
    rule.targetId,
  ]);
}

interface ProbeStateRow {
  alert_id: string;
  probe: string;
  in_breach: number;
  streak: number;
  memory: string | null;
}

interface ScopeRow {
  alert_id: string;
  kind: AlertScopeEntry['kind'];
  ref: string;
}

function stateOfProbe(row: ProbeStateRow | undefined): ProbeRuleState {
  if (!row) return { ...FRESH_PROBE_STATE };
  let memory: Partial<ProbeRuleState> = {};
  try {
    memory = row.memory ? (JSON.parse(row.memory) as Partial<ProbeRuleState>) : {};
  } catch {
    memory = {};
  }
  return {
    inBreach: row.in_breach === 1,
    streak: row.streak,
    since: memory.since ?? null,
    at: memory.at ?? null,
    held: memory.held ?? [],
    recent: memory.recent ?? [],
  };
}

/** What an alert's condition says in words: "Latency above 200ms". */
function describeConditionOf(condition: AlertCondition): string {
  return describeCondition(condition);
}

/** A value in words, with its unit. */
function worded(metric: AlertMetric, value: number | null): string | null {
  if (value === null) return null;
  if (metric === 'unreachable') return value === 1 ? 'not responding' : 'responding';
  return `${value}${ALERT_METRIC_LABELS[metric].unit}`;
}

/**
 * Evaluate every enabled alert that covers a target against one reading from
 * one probe. Returns the transitions that occurred; notification is the
 * caller's job.
 *
 * Each probe that measures the target keeps its own state against the alert,
 * so two probes' readings never run one streak between them: a probe goes in
 * breach after its own run of readings that hold the conditions, and out of it
 * after its own run that do not. The monitor fires when its probes meet the
 * alert's policy and resolves when they cannot (see judgeMonitor). For a
 * monitor measured from one probe, with one condition, that is exactly what it
 * was before alerts had more to them.
 */
export async function evaluateAlerts(
  target: Pick<Target, 'id' | 'name' | 'host' | 'group'> & { probedFrom?: string; interval?: number },
  result: ProbeResult
): Promise<AlertEvent[]> {
  const events: AlertEvent[] = [];
  const alertRows = (await all<AlertRow>('SELECT * FROM alerts WHERE enabled = 1')).map(settingsFromRow);
  if (alertRows.length === 0) return events;

  const [scopeRows, ticks, probeRows, agentRows, stateRows] = await Promise.all([
    all<ScopeRow>('SELECT alert_id, kind, ref FROM alert_scope'),
    all<AlertTargetRow>('SELECT * FROM alert_targets WHERE target_id = ?', [target.id]),
    all<{ probe: string; last_probe_at: number }>('SELECT probe, last_probe_at FROM target_probes WHERE target_id = ? AND removed_at IS NULL ORDER BY position', [target.id]),
    all<{ id: string; state: ProbeAgentState }>('SELECT id, state FROM probe_agents'),
    all<ProbeStateRow>('SELECT alert_id, probe, in_breach, streak, memory FROM alert_probe_states WHERE target_id = ?', [target.id]),
  ]);

  const probes = probeRows.length > 0 ? probeRows.map(row => row.probe) : [result.probe ?? LOCAL_PROBE];
  const lastAt = new Map(probeRows.map(row => [row.probe, row.last_probe_at]));
  const agentDown = new Map(agentRows.map(row => [row.id, isProbeAgentDown(row.state)]));

  const now = Date.now();
  const probe = result.probe ?? LOCAL_PROBE;
  const intervalMs = Math.max(1, (target.interval ?? 300) * 1000);
  const names = await probeNames(probes);

  for (const alert of alertRows) {
    const scope: AlertScopeEntry[] = scopeRows.filter(row => row.alert_id === alert.id);
    // Ticked monitors are monitor entries, whether or not the scope table has them yet.
    if (ticks.some(tick => tick.alert_id === alert.id)) scope.push({ kind: 'monitor', ref: target.id });
    const covered = coveredProbes(scope, alert.probes, target, probes);
    if (!covered.includes(probe)) continue;

    const tick = ticks.find(each => each.alert_id === alert.id);
    if (!tick) await run('INSERT OR IGNORE INTO alert_targets (alert_id, target_id) VALUES (?, ?)', [alert.id, target.id]);
    const was: AlertTargetState['state'] = tick?.state ?? 'ok';

    // This probe's reading, against the conditions.
    const mine = stateRows.find(row => row.alert_id === alert.id && row.probe === probe);
    const conditions = conditionsOf(alert);
    // A probe new to an alert that is already firing, with nothing else holding
    // it open, joins as in breach: the alert is not announced as resolved
    // because the probe that raised it was replaced.
    const othersInBreach = stateRows.filter(row => row.alert_id === alert.id && row.probe !== probe && row.in_breach === 1 && covered.includes(row.probe));
    const inheriting = !mine && was === 'firing' && othersInBreach.length === 0;
    const before = { ...stateOfProbe(mine), inBreach: mine ? mine.in_breach === 1 : inheriting };
    const step = stepProbe(
      {
        conditions,
        combine: alert.combine ?? 'any',
        readings: alert.consecutiveProbes,
        minutes: alert.forMinutes,
        clearAfter: alert.clearAfter,
      },
      before,
      result,
      now,
      intervalMs
    );

    await run(
      `INSERT INTO alert_probe_states (alert_id, target_id, probe, in_breach, streak, memory) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(alert_id, target_id, probe) DO UPDATE SET in_breach = excluded.in_breach, streak = excluded.streak, memory = excluded.memory`,
      [
        alert.id,
        target.id,
        probe,
        step.state.inBreach ? 1 : 0,
        step.state.streak,
        JSON.stringify({ since: step.state.since, at: step.state.at, held: step.state.held, recent: step.state.recent }),
      ]
    );

    // The monitor's probes, put to the policy.
    const standing: ProbeStanding[] = covered.map(id => {
      const inBreach = id === probe ? step.state.inBreach : stateRows.some(row => row.alert_id === alert.id && row.probe === id && row.in_breach === 1);
      const last = lastAt.get(id) ?? 0;
      const silent = id !== probe && (!!agentDown.get(id) || (last > 0 && now - last > intervalMs * 2));
      return { probe: id, inBreach, silent };
    });
    const policy = policyOf(alert);
    const verdict = judgeMonitor(policy, was, standing);
    // The target's own streak is what an older image reads: with one probe it is that probe's.
    const targetStreak = covered.length <= 1 ? step.state.streak : 0;

    if (verdict.transition || verdict.next !== was || targetStreak !== (tick?.streak ?? 0)) {
      await persistRuleState({ id: alert.id, targetId: target.id }, { streak: targetStreak, state: verdict.next }, verdict.transition, now);
    }
    if (!verdict.transition) continue;

    const inBreach = standing.filter(each => each.inBreach).map(each => each.probe);
    const verdicts: ProbeVerdict[] = standing.map(each => ({ probe: each.probe, name: names.get(each.probe) ?? each.probe, breaching: each.inBreach, silent: each.silent }));
    const results: ConditionResult[] = step.outcomes.map(outcome => ({
      label: describeConditionOf(outcome.condition),
      observed: worded(outcome.condition.metric, outcome.observed),
      held: outcome.held,
    }));
    const policyText = `${describePolicy(policy, verdict.total)}: ${verdict.breaching} in breach`;
    // The condition that headlines the message: the one that held, or the first.
    const lead = step.outcomes.find(outcome => outcome.held) ?? step.outcomes[0];

    await recordAlertEvent({
      alertId: alert.id,
      targetId: target.id,
      at: now,
      transition: verdict.transition,
      conditions: results,
      probes: verdicts,
      reason: policyText,
    }).catch(error => console.error('[Alerts] Could not record the event:', error));

    events.push({
      rule: { ...alert, ...stateFromRow({ alert_id: alert.id, target_id: target.id, state: verdict.next, streak: targetStreak, last_fired_at: null, last_resolved_at: null }), id: alert.id, enabled: true, createdAt: alert.createdAt, state: verdict.next, streak: targetStreak },
      targetName: target.name,
      targetHost: target.host,
      targetGroup: target.group || undefined,
      ...(target.probedFrom ? { probedFrom: target.probedFrom } : {}),
      probe,
      breaching: inBreach,
      probeCount: Math.max(covered.length, 1),
      transition: verdict.transition,
      metric: lead.condition.metric,
      observed: lead.observed,
      threshold: lead.condition.threshold,
      at: new Date(now),
      conditions: results,
      probeVerdicts: verdicts,
      policyText,
    });
  }

  return events;
}

// ─── Tracing the route ──────────────────────────────────────────────────────

/** An alert that has just fired, and is set to trace the route when it does. */
export function asksForTrace(event: Pick<AlertEvent, 'transition' | 'metric' | 'rule'>): boolean {
  return event.transition === 'firing' && event.rule.traceOnFire && TRACEABLE_ALERT_METRICS.includes(event.metric);
}

/**
 * Whether the alerts that just fired on a target call for its route to be
 * traced, given when a trace was last taken on an alert for it.
 *
 * One trace answers for every alert that fired on the same probe. The pause
 * runs from the last trace taken on any alert for the target, since it is the
 * same path whichever alert noticed, and is the shortest that the alerts
 * asking for a trace want. A link that keeps dropping out fires and resolves
 * over and over, and each trace through a dead path is a minute and a half of
 * probes; the first trace of a spell of trouble is the one that shows where.
 */
export function shouldTraceOnAlert(
  events: Pick<AlertEvent, 'transition' | 'metric' | 'rule'>[],
  lastAlertTraceAt: Date | null,
  now = Date.now()
): boolean {
  const asking = events.filter(asksForTrace);
  if (asking.length === 0) return false;
  if (!lastAlertTraceAt) return true;

  const pauseMs = Math.min(...asking.map(event => event.rule.traceCooldownMinutes)) * 60_000;
  return now - lastAlertTraceAt.getTime() >= pauseMs;
}

// ─── Telling someone ────────────────────────────────────────────────────────

export type { DeliveryResult };

/** Send an alert transition to each of its notification URLs and say how that went. */
export async function deliverAlert(event: AlertEvent, options: { test?: boolean } = {}): Promise<DeliveryResult> {
  const urls = event.rule.notifyUrls;
  if (urls.length === 0) return { ok: false, detail: 'This alert is not sent anywhere' };

  try {
    return await sendNotification(urls.map(withEmbeds), notificationFor(event, options));
  } catch (error) {
    return { ok: false, detail: `Could not run Apprise: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Tell the notification URLs of every enabled alert that asked, once each, that
 * a probe agent has gone offline or is back. Failures are logged and swallowed,
 * as an alert's are.
 */
export async function dispatchProbeAgentChange(name: string, change: { kind: 'offline'; reason: string } | { kind: 'online' }): Promise<void> {
  const rows = await all<{ notify_urls: string | null }>('SELECT notify_urls FROM alerts WHERE enabled = 1 AND probe_agent_offline = 1');
  const urls = [...new Set(rows.flatMap(row => parseUrls(row.notify_urls)))];
  if (urls.length === 0) return;
  try {
    const result = await sendNotification(urls.map(withEmbeds), probeAgentNotification(name, change));
    if (!result.ok) console.error(`[ProbeAgents] Could not send the ${change.kind} notice for ${name}: ${result.detail}`);
  } catch (error) {
    console.error(`[ProbeAgents] Could not send the ${change.kind} notice for ${name}:`, error);
  }
}

/**
 * Deliver an alert transition from the prober.
 *
 * Failures are logged and swallowed: a service that is down must not take the
 * prober with it or delay the next probe.
 */
export async function dispatchAlert(event: AlertEvent): Promise<void> {
  if (event.rule.notifyUrls.length === 0) return;

  const result = await deliverAlert(event);
  if (!result.ok) console.error(`[Alerts] Delivery failed for ${event.targetName}: ${result.detail}`);
}

/**
 * Send an alert's notification URLs a sample of what they would be sent for
 * real, so that a mistyped one is found now rather than during an outage.
 */
export async function sendTestAlert(alert: Alert, target?: Pick<Target, 'id' | 'name' | 'host' | 'group'>): Promise<DeliveryResult> {
  const sample: Record<AlertMetric, number> = {
    packetLoss: Math.max(alert.threshold + 20, 25),
    latency: alert.threshold + 150,
    jitter: alert.threshold + 30,
    unreachable: 1,
    certExpiry: Math.max(0, alert.threshold - 5),
  };

  return deliverAlert(
    {
      rule: {
        ...alert,
        targetId: target?.id ?? 'test',
        state: 'firing',
        streak: 0,
      },
      targetName: target?.name ?? 'Example monitor',
      targetHost: target?.host ?? 'example.com',
      targetGroup: target?.group || undefined,
      transition: 'firing',
      metric: alert.metric,
      observed: sample[alert.metric],
      threshold: alert.threshold,
      at: new Date(),
      // An alert with more to it than one threshold is sampled with the detail a real one carries.
      ...(conditionsOf(alert).length > 1 || policyOf(alert).kind !== 'any'
        ? {
            conditions: conditionsOf(alert).map(condition => ({
              label: describeConditionOf(condition),
              observed: worded(condition.metric, sample[condition.metric]),
              held: true,
            })),
            probeVerdicts: [
              { probe: 'a', name: 'Home', breaching: true, silent: false },
              { probe: 'b', name: 'Office', breaching: true, silent: false },
              { probe: 'c', name: 'VPS', breaching: false, silent: false },
            ],
            policyText: `${describePolicy(policyOf(alert), 3)}: 2 in breach`,
            probeCount: 3,
            breaching: ['a', 'b'],
          }
        : {}),
    },
    { test: true }
  );
}
