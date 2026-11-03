import type { AlertHistoryEvent, ConditionResult, ProbeVerdict } from '@/types/alert-rules';
import { getDatabase } from '../db/database';

/**
 * An alert's history: each time a monitor started or stopped firing, with the
 * conditions as they stood, each probe's part in it, and why, so that "why did
 * this fire" is answered by what was seen and not guessed at.
 */

interface EventRow {
  id: number;
  alert_id: string;
  target_id: string;
  target_name: string | null;
  at: number;
  transition: 'firing' | 'resolved';
  conditions: string;
  probes: string;
  reason: string;
}

function parse<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function recordAlertEvent(event: {
  alertId: string;
  targetId: string;
  at: number;
  transition: 'firing' | 'resolved';
  conditions: ConditionResult[];
  probes: ProbeVerdict[];
  reason: string;
}): Promise<void> {
  const database = await getDatabase();
  await new Promise<void>((resolve, reject) => {
    database.run(
      'INSERT INTO alert_events (alert_id, target_id, at, transition, conditions, probes, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [event.alertId, event.targetId, event.at, event.transition, JSON.stringify(event.conditions), JSON.stringify(event.probes), event.reason],
      error => (error ? reject(error) : resolve())
    );
  });
}

/** An alert's history, newest first. */
export async function getAlertEvents(alertId: string, limit = 50): Promise<AlertHistoryEvent[]> {
  const database = await getDatabase();
  const rows = await new Promise<EventRow[]>((resolve, reject) => {
    database.all(
      `SELECT e.id, e.alert_id, e.target_id, t.name AS target_name, e.at, e.transition, e.conditions, e.probes, e.reason
       FROM alert_events e LEFT JOIN targets t ON t.id = e.target_id
       WHERE e.alert_id = ? ORDER BY e.at DESC, e.id DESC LIMIT ?`,
      [alertId, Math.min(200, Math.max(1, Math.floor(limit)))],
      (error, found) => (error ? reject(error) : resolve((found ?? []) as EventRow[]))
    );
  });
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    alertId: row.alert_id,
    targetId: row.target_id,
    targetName: row.target_name ?? 'A deleted monitor',
    transition: row.transition,
    conditions: parse<ConditionResult>(row.conditions),
    probes: parse<ProbeVerdict>(row.probes),
    reason: row.reason,
  }));
}

/** Delete history older than the retention window, as readings are. */
export async function cleanOldAlertEvents(daysToKeep: number): Promise<number> {
  const database = await getDatabase();
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  return new Promise<number>((resolve, reject) => {
    database.run('DELETE FROM alert_events WHERE at < ?', [cutoff], function (error) {
      if (error) reject(error);
      else resolve(this.changes);
    });
  });
}
