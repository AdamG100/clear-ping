import type sqlite3 from 'sqlite3';
import { PROBE_TAGS_KEY } from './migrations';

type Database = sqlite3.Database;

/**
 * Finishing the upgrade to probes per monitor: tag the readings and routes
 * that probe agents took before readings said which probe took them, then
 * build the index that finds the newest reading of each probe.
 *
 * Migration 14 only records what is to do. The work is here because it can be
 * large (every reading of every monitor on a probe agent) and must not be one
 * transaction: a single UPDATE over a long history puts every page of it in
 * the write-ahead log at once, which can fill a small disk and fail the start.
 * It goes a few thousand rows at a time, each batch its own transaction, walking
 * each monitor's history in order, and keeps where it has got to so a start
 * that was killed carries on rather than beginning again.
 *
 * Only readings up to the moment of the migration are tagged: those after it
 * were stored with their probe, and some of them are genuinely local readings
 * of a monitor that has since been given the local probe.
 */

const BATCH_ROWS = 5000;

interface TagState {
  /** When the migration ran: readings after it were stored tagged. */
  migratedAt: number;
  /** Monitors still to tag, with their probe agent and how far through their history. */
  targets: Record<string, { agent: string; cursor: number }>;
  done: boolean;
}

function run(database: Database, sql: string, params: unknown[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this.changes);
    });
  });
}

function all<T>(database: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => (error ? reject(error) : resolve((rows ?? []) as T[])));
  });
}

async function readState(database: Database): Promise<TagState | null> {
  const [row] = await all<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', [PROBE_TAGS_KEY]);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as TagState;
  } catch {
    return null;
  }
}

async function writeState(database: Database, state: TagState): Promise<void> {
  await run(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [PROBE_TAGS_KEY, JSON.stringify(state)]);
}

/** Let whatever is waiting for the write lock have it. */
const yieldLock = () => new Promise<void>(resolve => setImmediate(resolve));

async function tagReadings(database: Database, state: TagState): Promise<void> {
  const ids = Object.keys(state.targets);
  if (ids.length === 0) return;
  console.log(`Database: tagging the readings of ${ids.length} monitor${ids.length === 1 ? '' : 's'} with the probe agent that took them`);

  let tagged = 0;
  for (const id of ids) {
    const work = state.targets[id];
    for (;;) {
      // Walked by time rather than searched for, so each batch starts where
      // the last one ended instead of reading back over the rows already done.
      const batch = await all<{ timestamp: number }>(
        database,
        `SELECT timestamp FROM measurements
         WHERE target_id = ? AND timestamp > ? AND timestamp <= ? AND probe = 'local'
         ORDER BY timestamp ASC LIMIT ?`,
        [id, work.cursor, state.migratedAt, BATCH_ROWS]
      );
      if (batch.length === 0) break;
      const last = batch[batch.length - 1].timestamp;

      await run(database, 'BEGIN IMMEDIATE');
      try {
        tagged += await run(
          database,
          `UPDATE measurements SET probe = ?
           WHERE target_id = ? AND timestamp > ? AND timestamp <= ? AND probe = 'local'`,
          [work.agent, id, work.cursor, last]
        );
        work.cursor = last;
        await writeState(database, state);
        await run(database, 'COMMIT');
      } catch (error) {
        await run(database, 'ROLLBACK').catch(() => {});
        throw error;
      }
      await yieldLock();
    }

    // Routes are few, so a target's are done in one go.
    const traces = await all<{ name: string }>(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'traceroutes'");
    if (traces.length > 0) {
      await run(database, "UPDATE traceroutes SET probe = ? WHERE target_id = ? AND probe = 'local' AND timestamp <= ?", [work.agent, id, state.migratedAt]);
    }

    delete state.targets[id];
    await writeState(database, state);
  }
  console.log(`Database: tagged ${tagged.toLocaleString('en')} readings with the probe that took them`);
}

/**
 * Make `target_probes` agree with `targets.probe_agent_id` after a start.
 *
 * The column holds each monitor's primary probe, and this keeps it so, but an
 * image from before probes per monitor can be started against the same
 * database (a rollback, or a prober left running beside a newer web app). It
 * makes monitors and changes their probe agent without knowing about the
 * list. Whatever the column says then is what was last chosen, so the list
 * follows it: a monitor with no list gets one, and one whose primary probe
 * differs is measured from the column's probe alone, its others kept as
 * former probes with their readings.
 *
 * Readings that older image took are filed under the local probe, whichever
 * it was measuring from: nothing it wrote says otherwise.
 */
export async function reconcileTargetProbes(database: Database): Promise<void> {
  const now = Date.now();
  const rows = await all<{ id: string; probe_agent_id: string | null; created_at: number; primary_probe: string | null }>(
    database,
    `SELECT t.id, t.probe_agent_id, t.created_at,
            (SELECT probe FROM target_probes p WHERE p.target_id = t.id AND p.removed_at IS NULL ORDER BY position LIMIT 1) AS primary_probe
     FROM targets t`
  );

  for (const row of rows) {
    const wanted = row.probe_agent_id ?? 'local';
    if (row.primary_probe === wanted) continue;

    await run(database, 'BEGIN IMMEDIATE');
    try {
      await run(
        database,
        `UPDATE target_probes SET removed_at = ?, position = position + 1000
         WHERE target_id = ? AND removed_at IS NULL AND probe != ?`,
        [now, row.id, wanted]
      );
      await run(
        database,
        `INSERT INTO target_probes (target_id, probe, position, added_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(target_id, probe) DO UPDATE SET position = 0, removed_at = NULL`,
        [row.id, wanted, row.primary_probe === null ? row.created_at : now]
      );
      await run(database, 'DELETE FROM alert_probe_states WHERE target_id = ? AND probe != ?', [row.id, wanted]);
      await run(database, 'COMMIT');
    } catch (error) {
      await run(database, 'ROLLBACK').catch(() => {});
      throw error;
    }
  }
}

/**
 * Do what migration 14 left to do, once. Cheap to call at every start: it
 * reads one setting and stops when the work is done.
 */
export async function finishProbeUpgrade(database: Database): Promise<void> {
  const state = await readState(database);
  if (!state || state.done) return;

  await tagReadings(database, state);

  // The newest reading of each probe of each monitor, and of each of its
  // families, is one lookup through this. It replaces the index on family
  // alone, which could not tell one probe's readings from another's.
  await run(
    database,
    `CREATE INDEX IF NOT EXISTS idx_measurements_target_probe_family_timestamp
     ON measurements(target_id, probe, family, timestamp DESC)`
  );
  await run(database, 'DROP INDEX IF EXISTS idx_measurements_target_family_timestamp');

  state.done = true;
  await writeState(database, state);
}
