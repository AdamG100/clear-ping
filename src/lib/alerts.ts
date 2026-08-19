import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import type { AlertEvent, AlertMetric, AlertRule, ProbeResult, Target } from '@/types/probe';

interface AlertRuleRow {
  id: string;
  target_id: string;
  metric: AlertMetric;
  threshold: number;
  consecutive_probes: number;
  webhook_url: string | null;
  enabled: number;
  state: 'ok' | 'firing';
  streak: number;
  last_fired_at: number | null;
  last_resolved_at: number | null;
  created_at: number;
}

function toRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    targetId: row.target_id,
    metric: row.metric,
    threshold: row.threshold,
    consecutiveProbes: row.consecutive_probes,
    webhookUrl: row.webhook_url ?? undefined,
    enabled: row.enabled === 1,
    state: row.state,
    streak: row.streak,
    lastFiredAt: row.last_fired_at ? new Date(row.last_fired_at) : null,
    lastResolvedAt: row.last_resolved_at ? new Date(row.last_resolved_at) : null,
    createdAt: new Date(row.created_at),
  };
}

export async function ensureAlertSchema(): Promise<void> {
  const db = await getDatabase();

  await new Promise<void>((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        metric TEXT NOT NULL CHECK(metric IN ('packetLoss','latency','jitter','unreachable')),
        threshold REAL NOT NULL DEFAULT 0,
        consecutive_probes INTEGER NOT NULL DEFAULT 3,
        webhook_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'ok' CHECK(state IN ('ok','firing')),
        streak INTEGER NOT NULL DEFAULT 0,
        last_fired_at INTEGER,
        last_resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
      )`,
      err => (err ? reject(err) : resolve())
    );
  });

  await new Promise<void>((resolve, reject) => {
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_alert_rules_target ON alert_rules(target_id)',
      err => (err ? reject(err) : resolve())
    );
  });
}

export async function getAlertRules(targetId?: string): Promise<AlertRule[]> {
  const db = await getDatabase();
  const sql = targetId
    ? 'SELECT * FROM alert_rules WHERE target_id = ? ORDER BY created_at ASC'
    : 'SELECT * FROM alert_rules ORDER BY created_at ASC';

  return new Promise((resolve, reject) => {
    db.all(sql, targetId ? [targetId] : [], (err, rows) => {
      if (err) reject(err);
      else resolve((rows as AlertRuleRow[]).map(toRule));
    });
  });
}

export async function createAlertRule(input: {
  targetId: string;
  metric: AlertMetric;
  threshold: number;
  consecutiveProbes: number;
  webhookUrl?: string;
}): Promise<AlertRule> {
  const db = await getDatabase();
  const id = randomUUID();
  const now = Date.now();

  await new Promise<void>((resolve, reject) => {
    db.run(
      `INSERT INTO alert_rules
        (id, target_id, metric, threshold, consecutive_probes, webhook_url, enabled, state, streak, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'ok', 0, ?)`,
      [id, input.targetId, input.metric, input.threshold, input.consecutiveProbes, input.webhookUrl ?? null, now],
      err => (err ? reject(err) : resolve())
    );
  });

  const rules = await getAlertRules(input.targetId);
  return rules.find(r => r.id === id)!;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM alert_rules WHERE id = ?', [id], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

export async function setAlertRuleEnabled(id: string, enabled: boolean): Promise<boolean> {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.run(
      // Resetting the streak stops a re-enabled rule resuming part-way through
      // a breach it was not watching.
      'UPDATE alert_rules SET enabled = ?, streak = 0 WHERE id = ?',
      [enabled ? 1 : 0, id],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

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
  }
}

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

  return value > rule.threshold;
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
  id: string,
  next: { streak: number; state: AlertRule['state'] },
  transition: 'firing' | 'resolved' | null,
  at: number
): Promise<void> {
  const db = await getDatabase();
  const fields = ['streak = ?', 'state = ?'];
  const values: (string | number)[] = [next.streak, next.state];

  if (transition === 'firing') {
    fields.push('last_fired_at = ?');
    values.push(at);
  } else if (transition === 'resolved') {
    fields.push('last_resolved_at = ?');
    values.push(at);
  }

  values.push(id);

  await new Promise<void>((resolve, reject) => {
    db.run(`UPDATE alert_rules SET ${fields.join(', ')} WHERE id = ?`, values, err =>
      err ? reject(err) : resolve()
    );
  });
}

/**
 * Evaluate every enabled rule for a target against one probe result.
 * Returns the transitions that occurred; notification is the caller's job.
 */
export async function evaluateAlerts(
  target: Pick<Target, 'id' | 'name' | 'host'>,
  result: ProbeResult
): Promise<AlertEvent[]> {
  const rules = (await getAlertRules(target.id)).filter(r => r.enabled);
  const events: AlertEvent[] = [];
  const at = Date.now();

  for (const rule of rules) {
    const breaching = isBreaching(rule, result);
    const next = nextRuleState(rule, breaching);

    await persistRuleState(rule.id, next, next.transition, at);

    if (next.transition) {
      events.push({
        rule: { ...rule, state: next.state, streak: next.streak },
        targetName: target.name,
        targetHost: target.host,
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

/**
 * POST an alert transition to its webhook.
 *
 * Failures are logged and swallowed: a webhook that is down must not take the
 * prober with it or delay the next probe.
 */
export async function dispatchAlert(event: AlertEvent): Promise<void> {
  const url = event.rule.webhookUrl;
  if (!url) return;

  const summary =
    event.transition === 'firing'
      ? `${event.targetName} (${event.targetHost}): ${event.metric} is ${event.observed ?? 'unknown'}, past threshold ${event.threshold}`
      : `${event.targetName} (${event.targetHost}): ${event.metric} recovered`;

  const payload = {
    status: event.transition,
    target: { name: event.targetName, host: event.targetHost },
    metric: event.metric,
    observed: event.observed,
    threshold: event.threshold,
    at: event.at.toISOString(),
    text: summary,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[Alerts] Webhook returned ${response.status} for ${event.targetName}`);
    }
  } catch (error) {
    console.error('[Alerts] Webhook delivery failed:', error);
  } finally {
    clearTimeout(timer);
  }
}
