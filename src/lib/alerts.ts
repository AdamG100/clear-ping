import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import { notificationFor, parseNotifyUrls } from './alert-delivery';
import { sendNotification, type DeliveryResult } from './apprise';
import type { Alert, AlertEvent, AlertMetric, AlertRule, AlertSettings, AlertTargetState, ProbeResult, Target } from '@/types/probe';
import { ALERT_METRIC_LABELS } from '@/types/probe';

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
  enabled: number;
  created_at: number;
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

function settingsFromRow(row: AlertRow): AlertSettings & { id: string; enabled: boolean; createdAt: Date } {
  return {
    id: row.id,
    name: row.name || undefined,
    metric: row.metric,
    threshold: row.threshold,
    consecutiveProbes: row.consecutive_probes,
    notifyUrls: parseUrls(row.notify_urls),
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
  const [alerts, states] = await Promise.all([
    all<AlertRow>('SELECT * FROM alerts ORDER BY created_at ASC'),
    all<AlertTargetRow>('SELECT * FROM alert_targets'),
  ]);

  const byAlert = new Map<string, AlertTargetState[]>();
  for (const row of states) {
    const list = byAlert.get(row.alert_id) ?? [];
    list.push(stateFromRow(row));
    byAlert.set(row.alert_id, list);
  }

  return alerts.map(row => ({ ...settingsFromRow(row), targets: byAlert.get(row.id) ?? [] }));
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

export type AlertInput = AlertSettings & { targetIds: string[]; enabled?: boolean };

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

  if (given('metric') || !partial) {
    if (!ALERT_METRICS.includes(body.metric as AlertMetric)) {
      return fail(`Invalid metric. Expected one of: ${ALERT_METRICS.join(', ')}`);
    }
    input.metric = body.metric as AlertMetric;
  }

  if (given('threshold') || !partial) {
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

  if (given('targetIds') || !partial) {
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
      (id, name, metric, threshold, consecutive_probes, notify_urls, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name ?? '',
      input.metric,
      input.threshold,
      input.consecutiveProbes,
      JSON.stringify(input.notifyUrls),
      input.enabled === false ? 0 : 1,
      Date.now(),
    ]
  );

  for (const targetId of await existingTargets(input.targetIds)) {
    await run('INSERT OR IGNORE INTO alert_targets (alert_id, target_id) VALUES (?, ?)', [id, targetId]);
  }

  return (await getAlert(id))!;
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
  if (changes.enabled !== undefined) set('enabled', changes.enabled ? 1 : 0);

  if (fields.length > 0) {
    const changed = await run(`UPDATE alerts SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
    if (changed === 0) return null;
  } else if (!(await getAlert(id))) {
    return null;
  }

  if (changes.targetIds !== undefined) {
    const wanted = await existingTargets(changes.targetIds);
    const ticked = (await all<{ target_id: string }>('SELECT target_id FROM alert_targets WHERE alert_id = ?', [id]))
      .map(row => row.target_id);

    // Targets that stay ticked keep their state: unticking one must not make
    // the others forget that they are firing.
    for (const targetId of ticked.filter(targetId => !wanted.includes(targetId))) {
      await run('DELETE FROM alert_targets WHERE alert_id = ? AND target_id = ?', [id, targetId]);
    }
    for (const targetId of wanted.filter(targetId => !ticked.includes(targetId))) {
      await run('INSERT OR IGNORE INTO alert_targets (alert_id, target_id) VALUES (?, ?)', [id, targetId]);
    }
  }

  // A count of probes towards a condition says nothing about a different
  // condition, and a re-enabled alert must not resume part-way through a
  // breach it was not watching.
  const conditionChanged =
    changes.metric !== undefined || changes.threshold !== undefined || changes.consecutiveProbes !== undefined;
  if (conditionChanged || changes.enabled !== undefined) {
    await run('UPDATE alert_targets SET streak = 0 WHERE alert_id = ?', [id]);
  }

  return getAlert(id);
}

export async function deleteAlert(id: string): Promise<boolean> {
  // Removed explicitly as well as by the cascade, as measurements are.
  await run('DELETE FROM alert_targets WHERE alert_id = ?', [id]);
  return (await run('DELETE FROM alerts WHERE id = ?', [id])) > 0;
}

// ─── Judging a probe ────────────────────────────────────────────────────────

/** The value a rule watches, or null when the probe produced no reading for it. */
export function observedValue(rule: Pick<AlertRule, 'metric'>, result: ProbeResult): number | null {
  switch (rule.metric) {
    case 'packetLoss':
      return result.packetLoss ?? null;
    case 'latency':
      return result.latency;
    case 'jitter':
      return result.jitter ?? null;
    case 'unreachable':
      return result.success ? 0 : 1;
    case 'certExpiry': {
      // Days of validity left, as of the probe that saw the certificate. Null
      // for anything that is not HTTPS, and for a probe that never got as far
      // as a handshake.
      const expiresAt = result.details?.certExpiresAt;
      if (expiresAt === undefined) return null;
      return Math.round(((expiresAt - result.timestamp.getTime()) / DAY_MS) * 10) / 10;
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether this probe breaches the rule. */
export function isBreaching(
  rule: Pick<AlertRule, 'metric' | 'threshold' | 'state'>,
  result: ProbeResult
): boolean {
  const value = observedValue(rule, result);
  if (rule.metric === 'unreachable') return value === 1;

  // A probe with no reading for this metric is not evidence either way, so it
  // holds the current state rather than advancing a streak. Treating "unknown"
  // as "fine" would silently resolve a real alert, and treating it as a breach
  // would fire a latency rule on a host that is simply down.
  if (value === null) return rule.state === 'firing';

  return ALERT_METRIC_LABELS[rule.metric].comparison === 'below'
    ? value < rule.threshold
    : value > rule.threshold;
}

/**
 * Advance a rule's state machine by one probe.
 *
 * Pure, so the hysteresis can be tested without a database. A rule fires only
 * after `consecutiveProbes` breaching probes in a row, and resolves only after
 * the same number of clean ones — that is what stops a single blip paging
 * somebody at 3am.
 */
export function nextRuleState(
  rule: Pick<AlertRule, 'state' | 'streak' | 'consecutiveProbes'>,
  breaching: boolean
): { streak: number; state: AlertRule['state']; transition: 'firing' | 'resolved' | null } {
  // A probe advances the streak when it argues for changing the current state.
  const advancing = breaching === (rule.state === 'ok');
  const streak = advancing ? rule.streak + 1 : 0;

  if (advancing && streak >= rule.consecutiveProbes) {
    return {
      streak: 0,
      state: rule.state === 'ok' ? 'firing' : 'ok',
      transition: rule.state === 'ok' ? 'firing' : 'resolved',
    };
  }

  return { streak, state: rule.state, transition: null };
}

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

/**
 * Evaluate every enabled alert a target is ticked for against one probe result.
 * Returns the transitions that occurred; notification is the caller's job.
 */
export async function evaluateAlerts(
  target: Pick<Target, 'id' | 'name' | 'host' | 'group'>,
  result: ProbeResult
): Promise<AlertEvent[]> {
  const rules = (await getAlertRules(target.id)).filter(r => r.enabled);
  const events: AlertEvent[] = [];
  const at = Date.now();

  for (const rule of rules) {
    const breaching = isBreaching(rule, result);
    const next = nextRuleState(rule, breaching);

    await persistRuleState(rule, next, next.transition, at);

    if (next.transition) {
      events.push({
        rule: { ...rule, state: next.state, streak: next.streak },
        targetName: target.name,
        targetHost: target.host,
        targetGroup: target.group || undefined,
        transition: next.transition,
        metric: rule.metric,
        observed: observedValue(rule, result),
        threshold: rule.threshold,
        at: new Date(at),
      });
    }
  }

  return events;
}

// ─── Telling someone ────────────────────────────────────────────────────────

export type { DeliveryResult };

/** Send an alert transition to each of its notification URLs and say how that went. */
export async function deliverAlert(event: AlertEvent, options: { test?: boolean } = {}): Promise<DeliveryResult> {
  const urls = event.rule.notifyUrls;
  if (urls.length === 0) return { ok: false, detail: 'This alert is not sent anywhere' };

  try {
    return await sendNotification(urls, notificationFor(event, options));
  } catch (error) {
    return { ok: false, detail: `Could not run Apprise: ${error instanceof Error ? error.message : String(error)}` };
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
      targetName: target?.name ?? 'Example target',
      targetHost: target?.host ?? 'example.com',
      targetGroup: target?.group || undefined,
      transition: 'firing',
      metric: alert.metric,
      observed: sample[alert.metric],
      threshold: alert.threshold,
      at: new Date(),
    },
    { test: true }
  );
}
