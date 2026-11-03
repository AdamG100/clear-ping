import type sqlite3 from 'sqlite3';
import { PROBE_TAGS_KEY } from './migrations';
import { stepDone, stepProgress, stepStarted } from './upgrade-progress';

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

  // How many there are to do, for the page shown meanwhile: one seek per monitor.
  let total = 0;
  for (const id of ids) {
    const [{ count }] = await all<{ count: number }>(
      database,
      "SELECT COUNT(*) AS count FROM measurements WHERE target_id = ? AND probe = 'local' AND timestamp > ? AND timestamp <= ?",
      [id, state.targets[id].cursor, state.migratedAt]
    );
    total += count;
  }
  stepStarted('tag', `Filing the readings of ${ids.length} monitor${ids.length === 1 ? '' : 's'} under the probe agent that took them`, total);

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
        stepProgress('tag', tagged);
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
  stepDone('tag', `${tagged.toLocaleString('en')} readings`);
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

  // First, so that walking each monitor's history to tag it is a seek.
  await ensureProbeTimeIndex(database);
  await tagReadings(database, state);

  stepStarted('family-index', 'Building the index of the newest reading from each probe');
  // The newest reading of each probe of each monitor, and of each of its
  // families, is one lookup through this. It replaces the index on family
  // alone, which could not tell one probe's readings from another's.
  await run(
    database,
    `CREATE INDEX IF NOT EXISTS idx_measurements_target_probe_family_timestamp
     ON measurements(target_id, probe, family, timestamp DESC)`
  );
  await run(database, 'DROP INDEX IF EXISTS idx_measurements_target_family_timestamp');
  stepDone('family-index');

  state.done = true;
  await writeState(database, state);
}

/**
 * The readings of one probe of a monitor, in time order: what nearly every
 * chart, sparkline and statistic reads. The index on family as well cannot
 * serve "the newest readings of this probe" or "this probe since then", since
 * family sits between the probe and the time; a query planned through it reads
 * and sorts a monitor's whole history, for every row it returns.
 */
async function ensureProbeTimeIndex(database: Database): Promise<void> {
  const [existing] = await all<{ name: string }>(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_measurements_target_probe_timestamp'"
  );
  if (existing) return;
  console.log('Database: building the index of readings by probe and time');
  stepStarted('probe-index', 'Building the index of readings by probe and time');
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_measurements_target_probe_timestamp ON measurements(target_id, probe, timestamp DESC)');
  stepDone('probe-index');
}

/** Raised when the planner's statistics need making again after indexes change. */
const PLANNER_STATS_KEY = 'upgrade.planner-stats';
const PLANNER_STATS_VERSION = '2';

/**
 * Make sure the indexes readings are looked up by exist, and that SQLite's
 * statistics describe them.
 *
 * An install that has run for a while has statistics (the weekly maintenance
 * runs PRAGMA optimize) that were made before readings had a probe. With those,
 * SQLite chose the index on family for the sidebar's sparklines, which reads a
 * monitor's whole history again for every reading it returns: the dashboard
 * never finished loading. A new database has no statistics and planned it
 * well, which is why starting afresh worked. Cheap at every start after the
 * first: one lookup and one setting.
 */
export async function settleProbeIndexes(database: Database): Promise<void> {
  const state = await readState(database);
  // Still tagging (a start that was stopped part-way): finishProbeUpgrade does this next time.
  if (state && !state.done) return;
  await ensureProbeTimeIndex(database);

  const [stats] = await all<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', [PLANNER_STATS_KEY]);
  if (stats?.value === PLANNER_STATS_VERSION) return;
  const started = Date.now();
  stepStarted('statistics', "Refreshing the database's query statistics");
  await run(database, 'ANALYZE');
  stepDone('statistics');
  await run(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [PLANNER_STATS_KEY, PLANNER_STATS_VERSION]);
  console.log(`Database: refreshed the query planner's statistics in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
