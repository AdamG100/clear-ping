import { cleanOldTraceroutes, ensureTracerouteSchema } from './traceroute';
import { getDatabase, withBusyRetry } from './database';
import { getAlert } from './alerts';
import { sendNotification } from './apprise';
import { groupWithAncestors, isWithinGroup, normalizeGroupPath } from './group-path';
import { getScheduler } from './scheduler';
import { getJsonSetting, setJsonSetting } from './security/settings-store';
import type { AlertNotification } from './alert-delivery';

/**
 * Maintenance: clearing out what no longer belongs, and checking that what
 * ClearPing keeps itself on is in order.
 *
 * Deleting a target takes its history, alert ticks and traces with it through
 * the database's own cascades, and deleting an alert or a group does the same
 * for what hangs off them. Those cascades only work while foreign keys are on,
 * and databases have been through times when they were not (a migration turns
 * them off while it rebuilds a table; an older ClearPing never turned them
 * on), a copy restored from a backup, or a process killed half way through a
 * delete. What is left behind is rows that point at nothing: they are never
 * shown, never removed, and slow the queries that have to step over them.
 *
 * It runs by hand from Settings, and on a schedule. Each step stands alone: one
 * that fails is reported and the rest still run.
 */

export type MaintenanceFrequency = 'daily' | 'weekly' | 'monthly';
/** Whether a run's report is sent through the chosen alert only when something was wrong, or after every run. */
export type MaintenanceNotify = 'problems' | 'always';

export interface MaintenanceSettings {
  enabled: boolean;
  frequency: MaintenanceFrequency;
  /** The hour of the day it starts, 0 to 23, by the clock of the machine ClearPing runs on. */
  hour: number;
  /** The alert whose notification destinations are sent the report. Null: shown here only. */
  alertId: string | null;
  notify: MaintenanceNotify;
  /**
   * Rewrite the database file to give back the space deleted rows leave in it.
   * Off by default: while it runs nothing can write to the database, so
   * probes wait, and it needs room for a second copy.
   */
  reclaimSpace: boolean;
  /** When these settings were last changed: a schedule counts from there until it has run once. */
  updatedAt: number;
}

export const DEFAULT_MAINTENANCE: MaintenanceSettings = {
  enabled: false,
  frequency: 'weekly',
  hour: 3,
  alertId: null,
  notify: 'problems',
  reclaimSpace: false,
  updatedAt: 0,
};

export type StepStatus = 'ok' | 'fixed' | 'problem' | 'skipped';

export interface MaintenanceStep {
  id: string;
  label: string;
  status: StepStatus;
  /** What was found and done, in words fit for the person running it. */
  detail: string;
  /** Rows taken away by this step. */
  removed: number;
}

export interface MaintenanceReport {
  startedAt: number;
  finishedAt: number;
  trigger: 'manual' | 'schedule';
  /** No step reported a problem. Things fixed along the way are not problems. */
  ok: boolean;
  steps: MaintenanceStep[];
  removed: number;
  /** How sending the report through the chosen alert went; absent where it was not sent. */
  notified?: { ok: boolean; detail?: string };
}

const SETTINGS_KEY = 'maintenance.settings';
const HISTORY_KEY = 'maintenance.history';
const KEEP_RUNS = 10;
/** Rows deleted in one statement. Small enough that probes can write in between. */
const CHUNK = 5000;

// ─── Settings ───────────────────────────────────────────────────────────────

export async function getMaintenanceSettings(): Promise<MaintenanceSettings> {
  const stored = await getJsonSetting<Partial<MaintenanceSettings>>(SETTINGS_KEY);
  return { ...DEFAULT_MAINTENANCE, ...(stored ?? {}) };
}

/** Checked field by field: whatever is not valid is refused, not quietly changed. */
export function parseMaintenanceSettings(input: unknown): { ok: true; settings: Omit<MaintenanceSettings, 'updatedAt'> } | { ok: false; error: string } {
  const body = (input ?? {}) as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') return { ok: false, error: 'Say whether the schedule is on' };
  if (body.frequency !== 'daily' && body.frequency !== 'weekly' && body.frequency !== 'monthly') {
    return { ok: false, error: 'The schedule is daily, weekly or monthly' };
  }
  if (!Number.isInteger(body.hour) || (body.hour as number) < 0 || (body.hour as number) > 23) {
    return { ok: false, error: 'The hour is a whole number from 0 to 23' };
  }
  if (body.alertId !== null && (typeof body.alertId !== 'string' || !body.alertId)) {
    return { ok: false, error: 'Choose an alert, or none' };
  }
  if (body.notify !== 'problems' && body.notify !== 'always') return { ok: false, error: 'Choose when the report is sent' };
  if (typeof body.reclaimSpace !== 'boolean') return { ok: false, error: 'Say whether to reclaim space' };

  return {
    ok: true,
    settings: {
      enabled: body.enabled,
      frequency: body.frequency,
      hour: body.hour as number,
      alertId: body.alertId as string | null,
      notify: body.notify,
      reclaimSpace: body.reclaimSpace,
    },
  };
}

export async function saveMaintenanceSettings(settings: Omit<MaintenanceSettings, 'updatedAt'>): Promise<MaintenanceSettings> {
  const saved = { ...settings, updatedAt: Date.now() };
  await setJsonSetting(SETTINGS_KEY, saved);
  return saved;
}

export async function getMaintenanceHistory(): Promise<MaintenanceReport[]> {
  const stored = await getJsonSetting<MaintenanceReport[]>(HISTORY_KEY);
  return Array.isArray(stored) ? stored : [];
}

// ─── When it is due ─────────────────────────────────────────────────────────

const PERIOD_DAYS: Record<MaintenanceFrequency, number> = { daily: 1, weekly: 7, monthly: 30 };

/**
 * The next time the schedule starts a run, counting from `from`: a run, or
 * the moment the schedule was saved. Always on the hour chosen. A schedule
 * that has not run yet starts at the next such hour, whatever its period, so
 * that turning on a weekly one is not followed by a week of nothing.
 */
export function nextRunAfter(from: number, settings: Pick<MaintenanceSettings, 'frequency' | 'hour'>, firstRun = false): number {
  const days = firstRun ? 1 : PERIOD_DAYS[settings.frequency];
  const at = new Date(from);
  at.setHours(settings.hour, 0, 0, 0);
  while (at.getTime() <= from) at.setDate(at.getDate() + days);
  return at.getTime();
}

/** When the schedule will next run, or null while it is off. */
export async function nextScheduledRun(): Promise<number | null> {
  const settings = await getMaintenanceSettings();
  if (!settings.enabled) return null;
  const last = (await getMaintenanceHistory())[0];
  return last ? nextRunAfter(last.startedAt, settings) : nextRunAfter(settings.updatedAt || Date.now(), settings, true);
}

// ─── The steps ──────────────────────────────────────────────────────────────

type Db = Awaited<ReturnType<typeof getDatabase>>;

const run = (db: Db, sql: string, params: unknown[] = []) =>
  withBusyRetry(
    () =>
      new Promise<number>((resolve, reject) => {
        db.run(sql, params, function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      })
  );

const all = <T>(db: Db, sql: string, params: unknown[] = []) =>
  new Promise<T[]>((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
  });

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Let whatever is waiting for the database's one writer have it. */
const yieldToWriters = () => new Promise<void>(resolve => setImmediate(resolve));

/** Delete in chunks until nothing matches. `select` yields the rowids to take, and is given `CHUNK`. */
async function deleteInChunks(db: Db, table: string, select: string, params: unknown[]): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await run(db, `DELETE FROM ${table} WHERE rowid IN (${select} LIMIT ${CHUNK})`, params);
    total += removed;
    if (removed === 0) return total;
    await yieldToWriters();
  }
}

/**
 * The target ids a table holds rows for that no target has. A table of
 * millions of rows is asked once per target, through its index, and not
 * scanned: each step of the recursion jumps to the next id.
 */
async function orphanTargetIds(db: Db, table: 'measurements' | 'traceroutes'): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `WITH RECURSIVE ids(id) AS (
       SELECT MIN(target_id) FROM ${table}
       UNION ALL
       SELECT (SELECT MIN(target_id) FROM ${table} WHERE target_id > ids.id) FROM ids WHERE ids.id IS NOT NULL
     )
     SELECT id FROM ids WHERE id IS NOT NULL AND id NOT IN (SELECT id FROM targets)`
  );
  return rows.map(row => row.id);
}

async function removeOrphans(db: Db, table: 'measurements' | 'traceroutes'): Promise<number> {
  let removed = 0;
  for (const id of await orphanTargetIds(db, table)) {
    removed += await deleteInChunks(db, table, `SELECT rowid FROM ${table} WHERE target_id = ?`, [id]);
  }
  return removed;
}

interface StepContext {
  db: Db;
  settings: MaintenanceSettings;
}

interface Step {
  id: string;
  label: string;
  work: (context: StepContext) => Promise<Omit<MaintenanceStep, 'id' | 'label'>>;
}

const STEPS: Step[] = [
  {
    id: 'integrity',
    label: 'Check the database file',
    work: async ({ db }) => {
      const rows = await all<Record<string, string>>(db, 'PRAGMA quick_check');
      const messages = rows.map(row => Object.values(row)[0]);
      if (messages.length === 1 && messages[0] === 'ok') {
        return { status: 'ok', detail: 'No damage found.', removed: 0 };
      }
      // Nothing here can repair a file; it can only say so, while there is
      // still a backup that predates it.
      return {
        status: 'problem',
        detail: `SQLite reports damage: ${messages.slice(0, 3).join('; ')}. Restore from a backup if probes or the dashboard start failing.`,
        removed: 0,
      };
    },
  },
  {
    id: 'measurements',
    label: 'History of targets that no longer exist',
    work: async ({ db }) => {
      const removed = await removeOrphans(db, 'measurements');
      return removed === 0
        ? { status: 'ok', detail: 'None left behind.', removed }
        : { status: 'fixed', detail: `Removed ${plural(removed, 'measurement')} belonging to deleted targets.`, removed };
    },
  },
  {
    id: 'traceroutes',
    label: 'Saved routes of targets that no longer exist',
    work: async ({ db }) => {
      const removed = await removeOrphans(db, 'traceroutes');
      return removed === 0
        ? { status: 'ok', detail: 'None left behind.', removed }
        : { status: 'fixed', detail: `Removed ${plural(removed, 'saved route')} belonging to deleted targets.`, removed };
    },
  },
  {
    id: 'alerts',
    label: 'Alert ticks for targets or alerts that no longer exist',
    work: async ({ db }) => {
      const removed = await run(
        db,
        `DELETE FROM alert_targets
         WHERE target_id NOT IN (SELECT id FROM targets) OR alert_id NOT IN (SELECT id FROM alerts)`
      );
      return removed === 0
        ? { status: 'ok', detail: 'Every tick points at an alert and a target.', removed }
        : { status: 'fixed', detail: `Removed ${plural(removed, 'tick')} that pointed at nothing.`, removed };
    },
  },
  {
    id: 'groups',
    label: 'Groups and their saved order',
    work: async ({ db }) => {
      const inUse = (await all<{ group_name: string }>(db, `SELECT DISTINCT group_name FROM targets WHERE group_name IS NOT NULL AND group_name != ''`))
        .map(row => normalizeGroupPath(row.group_name))
        .filter(Boolean);
      const known = new Set((await all<{ group_name: string }>(db, 'SELECT group_name FROM target_groups')).map(row => row.group_name));

      // A group a target is in has to be a group that exists, with each group
      // above it, or the sidebar has a target with no place to show.
      let added = 0;
      for (const group of inUse) {
        for (const path of groupWithAncestors(group)) {
          if (known.has(path)) continue;
          await run(db, 'INSERT OR IGNORE INTO target_groups (group_name) VALUES (?)', [path]);
          known.add(path);
          added++;
        }
      }

      // A saved position for a group that is gone and has nothing in it.
      let removed = 0;
      for (const { group_name: name } of await all<{ group_name: string }>(db, 'SELECT group_name FROM group_orders')) {
        if (known.has(name) || inUse.some(group => isWithinGroup(group, name))) continue;
        removed += await run(db, 'DELETE FROM group_orders WHERE group_name = ?', [name]);
      }

      if (added === 0 && removed === 0) return { status: 'ok', detail: 'Every group is in order.', removed: 0 };
      const parts = [];
      if (added) parts.push(`restored ${plural(added, 'missing group')}`);
      if (removed) parts.push(`removed ${plural(removed, 'saved position')} for groups that are gone`);
      return { status: 'fixed', detail: `${parts.join(' and ')}.`.replace(/^./, c => c.toUpperCase()), removed };
    },
  },
  {
    id: 'clock',
    label: 'Targets marked as probed in the future',
    work: async ({ db }) => {
      // A clock that was wrong, then corrected, leaves a last-probe time that
      // is still to come: the target is not probed until it arrives.
      const fixed = await run(db, 'UPDATE targets SET last_probe_at = 0 WHERE last_probe_at > ?', [Date.now() + 5 * 60 * 1000]);
      return fixed === 0
        ? { status: 'ok', detail: 'Every target is due when it should be.', removed: 0 }
        : { status: 'fixed', detail: `${plural(fixed, 'target')} had a last probe time in the future and would not have been probed. They are due now.`, removed: 0 };
    },
  },
  {
    id: 'retention',
    label: 'Measurements and routes past their retention',
    work: async ({ db }) => {
      const days = Number(process.env.CLEARPING_RETENTION_DAYS ?? 90);
      if (!Number.isFinite(days) || days <= 0) {
        return { status: 'skipped', detail: 'Retention is off (CLEARPING_RETENTION_DAYS is 0), so everything is kept.', removed: 0 };
      }
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const measurements = await deleteInChunks(db, 'measurements', 'SELECT rowid FROM measurements WHERE timestamp < ?', [cutoff]);
      const routes = await cleanOldTraceroutes(days);
      const removed = measurements + routes;
      return removed === 0
        ? { status: 'ok', detail: `Nothing is older than ${plural(days, 'day')}.`, removed }
        : {
            status: 'fixed',
            detail: `Removed ${plural(measurements, 'measurement')} and ${plural(routes, 'saved route')} older than ${plural(days, 'day')}.`,
            removed,
          };
    },
  },
  {
    id: 'database',
    label: 'Database upkeep',
    work: async ({ db, settings }) => {
      // The write-ahead log grows until it is folded back in, and a busy
      // database may never get the quiet moment that does it unprompted.
      await all(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
      // Refreshes the statistics the query planner chooses indexes by, where
      // what is in the tables has changed enough to matter.
      await run(db, 'PRAGMA optimize');

      const [{ page_count: pages }] = await all<{ page_count: number }>(db, 'PRAGMA page_count');
      const [{ freelist_count: free }] = await all<{ freelist_count: number }>(db, 'PRAGMA freelist_count');
      const [{ page_size: pageSize }] = await all<{ page_size: number }>(db, 'PRAGMA page_size');
      const reclaimable = free * pageSize;
      const share = pages > 0 ? free / pages : 0;
      const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

      if (!settings.reclaimSpace) {
        return {
          status: 'ok',
          detail:
            share > 0.25 && reclaimable > 50 * 1024 * 1024
              ? `Checkpointed and optimised. ${megabytes(reclaimable)} of the file is empty space that could be given back: turn on "Reclaim disk space" to do it.`
              : 'Checkpointed and optimised.',
          removed: 0,
        };
      }
      // Not worth rewriting the whole file for a little.
      if (share < 0.2 || reclaimable < 20 * 1024 * 1024) {
        return { status: 'ok', detail: 'Checkpointed and optimised. Little empty space, so the file was left as it is.', removed: 0 };
      }
      await run(db, 'VACUUM');
      return { status: 'fixed', detail: `Checkpointed, optimised and rewrote the file, giving back ${megabytes(reclaimable)}.`, removed: 0 };
    },
  },
  {
    id: 'scheduler',
    label: 'Probe scheduler',
    work: async () => {
      const scheduler = getScheduler();
      if (!scheduler.getStatus().isRunning) {
        return { status: 'skipped', detail: 'Probing is done by a separate prober here; its list refreshes itself.', removed: 0 };
      }
      // So what it is probing is what is in the database, whatever changed it.
      await scheduler.reloadTargets();
      const { targetCount } = scheduler.getStatus();
      return { status: 'ok', detail: `Reloaded: ${plural(targetCount, 'target')} being probed.`, removed: 0 };
    },
  },
];

// ─── Running it ─────────────────────────────────────────────────────────────

interface Progress {
  step: string;
  done: number;
  total: number;
}

/** Held on globalThis: route handlers are bundled apart, and a module-local flag would not be shared. */
const STATE_KEY = Symbol.for('clearping.maintenance');
type State = { running: Progress | null; timer?: NodeJS.Timeout };
const state = (): State => {
  const store = globalThis as typeof globalThis & { [STATE_KEY]?: State };
  return (store[STATE_KEY] ??= { running: null });
};

/** What a run in progress has got to, or null when none is. */
export function maintenanceProgress(): Progress | null {
  return state().running;
}

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function notificationFor(report: MaintenanceReport): AlertNotification {
  const lines = report.steps
    .filter(step => step.status === 'problem' || step.status === 'fixed')
    .map(step => `<li><b>${html(step.label)}:</b> ${html(step.detail)}</li>`);
  return {
    title: report.ok ? 'ClearPing maintenance finished' : 'ClearPing maintenance found a problem',
    body:
      `<p>${report.ok ? 'Maintenance ran without problems.' : 'Maintenance ran and something needs a look.'} ` +
      `${plural(report.removed, 'row')} removed.</p>` +
      (lines.length ? `<ul>${lines.join('')}</ul>` : ''),
    type: report.ok ? 'success' : 'failure',
  };
}

/** Send the report where the chosen alert sends its own. */
async function notify(settings: MaintenanceSettings, report: MaintenanceReport): Promise<MaintenanceReport['notified']> {
  if (!settings.alertId) return undefined;
  if (settings.notify === 'problems' && report.ok) return undefined;

  const alert = await getAlert(settings.alertId);
  if (!alert) return { ok: false, detail: 'The alert chosen for the report no longer exists.' };
  if (alert.notifyUrls.length === 0) return { ok: false, detail: 'The alert chosen for the report has nowhere to send to.' };

  const result = await sendNotification(alert.notifyUrls, notificationFor(report));
  return { ok: result.ok, detail: result.detail };
}

/**
 * Run every step. Returns null, and does nothing, where a run is already
 * under way: two at once would be doing the same deletes against each other.
 */
export async function runMaintenance(trigger: MaintenanceReport['trigger']): Promise<MaintenanceReport | null> {
  const current = state();
  if (current.running) return null;
  current.running = { step: STEPS[0].label, done: 0, total: STEPS.length };

  const startedAt = Date.now();
  const steps: MaintenanceStep[] = [];

  try {
    const db = await getDatabase();
    await ensureTracerouteSchema();
    const settings = await getMaintenanceSettings();

    for (const [index, step] of STEPS.entries()) {
      current.running = { step: step.label, done: index, total: STEPS.length };
      try {
        steps.push({ id: step.id, label: step.label, ...(await step.work({ db, settings })) });
      } catch (error) {
        // One step failing is that step's problem; the others still run.
        console.error(`[Maintenance] ${step.label} failed:`, error);
        steps.push({
          id: step.id,
          label: step.label,
          status: 'problem',
          detail: `Could not be done: ${error instanceof Error ? error.message : String(error)}`,
          removed: 0,
        });
      }
    }

    const report: MaintenanceReport = {
      startedAt,
      finishedAt: Date.now(),
      trigger,
      ok: steps.every(step => step.status !== 'problem'),
      steps,
      removed: steps.reduce((sum, step) => sum + step.removed, 0),
    };

    try {
      const notified = await notify(settings, report);
      if (notified) report.notified = notified;
    } catch (error) {
      report.notified = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    await setJsonSetting(HISTORY_KEY, [report, ...(await getMaintenanceHistory())].slice(0, KEEP_RUNS));
    console.log(
      `[Maintenance] ${trigger} run done: ${report.ok ? 'no problems' : 'problems found'}, ${plural(report.removed, 'row')} removed`
    );
    return report;
  } finally {
    current.running = null;
  }
}

// ─── The schedule ───────────────────────────────────────────────────────────

const CHECK_EVERY_MS = 60 * 1000;

async function runIfDue(): Promise<void> {
  if (state().running) return;
  const due = await nextScheduledRun();
  if (due !== null && Date.now() >= due) await runMaintenance('schedule');
}

/** Start checking, once a minute, whether the schedule is due. Safe to call more than once. */
export function startMaintenanceSchedule(): void {
  const current = state();
  if (current.timer) return;
  current.timer = setInterval(() => {
    runIfDue().catch(error => console.error('[Maintenance] Scheduled run failed:', error));
  }, CHECK_EVERY_MS);
  // Not what keeps the process alive.
  current.timer.unref?.();
  console.log('[Maintenance] Schedule check started');
}
