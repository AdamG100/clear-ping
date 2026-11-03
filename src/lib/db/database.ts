import path from 'path';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { Target, TargetProbe, ProbeMeasurement, TargetStatistics, GroupOrder, LatestMeasurement, FamilyReading, ProbeReading, BucketedMeasurement, SparklinePoint, IpVersion, ProbeType, AddressFamily, DnsResolverReading, ProbeDetails } from '@/types/probe';
import { addressFamilyFor, FAMILY_LABEL, isDualStack } from '../probes/host';
import { median, percentile } from '../probes/metrics';
import { lossBandIndex, PACKET_LOSS_BANDS } from '../charts/packet-loss-colors';
import { groupWithAncestors, isWithinGroup, normalizeGroupPath, parentGroup, rebaseGroupPath } from '../targets/group-path';
import { runMigrations } from './migrations';
import { finishProbeUpgrade, reconcileTargetProbes, settleProbeIndexes } from './probe-tags';
import { databaseFailed, databaseOpeningAgain, databaseReady, upgradeProgress, type UpgradeRecord } from './upgrade-progress';
import { LOCAL_PROBE, type ProbeId } from '@/types/probe-agent';
import { agentIdOf, probeIdsOf, probeOf } from '../targets/probes';

// Use sqlite3.Database type
type Database = sqlite3.Database;

// Database row types
interface TargetRow {
  id: string;
  name: string;
  host: string;
  probe_type: ProbeType;
  interval: number;
  status: 'active' | 'paused' | 'error';
  group_name?: string;
  sort_order: number;
  ip_version: IpVersion | null;
  resolved_address: string | null;
  probe_config: string | null;
  probe_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Read a JSON column. A value that will not parse is treated as absent: one
 * damaged row must not make every target unreadable.
 */
function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Write a JSON column, storing nothing at all for an empty object. */
function toJson(value: object | undefined | null): string | null {
  if (!value) return null;
  const json = JSON.stringify(value);
  return json === '{}' ? null : json;
}

function runSql(database: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    database.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function allSql<T>(database: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    database.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
  });
}

/** The CREATE TABLE statement a table was made with, or null if it does not exist. */
export async function tableDefinition(database: Database, table: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    database.get(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [table],
      (err, row) => {
        if (err) reject(err);
        else resolve((row as { sql: string } | undefined)?.sql ?? null);
      }
    );
  });
}

/**
 * Replace a table's definition while keeping its rows.
 *
 * SQLite cannot alter a CHECK constraint, so loosening one means building the
 * table again under a temporary name, copying the rows across and swapping it
 * in. Foreign keys are switched off for the duration, which is what stops
 * dropping the old table from cascading into every row that references it: with
 * them on, rebuilding `targets` would delete the entire measurement history.
 * The switch cannot be flipped inside a transaction, so it brackets one.
 */
export async function rebuildTable(
  database: Database,
  table: string,
  createSql: (name: string) => string,
  columns: string[]
): Promise<void> {
  const replacement = `${table}_rebuild`;
  const list = columns.join(', ');

  await runSql(database, 'PRAGMA foreign_keys = OFF');
  try {
    await runSql(database, 'BEGIN IMMEDIATE');
    try {
      // Left behind only if a previous attempt was killed part-way.
      await runSql(database, `DROP TABLE IF EXISTS ${replacement}`);
      await runSql(database, createSql(replacement));
      await runSql(database, `INSERT INTO ${replacement} (${list}) SELECT ${list} FROM ${table}`);
      await runSql(database, `DROP TABLE ${table}`);
      await runSql(database, `ALTER TABLE ${replacement} RENAME TO ${table}`);
      await runSql(database, 'COMMIT');
    } catch (error) {
      await runSql(database, 'ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    await runSql(database, 'PRAGMA foreign_keys = ON');
  }
}

/**
 * File measurements that have no recorded family under the family their
 * target is probed over.
 *
 * Every reading taken before the family was recorded is one of these. Left
 * unfiled, a target's whole history would drop off its chart the day it was
 * switched to both families, because each family's line is drawn from the
 * readings filed under it. An address is its own family and a pinned name
 * says its own; a name left to the resolver is filed under the family it
 * last resolved to, which is the one it will have been measured over unless
 * the resolver's preference changed part-way through its history.
 */
async function backfillMeasurementFamilies(database: Database): Promise<void> {
  // Once only: readings are stored with their family now, and with no index
  // that holds `family` first, looking for the ones without it reads the
  // whole table at every start.
  const [done] = await allSql<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', [FAMILIES_BACKFILLED]);
  if (done) return;

  const targets = await new Promise<Pick<TargetRow, 'id' | 'host' | 'ip_version' | 'resolved_address'>[]>(
    (resolve, reject) => {
      database.all(
        `SELECT id, host, ip_version, resolved_address FROM targets
         WHERE id IN (SELECT DISTINCT target_id FROM measurements WHERE family IS NULL)`,
        [],
        (err, rows) => (err ? reject(err) : resolve((rows ?? []) as TargetRow[]))
      );
    }
  );

  for (const target of targets) {
    const pinned = target.ip_version === 'ipv4' || target.ip_version === 'ipv6' ? target.ip_version : 'auto';
    const family =
      addressFamilyFor(target.host, pinned) ??
      (target.resolved_address ? addressFamilyFor(target.resolved_address) : null);
    if (!family) continue;

    await runSql(database, 'UPDATE measurements SET family = ? WHERE target_id = ? AND family IS NULL', [
      family,
      target.id,
    ]);
  }

  await runSql(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [FAMILIES_BACKFILLED, 'true']);
}

/** Set once every reading that predates the family column has been filed under one. */
const FAMILIES_BACKFILLED = 'upgrade.families-backfilled';

const TARGET_COLUMNS = [
  'id', 'name', 'host', 'probe_type', 'interval', 'status', 'group_name', 'created_at',
  'updated_at', 'last_probe_at', 'sort_order', 'ip_version', 'resolved_address', 'probe_config',
];

/**
 * `probe_type` is deliberately unconstrained here. It used to carry
 * CHECK(probe_type IN ('ping', 'dns')), which made adding a probe a table
 * rebuild; the set of valid probes is enforced where targets are created and
 * edited instead.
 */
const targetsTableSql = (name: string) => `
  CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    probe_type TEXT NOT NULL,
    interval INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'error')),
    group_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_probe_at INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    ip_version TEXT NOT NULL DEFAULT 'auto',
    resolved_address TEXT,
    probe_config TEXT
  )`;

interface TargetProbeRow {
  target_id: string;
  probe: string;
  position: number;
  resolved: string | null;
  removed_at: number | null;
}

function probesFromRows(rows: TargetProbeRow[]): Map<string, TargetProbe[]> {
  const byTarget = new Map<string, TargetProbe[]>();
  for (const row of rows) {
    const resolved = parseJson<Record<string, string>>(row.resolved);
    const probe: TargetProbe = {
      id: row.probe,
      position: row.position,
      ...(resolved ? { resolved: { ...(resolved['4'] ? { 4: resolved['4'] } : {}), ...(resolved['6'] ? { 6: resolved['6'] } : {}) } } : {}),
      ...(row.removed_at !== null ? { former: true } : {}),
    };
    const list = byTarget.get(row.target_id) ?? [];
    list.push(probe);
    byTarget.set(row.target_id, list);
  }
  // Active ones first, in the order they were chosen; then the former ones.
  for (const list of byTarget.values()) {
    list.sort((a, b) => Number(!!a.former) - Number(!!b.former) || a.position - b.position);
  }
  return byTarget;
}

/** Every probe of the given monitors (or of all), active and former. */
async function loadProbes(database: Database, targetId?: string): Promise<Map<string, TargetProbe[]>> {
  const rows = await allSql<TargetProbeRow>(
    database,
    `SELECT target_id, probe, position, resolved, removed_at FROM target_probes ${targetId ? 'WHERE target_id = ?' : ''}`,
    targetId ? [targetId] : []
  );
  return probesFromRows(rows);
}

function targetFromRow(r: TargetRow, probes?: TargetProbe[]): Target {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    probeType: r.probe_type,
    interval: r.interval,
    status: r.status,
    group: r.group_name,
    sortOrder: r.sort_order ?? 0,
    ipVersion: r.ip_version ?? 'auto',
    resolvedAddress: r.resolved_address ?? undefined,
    probeConfig: parseJson(r.probe_config),
    probeAgentId: r.probe_agent_id ?? null,
    // A monitor with no row of its own (made by an older image) is measured
    // from its one probe agent, which `probesOf` reads from the field above.
    ...(probes && probes.length > 0 ? { probes } : {}),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

interface GroupOrderRow {
  group_name: string;
  sort_order: number;
}

interface MeasurementRow {
  id: string;
  target_id: string;
  timestamp: number;
  latency: number | null;
  packet_loss: number;
  jitter: number | null;
  success: number;
  error_message: string | null;
  family: number | null;
  probe?: string;
}

/** A stored family, or undefined for a row written before it was recorded. */
function familyFromRow(value: number | null): AddressFamily | undefined {
  return value === 4 || value === 6 ? value : undefined;
}

/**
 * Which of a monitor's readings a query covers: one address family, one probe,
 * or (left out) every one. A monitor that is not split by either has nothing
 * to leave out.
 */
export interface ReadingScope {
  family?: AddressFamily;
  probe?: ProbeId;
}

/** Restrict a measurements query to a scope. */
function readingFilter(scope: ReadingScope = {}): { clause: string; params: (number | string)[] } {
  const clauses: string[] = [];
  const params: (number | string)[] = [];
  if (scope.probe) {
    clauses.push('AND probe = ?');
    params.push(scope.probe);
  }
  if (scope.family) {
    clauses.push('AND family = ?');
    params.push(scope.family);
  }
  return { clause: clauses.join(' '), params };
}

interface StatisticsRow {
  total: number;
  avg_latency: number | null;
  min_latency: number | null;
  max_latency: number | null;
  avg_jitter: number | null;
  min_jitter: number | null;
  max_jitter: number | null;
  avg_loss: number | null;
  min_loss: number | null;
  max_loss: number | null;
  failures: number;
  last_probe: number | null;
}

/**
 * The one connection, and its opening, for the whole process. Held on
 * globalThis because Next.js bundles route handlers into separate module
 * graphs: a module-local handle meant each of them opened the file again and
 * ran every startup step on its own connection, in parallel with the rest.
 */
const CONNECTION_KEY = Symbol.for('clearping.database');
type ConnectionStore = { db: Database | null; opening: Promise<Database> | null; ready?: boolean };
const connection: ConnectionStore = ((globalThis as typeof globalThis & { [CONNECTION_KEY]?: ConnectionStore })[CONNECTION_KEY] ??= {
  db: null,
  opening: null,
});

/** The last few upgrades, for Settings, Maintenance: when, from which version to which, and what was done. */
const UPGRADE_HISTORY_KEY = 'upgrade.history';
const UPGRADE_HISTORY_KEPT = 20;

async function recordUpgrade(database: Database): Promise<void> {
  const progress = upgradeProgress();
  if (progress.steps.length === 0) return;
  const [row] = await allSql<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', [UPGRADE_HISTORY_KEY]);
  let history: UpgradeRecord[] = [];
  try {
    history = row ? (JSON.parse(row.value) as UpgradeRecord[]) : [];
  } catch {
    history = [];
  }
  history.unshift({
    at: Date.now(),
    from: progress.from,
    to: progress.to,
    tookMs: Date.now() - progress.startedAt,
    steps: progress.steps.map(step => ({ label: step.label, ...(step.detail ? { detail: step.detail } : {}) })),
  });
  await runSql(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [UPGRADE_HISTORY_KEY, JSON.stringify(history.slice(0, UPGRADE_HISTORY_KEPT))]);
}

/** The upgrades this database has had, newest first. */
export async function getUpgradeHistory(): Promise<UpgradeRecord[]> {
  const database = await getDatabase();
  const [row] = await allSql<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', [UPGRADE_HISTORY_KEY]);
  try {
    return row ? (JSON.parse(row.value) as UpgradeRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Where the database file is. Configurable so the standalone prober (which may
 * run from a different working directory) and the tests can point at their own
 * file; sign-in (security/auth.ts) opens the same file.
 */
export function databasePath(): string {
  return process.env.CLEARPING_DB_PATH
    ? path.resolve(process.env.CLEARPING_DB_PATH)
    // The comment keeps the bundler from reading this as a file the build
    // depends on. Without it a standalone build copies ./data/clearping.db,
    // the live database, into its output.
    : path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'clearping.db');
}

/**
 * A bind mount Docker created as root, while the image runs as uid 1000, is
 * the usual reason a new install cannot open its database. The process cannot
 * change that ownership itself, so the log gives the command that does.
 */
function databasePermissionMessage(dbPath: string): string {
  const uid = process.getuid?.();
  const who = uid === undefined ? '' : ` It runs as uid ${uid}.`;
  const fix = uid === undefined
    ? ''
    : ` For a Docker bind mount, on the host in the directory with the Compose file:\n\n  sudo chown -R ${uid}:${uid} ./data\n\nor use a named volume, as the docker run examples do.`;
  return `Cannot open the database at ${dbPath}: permission denied.${who}${fix}`;
}

/**
 * The database or a file beside it that this process may read but not write,
 * and who owns it: a database restored or copied in by root, say, while the
 * image runs as uid 1000. SQLite opens such a file and only refuses at the
 * first write, which for an upgrade is part-way into it.
 */
function unwritableFile(dbPath: string): { file: string; owner?: number; mode?: number; readOnlyMount: boolean } | null {
  for (const file of [path.dirname(dbPath), dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.accessSync(file, fs.constants.W_OK);
    } catch (error) {
      let owner: number | undefined;
      let mode: number | undefined;
      try {
        const stat = fs.statSync(file);
        owner = stat.uid;
        mode = stat.mode & 0o777;
      } catch {}
      return { file, owner, mode, readOnlyMount: (error as { code?: string }).code === 'EROFS' };
    }
  }
  return null;
}

/** Why the database cannot be written, and the command that fixes it. */
function databaseReadOnlyMessage(dbPath: string, found = unwritableFile(dbPath)): string {
  const uid = process.getuid?.();
  const then = '\n\nthen choose Try again, or restart ClearPing.';
  const onHost = (command: string) => ` On the host, in the directory with the Compose file:\n\n  ${command}${then}`;
  const mode = found?.mode !== undefined ? ` (mode ${found.mode.toString(8).padStart(3, '0')})` : '';

  // Each cause has its own fix: a chown cannot help a file its owner may not write.
  let why: string;
  let fix = '';
  if (!found || found.readOnlyMount) {
    why = 'the file system it is on is mounted read-only';
    fix = ' Check the volume is not mounted with :ro, and that the host can write to the folder (touch ./data/test).' + then.replace('\n\nthen', ' Then');
  } else if (uid !== undefined && found.owner !== undefined && found.owner !== uid) {
    why = `${found.file} belongs to uid ${found.owner} and ClearPing runs as uid ${uid}`;
    fix = onHost(`sudo chown -R ${uid}:${uid} ./data`);
  } else {
    why = `${found.file}${mode} has no permission to write, even for its owner`;
    fix = onHost('sudo chmod -R u+rwX ./data');
  }
  return `The database at ${dbPath} can be read but not changed: ${why}. Nothing was changed.${fix}`;
}

function isReadOnlyError(error: unknown): boolean {
  return (error as { code?: string }).code === 'SQLITE_READONLY';
}

function isDatabasePermissionError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'SQLITE_CANTOPEN';
}

/**
 * Open `dbPath` and report failure through the callback. Without one, sqlite3
 * emits the error on the database object and it becomes an uncaught exception
 * before anything can explain it.
 */
function openSqlite(dbPath: string): Promise<Database> {
  const sqlite = sqlite3.verbose();
  return new Promise((resolve, reject) => {
    try {
      const handle = new sqlite.Database(dbPath, err => {
        if (!err) {
          resolve(handle);
          return;
        }
        // close() never calls back on a handle that failed to open.
        handle.close(() => {});
        reject(err);
      });
    } catch (error) {
      reject(error as Error);
    }
  });
}

/**
 * Initialize the SQLite database and create tables
 */
export async function initDatabase(): Promise<Database> {
  // Open but still being brought up to date is not ready: wait for that.
  if (connection.db && connection.ready) return connection.db;
  
  // Return existing promise if initialization is in progress
  if (connection.opening) return connection.opening;

  const opening = (async () => {
    databaseOpeningAgain();
    const dbPath = databasePath();

    const dataDir = path.dirname(dbPath);
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      connection.db = await openSqlite(dbPath);
    } catch (error) {
      connection.db = null;
      if (!isDatabasePermissionError(error)) throw error;
      const message = databasePermissionMessage(dbPath);
      console.error(`Database: ${message}`);
      throw new Error(message, { cause: error });
    }

    // Said before anything is tried, rather than as SQLITE_READONLY from
    // whichever change happens to write first.
    const unwritable = unwritableFile(dbPath);
    if (unwritable) {
      const message = databaseReadOnlyMessage(dbPath, unwritable);
      console.error(`Database: ${message}`);
      throw new Error(message);
    }

    // Foreign keys are off by default in SQLite, which silently disables the
    // ON DELETE CASCADE below — deleting a target would leave its measurements
    // behind forever.
    //
    // WAL lets the UI read while the prober writes instead of the two blocking
    // each other, and NORMAL synchronous avoids an fsync per probe. The worst
    // case for that trade is losing the last few measurements on an OS crash,
    // which for sampled monitoring data is an acceptable loss.
    for (const pragma of [
      'PRAGMA foreign_keys = ON',
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
      'PRAGMA busy_timeout = 5000',
    ]) {
      await new Promise<void>((resolve, reject) => {
        connection.db!.run(pragma, function (err) {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // Create targets table
    await new Promise<void>((resolve, reject) => {
      connection.db!.run(targetsTableSql('targets').replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'), function(err) {
        if (err) {
          console.error('Database: Error creating targets table:', err);
          reject(err);
        } else {
          console.log('Database: Ensured targets table exists');
          resolve();
        }
      });
    });

    // Create measurements table
    await new Promise<void>((resolve, reject) => {
      connection.db!.run(`
        CREATE TABLE IF NOT EXISTS measurements (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          latency REAL,
          latency_min REAL,
          latency_max REAL,
          latency_p10 REAL,
          latency_p25 REAL,
          latency_p50 REAL,
          latency_p75 REAL,
          latency_p90 REAL,
          packet_loss REAL DEFAULT 0,
          jitter REAL,
          success INTEGER NOT NULL,
          error_message TEXT,
          FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
        )
      `, function(err) {
        if (err) {
          console.error('Database: Error creating measurements table:', err);
          reject(err);
        } else {
          console.log('Database: Ensured measurements table exists');
          resolve();
        }
      });
    });

    // Columns added after the original schema. Existing databases are migrated
    // in place; rows written before a column existed keep NULL, and every read
    // path falls back rather than assuming the value is there.
    for (const column of [
      // What the probe learned beyond its timings, as JSON; see ProbeDetails.
      'details TEXT',
      // 4 or 6: the address family the probe ran over. A target probed over
      // both writes one row of each per round. NULL where it is not known,
      // which includes every row written before the column existed.
      'family INTEGER',
      'jitter REAL',
      'latency_min REAL',
      'latency_max REAL',
      'latency_p10 REAL',
      'latency_p25 REAL',
      'latency_p50 REAL',
      'latency_p75 REAL',
      'latency_p90 REAL',
    ]) {
      await new Promise<void>((resolve, reject) => {
        connection.db!.run(`ALTER TABLE measurements ADD COLUMN ${column}`, function (err) {
          if (err && !err.message.includes('duplicate column name')) {
            console.error(`Database: Error adding column ${column}:`, err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // Create indexes
    await new Promise<void>((resolve, reject) => {
      connection.db!.run(`CREATE INDEX IF NOT EXISTS idx_measurements_target_timestamp 
              ON measurements(target_id, timestamp DESC)`, function(err) {
        if (err) reject(err);
        else resolve();
      });
    });

    // What finds the newest reading of each probe, and each family of it,
    // without reading the history behind it is made once readings are tagged
    // with their probe (see probe-tags.ts), in place of the index on family alone.

    await new Promise<void>((resolve, reject) => {
      connection.db!.run(`CREATE INDEX IF NOT EXISTS idx_measurements_timestamp
              ON measurements(timestamp DESC)`, function(err) {
        if (err) reject(err);
        else resolve();
      });
    });

    // Add sort_order column to targets if missing
    await new Promise<void>((resolve, reject) => {
      connection.db!.run(`ALTER TABLE targets ADD COLUMN sort_order INTEGER DEFAULT 0`, function(err) {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Database: Error adding sort_order column:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Address-family choice for domain targets, and the address the last probe
    // of one resolved to. Targets that predate the columns read as 'auto',
    // which is how they were already being probed.
    for (const column of [
      `ip_version TEXT NOT NULL DEFAULT 'auto'`,
      'resolved_address TEXT',
      // Per-probe settings as JSON; see ProbeConfig.
      'probe_config TEXT',
    ]) {
      await new Promise<void>((resolve, reject) => {
        connection.db!.run(`ALTER TABLE targets ADD COLUMN ${column}`, function (err) {
          if (err && !err.message.includes('duplicate column name')) {
            console.error(`Database: Error adding column ${column}:`, err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // Databases created before TCP and HTTP probes existed only accept 'ping'
    // and 'dns' in probe_type. Every column the rebuild copies exists by now,
    // because the ALTERs above have already run.
    const targetsSql = await tableDefinition(connection.db, 'targets');
    if (targetsSql && /CHECK\s*\(\s*probe_type/i.test(targetsSql)) {
      // A rebuild is transactional, but it is also the one migration here that
      // rewrites existing rows rather than adding to them, so take a snapshot
      // first. VACUUM INTO copies a consistent image, write-ahead log included.
      const backupPath = `${dbPath}.before-probe-types-${Date.now()}.bak`;
      try {
        await runSql(connection.db, 'VACUUM INTO ?', [backupPath]);
        console.log(`Database: Backed up to ${backupPath} before migrating the targets table`);
      } catch (error) {
        console.warn('Database: Could not back up before migrating; continuing:', error);
      }

      await rebuildTable(connection.db, 'targets', targetsTableSql, TARGET_COLUMNS);
      console.log('Database: Migrated targets table to accept new probe types');
    }

    // Create group_orders table
    await new Promise<void>((resolve, reject) => {
      connection.db!.run(`
        CREATE TABLE IF NOT EXISTS group_orders (
          group_name TEXT PRIMARY KEY,
          sort_order INTEGER NOT NULL DEFAULT 0
        )
      `, function(err) {
        if (err) {
          console.error('Database: Error creating group_orders table:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Everything above brings a database of any age up to the shape the
    // numbered migrations start from. Changes made since are in that list.
    await runMigrations(connection.db);

    // After the migrations, which make the settings these keep their place in.
    await backfillMeasurementFamilies(connection.db);
    await reconcileTargetProbes(connection.db);
    await finishProbeUpgrade(connection.db);
    await settleProbeIndexes(connection.db);
    await recordUpgrade(connection.db).catch(error => console.warn('Database: could not keep a record of the upgrade:', error));

    console.log('Database: Tables and indexes created successfully');

    connection.ready = true;
    databaseReady();
    return connection.db!;
  })().catch(error => {
    // Read-only though every file looked writable: a read-only mount.
    if (!isReadOnlyError(error)) throw error;
    const message = databaseReadOnlyMessage(databasePath());
    console.error(`Database: ${message}`);
    throw new Error(message, { cause: error });
  });

  connection.opening = opening;
  // A failed open must not stick, or the next attempt in this process repeats
  // it after the folder has been fixed.
  void opening.catch(error => {
    databaseFailed(error instanceof Error ? error.message : String(error));
    if (connection.opening === opening && !connection.ready) {
      connection.opening = null;
      // Opened but not brought up to date: let it go, and open afresh next time.
      connection.db?.close(() => {});
      connection.db = null;
    }
  });

  return opening;
}

/**
 * Save database to disk (no-op for sqlite3 as it auto-saves)
 */
function saveDatabase() {
  // sqlite3 automatically saves to disk
}

/**
 * Save database to disk (exported for external use)
 */
export function saveDatabaseToDisk(): void {
  saveDatabase();
}

/**
 * Close the database handle.
 *
 * Needed for clean shutdown of the standalone prober, and on Windows the file
 * stays locked until the handle is released, so tests cannot remove their
 * temporary database without it.
 */
export async function closeDatabase(): Promise<void> {
  const handle = connection.db;
  connection.db = null;
  connection.opening = null;
  connection.ready = false;
  if (!handle) return;

  await new Promise<void>((resolve, reject) => {
    handle.close(err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Get database instance
 */
export async function getDatabase(): Promise<Database> {
  if (!connection.db || !connection.ready) {
    return await initDatabase();
  }
  return connection.db;
}

/**
 * Create a new target
 */
export async function createTarget(target: Omit<Target, 'createdAt' | 'updatedAt'>): Promise<Target> {
  const database = await getDatabase();
  const now = Date.now();
  const group = normalizeGroupPath(target.group);

  // A target named into a group nobody has made yet makes it.
  await keepGroup(database, group);

  // The probes it is measured from, primary first; the column an older image
  // reads holds the primary one.
  const probeIds = probeIdsOf(target);
  const primaryAgent = agentIdOf(probeIds[0]);

  await runSql(
    database,
    `INSERT INTO targets (id, name, host, probe_type, interval, status, group_name, sort_order, ip_version, probe_config, probe_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [target.id, target.name, target.host, target.probeType, target.interval, target.status, group, target.sortOrder ?? 0, target.ipVersion ?? 'auto', toJson(target.probeConfig), primaryAgent, now, now]
  );
  for (const [position, probe] of probeIds.entries()) {
    await runSql(
      database,
      'INSERT INTO target_probes (target_id, probe, position, added_at) VALUES (?, ?, ?, ?)',
      [target.id, probe, position, now]
    );
  }
  saveDatabase();
  return {
    ...target,
    group: group || undefined,
    probeAgentId: primaryAgent,
    probes: probeIds.map((id, position) => ({ id, position })),
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Set the probes a monitor is measured from, primary first.
 *
 * One taken off is kept as a former probe, so its readings still show until
 * they age out, and ticking it again picks its history up where it left off.
 * Its alert states go at once: a probe that no longer measures the monitor
 * cannot hold an alert open. If the primary probe changes, the address stored
 * for the monitor described the old one and goes too.
 */
export async function setTargetProbes(targetId: string, probes: ProbeId[]): Promise<boolean> {
  const database = await getDatabase();
  const [row] = await allSql<Pick<TargetRow, 'probe_agent_id'>>(database, 'SELECT probe_agent_id FROM targets WHERE id = ?', [targetId]);
  if (!row || probes.length === 0) return false;

  const now = Date.now();
  const primaryChanged = probeOf(row.probe_agent_id) !== probes[0];
  await runSql(database, 'BEGIN IMMEDIATE');
  try {
    for (const [position, probe] of probes.entries()) {
      await runSql(
        database,
        `INSERT INTO target_probes (target_id, probe, position, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(target_id, probe) DO UPDATE SET position = excluded.position, removed_at = NULL`,
        [targetId, probe, position, now]
      );
    }
    const kept = probes.map(() => '?').join(', ');
    await runSql(
      database,
      `UPDATE target_probes SET removed_at = ?, position = position + 1000
       WHERE target_id = ? AND removed_at IS NULL AND probe NOT IN (${kept})`,
      [now, targetId, ...probes]
    );
    await runSql(database, `DELETE FROM alert_probe_states WHERE target_id = ? AND probe NOT IN (${kept})`, [targetId, ...probes]);
    await runSql(
      database,
      `UPDATE targets SET probe_agent_id = ?, updated_at = ?${primaryChanged ? ', resolved_address = NULL' : ''} WHERE id = ?`,
      [agentIdOf(probes[0]), now, targetId]
    );
    await runSql(database, 'COMMIT');
  } catch (error) {
    await runSql(database, 'ROLLBACK').catch(() => {});
    throw error;
  }
  saveDatabase();
  return true;
}

/**
 * Get all targets
 */
export async function getAllTargets(): Promise<Target[]> {
  const database = await getDatabase();

  const [rows, probes] = await Promise.all([
    allSql<TargetRow>(database, 'SELECT * FROM targets ORDER BY sort_order ASC, name ASC'),
    loadProbes(database),
  ]);
  return rows.map(row => targetFromRow(row, probes.get(row.id)));
}

/**
 * Get a single target by ID
 */
export async function getTargetById(id: string): Promise<Target | null> {
  const database = await getDatabase();

  const [row] = await allSql<TargetRow>(database, 'SELECT * FROM targets WHERE id = ?', [id]);
  if (!row) return null;
  return targetFromRow(row, (await loadProbes(database, id)).get(id));
}

/**
 * Update a target
 */
export async function updateTarget(id: string, updates: Partial<Target>): Promise<boolean> {
  const database = await getDatabase();
  const now = Date.now();

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.host !== undefined) {
    fields.push('host = ?');
    values.push(updates.host);
  }
  if (updates.probeType !== undefined) {
    fields.push('probe_type = ?');
    values.push(updates.probeType);
  }
  if (updates.interval !== undefined) {
    fields.push('interval = ?');
    values.push(updates.interval);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.group !== undefined) {
    fields.push('group_name = ?');
    values.push(normalizeGroupPath(updates.group));
  }
  if (updates.sortOrder !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sortOrder);
  }
  if (updates.ipVersion !== undefined) {
    fields.push('ip_version = ?');
    values.push(updates.ipVersion);
  }
  if (updates.probeConfig !== undefined) {
    fields.push('probe_config = ?');
    values.push(toJson(updates.probeConfig));
  }
  // Where it is measured from: a list, or the one probe agent an older client
  // sends, which then is the whole list. Kept apart from the fields above,
  // since the probes are a table of their own.
  const probeChange =
    updates.probes !== undefined ? probeIdsOf(updates)
    : updates.probeAgentId !== undefined ? [probeOf(updates.probeAgentId)]
    : undefined;

  // The stored address describes what the old host resolved to. Once the host
  // or its address family changes it describes nothing, and showing it until
  // the next probe would label the target with somewhere it no longer points.
  // (Its primary probe changing does the same, which setTargetProbes sees to.)
  if (updates.host !== undefined || updates.ipVersion !== undefined || updates.probeType !== undefined) {
    fields.push('resolved_address = NULL');
  }

  if (fields.length === 0 && !probeChange) return false;

  if (updates.group !== undefined) await keepGroup(database, updates.group);

  let changed = false;
  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    // `this.changes` is 0 when no row matched, which is how callers tell a
    // successful update from an update against a target that doesn't exist.
    changed = await new Promise<boolean>((resolve, reject) => {
      database.run(`UPDATE targets SET ${fields.join(', ')} WHERE id = ?`, values, function(err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      });
    });
  }
  if (probeChange) changed = (await setTargetProbes(id, probeChange)) || changed;
  saveDatabase();
  return changed;
}

/**
 * Delete a target and all its measurements, as `deleteTargets` does: its
 * history a few thousand rows at a time, so a long one does not hold up
 * everything else that writes while it goes.
 */
export async function deleteTarget(id: string): Promise<boolean> {
  return (await deleteTargets([id])) > 0;
}

/**
 * Delete several targets, each with everything recorded for it. Returns how
 * many there were to delete: an id that is not a target's is passed over.
 */
export async function deleteTargets(ids: string[]): Promise<number> {
  const database = await getDatabase();
  const run = (sql: string, params: unknown[]) =>
    withBusyRetry(
      () =>
        new Promise<number>((resolve, reject) => {
          database.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this.changes);
          });
        })
    );

  let deleted = 0;
  for (const id of ids) {
    // The history first, a few thousand rows at a time. Left to the cascade,
    // one statement removes all of it, and a target with months of readings
    // holds the write lock for many seconds: everything else that writes,
    // the prober included, waits out its busy timeout and fails.
    while ((await run(
      'DELETE FROM measurements WHERE rowid IN (SELECT rowid FROM measurements WHERE target_id = ? LIMIT 5000)',
      [id]
    )) > 0) {
      // Let whatever is waiting for the lock have it.
      await new Promise(resolve => setImmediate(resolve));
    }
    deleted += await run('DELETE FROM targets WHERE id = ?', [id]);
  }
  saveDatabase();
  return deleted;
}

/**
 * Run a write again when another writer held the database past the busy
 * timeout. Clearing out a long list of targets takes the write lock for a
 * while, and the prober is writing results at the same time.
 */
export async function withBusyRetry<T>(work: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const busy = (error as { code?: string })?.code === 'SQLITE_BUSY';
      if (!busy || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    }
  }
}

/**
 * Record the address a domain target's latest probe resolved to.
 */
export async function setResolvedAddress(id: string, address: string): Promise<void> {
  const database = await getDatabase();

  return new Promise<void>((resolve, reject) => {
    database.run('UPDATE targets SET resolved_address = ? WHERE id = ?', [address, id], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

const INSERT_MEASUREMENT = `
  INSERT INTO measurements (id, target_id, timestamp, latency, latency_min, latency_max, latency_p10, latency_p25, latency_p50, latency_p75, latency_p90, packet_loss, jitter, success, error_message, details, family, probe)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function measurementParams(measurement: ProbeMeasurement & { packetLoss?: number }) {
  return [
    measurement.id,
    measurement.targetId,
    measurement.timestamp.getTime(),
    measurement.latency,
    measurement.minLatency ?? null,
    measurement.maxLatency ?? null,
    measurement.p10Latency ?? null,
    measurement.p25Latency ?? null,
    measurement.p50Latency ?? null,
    measurement.p75Latency ?? null,
    measurement.p90Latency ?? null,
    measurement.packetLoss ?? 0,
    measurement.jitter,
    measurement.success ? 1 : 0,
    measurement.errorMessage || null,
    toJson(measurement.details),
    measurement.family ?? null,
    measurement.probe ?? LOCAL_PROBE,
  ];
}

export async function storeMeasurement(measurement: ProbeMeasurement & { packetLoss?: number }): Promise<void> {
  const database = await getDatabase();

  await runSql(database, INSERT_MEASUREMENT, measurementParams(measurement));
  saveDatabase();
}

/**
 * Store multiple measurements
 */
export async function storeMeasurements(measurements: ProbeMeasurement[]): Promise<void> {
  const database = await getDatabase();

  await Promise.all(measurements.map(item => runSql(database, INSERT_MEASUREMENT, measurementParams(item))));
  saveDatabase();
}

/**
 * Get measurements for a target within a time range
 */
export async function getMeasurements(
  targetId: string,
  startTime: Date,
  endTime: Date,
  scope: ReadingScope = {}
): Promise<ProbeMeasurement[]> {
  const database = await getDatabase();
  const only = readingFilter(scope);

  return new Promise((resolve, reject) => {
    database.all(`
      SELECT * FROM measurements
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ${only.clause}
      ORDER BY timestamp ASC
    `, [targetId, startTime.getTime(), endTime.getTime(), ...only.params], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!rows || rows.length === 0) {
        resolve([]);
        return;
      }

      const measurements: ProbeMeasurement[] = rows.map((row) => {
        const r = row as MeasurementRow;
        return {
          id: r.id,
          targetId: r.target_id,
          timestamp: new Date(r.timestamp),
          latency: r.latency,
          packetLoss: r.packet_loss,
          jitter: r.jitter,
          success: r.success === 1,
          errorMessage: r.error_message || undefined,
          family: familyFromRow(r.family),
          probe: r.probe ?? LOCAL_PROBE,
        };
      });

      resolve(measurements);
    });
  });
}

/** A probe as the search for incidents reads it, with the family it was taken over. */
export interface StoredReading {
  timestamp: number;
  latency: number | null;
  packetLoss: number;
  success: boolean;
  errorMessage?: string;
  family?: AddressFamily;
}

/**
 * A target's probes over a period, oldest first, with only what says whether
 * each one worked. A month of a target probed every minute is tens of
 * thousands of rows, read here for every target a report covers, so the
 * columns a chart needs and this does not are left where they are.
 */
export async function getProbeReadings(targetId: string, startTime: Date, endTime: Date, scope: ReadingScope = {}): Promise<StoredReading[]> {
  const database = await getDatabase();
  const only = readingFilter(scope);

  const rows = await allSql<Pick<MeasurementRow, 'timestamp' | 'latency' | 'packet_loss' | 'success' | 'error_message' | 'family'>>(
    database,
    `SELECT timestamp, latency, packet_loss, success, error_message, family FROM measurements
     WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ${only.clause}
     ORDER BY timestamp ASC`,
    [targetId, startTime.getTime(), endTime.getTime(), ...only.params]
  );

  return rows.map(row => ({
    timestamp: row.timestamp,
    latency: row.latency,
    packetLoss: row.packet_loss,
    success: row.success === 1,
    errorMessage: row.error_message || undefined,
    family: familyFromRow(row.family),
  }));
}

/**
 * Which of some targets have been probed and never once answered, in all the
 * readings kept. Asked only of the few targets it matters for: one that has
 * answered stops being read at its first answer, but one that never has is
 * read to the end.
 */
export async function getNeverAnswered(targetIds: string[], probe?: ProbeId): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  const database = await getDatabase();
  // From one probe when asked: a server can answer one place and not another.
  const from = probe ? 'AND m.probe = ?' : '';
  const rows = await allSql<{ id: string }>(
    database,
    `SELECT t.id FROM targets t
     WHERE t.id IN (${targetIds.map(() => '?').join(', ')})
       AND EXISTS (SELECT 1 FROM measurements m WHERE m.target_id = t.id ${from})
       AND NOT EXISTS (SELECT 1 FROM measurements m WHERE m.target_id = t.id AND m.success = 1 ${from})`,
    probe ? [...targetIds, probe, probe] : targetIds
  );
  return new Set(rows.map(row => row.id));
}

/**
 * For each of some targets over a period, how many probes it had and when it
 * lost anything: what one target's loss is held against, to see whether the
 * others lost packets at the same moments. Only the moments of loss are read.
 */
export async function getLossMoments(
  targetIds: string[],
  startTime: Date,
  endTime: Date,
  /** Only readings taken from this probe: the others' losses are a different path's. */
  probe?: ProbeId
): Promise<Map<string, { probes: number; affected: number[] }>> {
  const moments = new Map(targetIds.map(id => [id, { probes: 0, affected: [] as number[] }]));
  if (targetIds.length === 0) return moments;

  const database = await getDatabase();
  const ids = targetIds.map(() => '?').join(', ');
  const only = readingFilter({ probe });
  const window = [...targetIds, startTime.getTime(), endTime.getTime(), ...only.params];

  const [counts, lost] = await Promise.all([
    allSql<{ target_id: string; probes: number }>(
      database,
      `SELECT target_id, COUNT(*) AS probes FROM measurements
       WHERE target_id IN (${ids}) AND timestamp >= ? AND timestamp <= ? ${only.clause}
       GROUP BY target_id`,
      window
    ),
    allSql<{ target_id: string; timestamp: number }>(
      database,
      `SELECT target_id, timestamp FROM measurements
       WHERE target_id IN (${ids}) AND timestamp >= ? AND timestamp <= ? ${only.clause} AND (success = 0 OR packet_loss > 0)
       ORDER BY timestamp ASC`,
      window
    ),
  ]);

  for (const row of counts) moments.get(row.target_id)!.probes = row.probes;
  for (const row of lost) moments.get(row.target_id)!.affected.push(row.timestamp);
  return moments;
}

/**
 * Get target statistics for a time range.
 *
 * Packet loss is the mean of the per-probe `packet_loss` column, not the share
 * of probes that failed outright. Those are different quantities: a path that
 * drops half its packets on every probe has 50% loss and 100% uptime, and only
 * the former tells you the path is degraded. `uptime` reports the second
 * quantity separately.
 *
 * Pass a `family` for a target probed over both: its IPv4 and IPv6 readings
 * are two paths, and one set of statistics over the pair describes neither.
 * The same goes for a `probe` of a monitor measured from several.
 */
export async function getTargetStatistics(
  targetId: string,
  startTime: Date,
  endTime: Date,
  scope: ReadingScope = {}
): Promise<TargetStatistics | null> {
  const database = await getDatabase();
  const only = readingFilter(scope);
  const window = [targetId, startTime.getTime(), endTime.getTime(), ...only.params];

  const aggregates = await new Promise<StatisticsRow | null>((resolve, reject) => {
    database.get(`
      SELECT
        COUNT(*) as total,
        AVG(latency) as avg_latency,
        MIN(COALESCE(latency_min, latency)) as min_latency,
        MAX(COALESCE(latency_max, latency)) as max_latency,
        AVG(jitter) as avg_jitter,
        MIN(jitter) as min_jitter,
        MAX(jitter) as max_jitter,
        AVG(COALESCE(packet_loss, 0)) as avg_loss,
        MIN(COALESCE(packet_loss, 0)) as min_loss,
        MAX(COALESCE(packet_loss, 0)) as max_loss,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
        MAX(timestamp) as last_probe
      FROM measurements
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ${only.clause}
    `, window, (err, row) => {
      if (err) reject(err);
      else resolve((row as StatisticsRow) ?? null);
    });
  });

  if (!aggregates || aggregates.total === 0) return null;

  // SQLite has no median aggregate, so the window's probes are read for the
  // spreads, and for how many fell into each band of loss.
  const probes = await allSql<Pick<MeasurementRow, 'latency' | 'jitter' | 'packet_loss' | 'success'>>(
    database,
    `SELECT latency, jitter, packet_loss, success FROM measurements
     WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ${only.clause}`,
    window
  );
  const latencies = probes.flatMap(probe => (probe.latency === null ? [] : [probe.latency]));
  const jitters = probes.flatMap(probe => (probe.jitter === null ? [] : [probe.jitter]));
  const lossBands = PACKET_LOSS_BANDS.map(() => 0);
  let lossyProbes = 0;
  for (const probe of probes) {
    // A probe that got nothing back lost everything it sent.
    const loss = probe.success === 1 ? probe.packet_loss ?? 0 : 100;
    lossBands[lossBandIndex(loss)]++;
    if (probe.success === 1 && loss > 0) lossyProbes++;
  }

  const total = aggregates.total;

  return {
    targetId,
    sampleCount: total,
    avgLatency: aggregates.avg_latency,
    minLatency: aggregates.min_latency,
    maxLatency: aggregates.max_latency,
    medianLatency: median(latencies),
    latencyP10: percentile(latencies, 10),
    latencyP90: percentile(latencies, 90),
    packetLoss: aggregates.avg_loss ?? 0,
    minPacketLoss: aggregates.min_loss ?? 0,
    maxPacketLoss: aggregates.max_loss ?? 0,
    uptime: ((total - aggregates.failures) / total) * 100,
    lossyProbes,
    failedProbes: aggregates.failures,
    lossBands,
    lastProbe: aggregates.last_probe !== null ? new Date(aggregates.last_probe) : null,
    jitter: aggregates.avg_jitter,
    minJitter: aggregates.min_jitter,
    maxJitter: aggregates.max_jitter,
    medianJitter: median(jitters),
    jitterP10: percentile(jitters, 10),
    jitterP90: percentile(jitters, 90),
  };
}

interface LatestRow {
  target_id: string;
  probe: string;
  family: number | null;
  timestamp: number;
  packet_loss: number | null;
  latency: number | null;
  success: number;
  error_message: string | null;
  details: string | null;
  host: string;
  ip_version: IpVersion | null;
}

function readingFromRow(r: LatestRow): FamilyReading {
  return {
    targetId: r.target_id,
    timestamp: new Date(r.timestamp),
    packetLoss: r.packet_loss ?? 0,
    latency: r.latency,
    success: r.success === 1,
    errorMessage: r.error_message ?? undefined,
    details: parseJson(r.details),
  };
}

/**
 * The newest IPv4 and IPv6 readings of a dual-stack target, as one.
 *
 * Reachable if either family is, with the loss of the worse one: a target
 * whose IPv6 has gone while IPv4 carries on is not down, but it is not fine
 * either, and reporting only the family that works would hide the failure
 * the second probe exists to catch.
 */
function combineFamilies(byFamily: Partial<Record<AddressFamily, FamilyReading>>): LatestMeasurement {
  const families = ([4, 6] as const).filter(family => byFamily[family]);
  const readings = families.map(family => byFamily[family]!);
  const newest = readings.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  const reachable = readings.find(reading => reading.success);
  const failures = families
    .filter(family => !byFamily[family]!.success && byFamily[family]!.errorMessage)
    .map(family => `${FAMILY_LABEL[family]}: ${byFamily[family]!.errorMessage}`);

  return {
    targetId: newest.targetId,
    timestamp: newest.timestamp,
    packetLoss: Math.max(...readings.map(reading => reading.packetLoss)),
    latency: reachable?.latency ?? null,
    success: !!reachable,
    errorMessage: failures.length > 0 ? failures.join('; ') : undefined,
    details: (reachable ?? newest).details,
    byFamily,
  };
}

/**
 * Get the most recent measurement for every target.
 *
 * Returns success and timestamp alongside loss so callers can tell "reachable
 * with 40% loss" from "unreachable" and from "no data yet" — the sidebar needs
 * all three. Joined against `targets` so measurements orphaned by an old
 * delete never resurrect a target in the UI.
 *
 * A target probed over both families gets the newest reading of each, and a
 * summary of the pair (see combineFamilies).
 */
export async function getLatestMeasurementForAllTargets(): Promise<Record<string, LatestMeasurement>> {
  const database = await getDatabase();

  // The newest reading of each family of each probe of each target is one
  // lookup through idx_measurements_target_probe_family_timestamp. Grouping
  // the whole table for it took longer the more history there was, on every
  // refresh of the dashboard. CROSS JOIN keeps the probes as the outer loop:
  // left to itself SQLite walked the measurements instead.
  const newestOf = (family: string) => `
    SELECT m.target_id, m.probe, m.family, m.timestamp, m.packet_loss, m.latency, m.success, m.error_message, m.details,
           t.host, t.ip_version
    FROM target_probes tp
    CROSS JOIN targets t ON t.id = tp.target_id
    CROSS JOIN measurements m ON m.target_id = tp.target_id AND m.probe = tp.probe AND m.family ${family}
      AND m.timestamp = (SELECT MAX(timestamp) FROM measurements WHERE target_id = tp.target_id AND probe = tp.probe AND family ${family})
    WHERE tp.removed_at IS NULL`;

  const [rows, probes] = await Promise.all([
    allSql<LatestRow>(
      database,
      `SELECT * FROM (
        ${newestOf('IS NULL')} UNION ALL ${newestOf('= 4')} UNION ALL ${newestOf('= 6')}
      )
      ORDER BY timestamp DESC`
    ),
    loadProbes(database),
  ]);

  // Newest first, so the first row seen for a probe of a target (or for one
  // family of it) is the one to keep.
  const newest = new Map<string, Map<ProbeId, LatestRow>>();
  const perFamily = new Map<string, Map<ProbeId, Partial<Record<AddressFamily, FamilyReading>>>>();

  for (const row of rows) {
    const ofTarget = newest.get(row.target_id) ?? new Map<ProbeId, LatestRow>();
    if (!ofTarget.has(row.probe)) ofTarget.set(row.probe, row);
    newest.set(row.target_id, ofTarget);

    const family = familyFromRow(row.family);
    if (family && isDualStack(row.host, row.ip_version ?? 'auto')) {
      const ofProbes = perFamily.get(row.target_id) ?? new Map<ProbeId, Partial<Record<AddressFamily, FamilyReading>>>();
      const readings = ofProbes.get(row.probe) ?? {};
      readings[family] ??= readingFromRow(row);
      ofProbes.set(row.probe, readings);
      perFamily.set(row.target_id, ofProbes);
    }
  }

  const map: Record<string, LatestMeasurement> = {};
  for (const [targetId, ofTarget] of newest) {
    const wanted = (probes.get(targetId) ?? []).filter(probe => !probe.former).map(probe => probe.id);
    const readings = new Map<ProbeId, ProbeReading>();
    for (const [probe, row] of ofTarget) {
      const byFamily = perFamily.get(targetId)?.get(probe);
      readings.set(probe, byFamily ? combineFamilies(byFamily) : readingFromRow(row));
    }
    // One probe: the reading as it always was. Several: each one's, and the
    // monitor's as the best of them (see combineProbes).
    map[targetId] = wanted.length > 1
      ? combineProbes(readings, wanted)
      : [...readings.values()][0];
  }

  return map;
}

/**
 * The newest readings of a monitor measured from several probes, as one.
 *
 * Reachable if any probe reaches it, with the loss of the worst, as for the
 * two families of a dual-stack target: a monitor one probe cannot reach while
 * another can is not down, but it is not fine either. `order` is the monitor's
 * probes, primary first, which decides whose latency stands for the whole.
 * Which probes fail and what they said is in `byProbe`, for the page to name.
 */
export function combineProbes(byProbe: Map<ProbeId, ProbeReading>, order: ProbeId[]): LatestMeasurement {
  const known = order.filter(probe => byProbe.has(probe));
  // A probe that has been taken off still has readings; it stands for nothing.
  const readings = known.length > 0 ? known.map(probe => byProbe.get(probe)!) : [...byProbe.values()];
  const newest = readings.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  const reachable = readings.find(reading => reading.success);

  return {
    targetId: newest.targetId,
    timestamp: newest.timestamp,
    packetLoss: Math.max(...readings.map(reading => reading.packetLoss)),
    latency: reachable?.latency ?? null,
    success: !!reachable,
    errorMessage: reachable ? undefined : readings.find(reading => reading.errorMessage)?.errorMessage,
    details: (reachable ?? newest).details,
    byFamily: reachable?.byFamily ?? newest.byFamily,
    byProbe: Object.fromEntries(byProbe),
  };
}

/**
 * Get group ordering
 */
export async function getGroupOrders(): Promise<GroupOrder[]> {
  const database = await getDatabase();

  return new Promise((resolve, reject) => {
    database.all('SELECT * FROM group_orders ORDER BY sort_order ASC', [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      if (!rows || rows.length === 0) {
        resolve([]);
        return;
      }

      const orders: GroupOrder[] = rows.map((row) => {
        const r = row as GroupOrderRow;
        return {
          groupName: r.group_name,
          sortOrder: r.sort_order,
        };
      });

      resolve(orders);
    });
  });
}

/**
 * Save group ordering (upsert all at once)
 */
export async function saveGroupOrders(orders: GroupOrder[]): Promise<void> {
  const database = await getDatabase();

  // Use INSERT OR REPLACE for upsert
  const promises = orders.map((order) =>
    new Promise<void>((resolve, reject) => {
      database.run(
        `INSERT OR REPLACE INTO group_orders (group_name, sort_order) VALUES (?, ?)`,
        [normalizeGroupPath(order.groupName), order.sortOrder],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    })
  );

  await Promise.all(promises);
  saveDatabase();
}

/**
 * Enter a group among those that exist, along with each group it sits inside.
 * Entering one that is already there changes nothing.
 */
async function keepGroup(database: Database, group: string | null | undefined): Promise<void> {
  for (const path of groupWithAncestors(normalizeGroupPath(group))) {
    await runSql(database, 'INSERT OR IGNORE INTO target_groups (group_name) VALUES (?)', [path]);
  }
}

/**
 * Every group there is, as paths, whether or not anything is in it.
 *
 * A group lasts until it is deleted. It used to exist only through the
 * targets in it, which meant it could not be made first and filled later, and
 * that moving its last target out quietly took the group with it.
 */
export async function getGroups(): Promise<string[]> {
  const database = await getDatabase();
  const rows = await allSql<{ group_name: string }>(database, 'SELECT group_name FROM target_groups ORDER BY group_name');
  return rows.map(row => row.group_name);
}

/**
 * Make a group, with nothing in it. Any group in its path that does not exist
 * yet is made too. Returns the path as it is stored, or an empty one if there
 * was no name in what was given.
 */
export async function createGroup(group: string): Promise<string> {
  const database = await getDatabase();
  const path = normalizeGroupPath(group);
  await keepGroup(database, path);
  return path;
}

/**
 * Rewrite the front of every path at or under `source`, on targets and in the
 * list of groups alike. An empty `destination` is the top level. Runs inside
 * the caller's transaction.
 */
async function rebaseGroups(
  database: Database,
  source: string,
  destination: string
): Promise<{ targetsMoved: number; found: boolean }> {
  // Matched here rather than with LIKE: a group name may hold `%` or `_`.
  const inUse = (await allSql<{ group_name: string }>(database, 'SELECT DISTINCT group_name FROM targets'))
    .map(row => row.group_name)
    .filter(group => group && isWithinGroup(group, source));

  let targetsMoved = 0;
  for (const group of inUse) {
    targetsMoved += await new Promise<number>((resolve, reject) => {
      database.run(
        'UPDATE targets SET group_name = ?, updated_at = ? WHERE group_name = ?',
        [rebaseGroupPath(group, source, destination), Date.now(), group],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  const kept = (await allSql<{ group_name: string }>(database, 'SELECT group_name FROM target_groups'))
    .map(row => row.group_name)
    .filter(group => isWithinGroup(group, source));
  // All taken out before any is put back: one group's new path may be
  // another's old one.
  for (const group of kept) {
    await runSql(database, 'DELETE FROM target_groups WHERE group_name = ?', [group]);
  }
  for (const group of kept) {
    await keepGroup(database, rebaseGroupPath(group, source, destination));
  }

  return { targetsMoved, found: inUse.length > 0 || kept.length > 0 };
}

/**
 * Point every target in a group, and in the groups inside it, at one place:
 * a probe agent, or this server when `probeAgentId` is null. Returns how
 * many targets changed place. One already probed from there is left as it is.
 */
export async function setGroupProbeAgent(group: string, probeAgentId: string | null): Promise<number> {
  return setGroupProbes(group, [probeOf(probeAgentId)]);
}

/**
 * Measure every target in a group, and in the groups inside it, from the same
 * probes, primary first. Returns how many targets changed. One already
 * measured from exactly those is left as it is.
 */
export async function setGroupProbes(group: string, probes: ProbeId[]): Promise<number> {
  const database = await getDatabase();
  const source = normalizeGroupPath(group);
  if (!source || probes.length === 0) return 0;

  const [rows, listed] = await Promise.all([
    allSql<{ id: string; probe_agent_id: string | null; group_name: string | null }>(
      database,
      'SELECT id, probe_agent_id, group_name FROM targets'
    ),
    loadProbes(database),
  ]);
  const ids = rows
    .filter(row => {
      if (!row.group_name || !isWithinGroup(row.group_name, source)) return false;
      const now = probeIdsOf({ probes: listed.get(row.id), probeAgentId: row.probe_agent_id });
      return now.length !== probes.length || now.some((probe, index) => probe !== probes[index]);
    })
    .map(row => row.id);

  for (const id of ids) await setTargetProbes(id, probes);
  return ids.length;
}

/**
 * Add a probe to monitors, keeping the probes each already has (it goes last,
 * so no monitor's primary probe changes): every monitor, or those in `group`
 * and the groups inside it. Returns how many monitors gained it.
 */
export async function addProbeToMonitors(probe: ProbeId, scope: { group?: string } = {}): Promise<number> {
  const database = await getDatabase();
  const within = scope.group ? normalizeGroupPath(scope.group) : '';
  const [rows, listed] = await Promise.all([
    allSql<{ id: string; probe_agent_id: string | null; group_name: string | null }>(database, 'SELECT id, probe_agent_id, group_name FROM targets'),
    loadProbes(database),
  ]);
  let added = 0;
  for (const row of rows) {
    if (within && (!row.group_name || !isWithinGroup(row.group_name, within))) continue;
    const now = probeIdsOf({ probes: listed.get(row.id), probeAgentId: row.probe_agent_id });
    if (now.includes(probe)) continue;
    if (await setTargetProbes(row.id, [...now, probe])) added++;
  }
  return added;
}

/**
 * Rename a group, or move it inside another, taking everything beneath it
 * along. Returns how many targets ended up somewhere new.
 *
 * Where a group sits is the front of its path, so this rewrites that front on
 * everything under `from`. Moving onto a group that already exists merges the
 * two.
 */
export async function moveGroup(from: string, to: string): Promise<number> {
  const database = await getDatabase();
  const source = normalizeGroupPath(from);
  const destination = normalizeGroupPath(to);
  if (!source || !destination || source === destination) return 0;
  if (isWithinGroup(destination, source)) {
    throw new Error('A group cannot be moved inside itself');
  }

  await runSql(database, 'BEGIN IMMEDIATE');
  try {
    const { targetsMoved: moved } = await rebaseGroups(database, source, destination);

    // Saved positions follow their groups. The one for the group that moved is
    // only carried over if it is still among the same neighbours: a position
    // among one set of siblings means nothing among another.
    const sameParent = parentGroup(source) === parentGroup(destination);
    const orders = (await allSql<GroupOrderRow>(database, 'SELECT * FROM group_orders'))
      .filter(order => isWithinGroup(order.group_name, source));
    for (const order of orders) {
      await runSql(database, 'DELETE FROM group_orders WHERE group_name = ?', [order.group_name]);
      if (order.group_name === source && !sameParent) continue;
      await runSql(database, 'INSERT OR IGNORE INTO group_orders (group_name, sort_order) VALUES (?, ?)', [
        rebaseGroupPath(order.group_name, source, destination),
        order.sort_order,
      ]);
    }

    await runSql(database, 'COMMIT');
    return moved;
  } catch (error) {
    await runSql(database, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

/**
 * Delete a group and keep what was in it. Its targets, and the groups inside
 * it, move up to the group it sat in, or to the top level if it sat in none.
 * Returns whether there was such a group.
 *
 * Only the group goes. Taking the targets with it would take their whole
 * history, and that is what deleting a target is for.
 */
export async function deleteGroup(group: string): Promise<boolean> {
  const database = await getDatabase();
  const source = normalizeGroupPath(group);
  if (!source) return false;

  await runSql(database, 'BEGIN IMMEDIATE');
  try {
    // Moving everything up one level leaves the group's own entry sitting on
    // its parent's path, which is how the group itself comes to be gone.
    const { found } = await rebaseGroups(database, source, parentGroup(source));

    // Positions are not carried: they were among the groups inside this one,
    // and mean nothing among the neighbours those groups have now.
    const orders = (await allSql<GroupOrderRow>(database, 'SELECT * FROM group_orders'))
      .filter(order => isWithinGroup(order.group_name, source));
    for (const order of orders) {
      await runSql(database, 'DELETE FROM group_orders WHERE group_name = ?', [order.group_name]);
    }

    await runSql(database, 'COMMIT');
    return found;
  } catch (error) {
    await runSql(database, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

/**
 * Delete groups chosen to go, with every group inside them, once there is no
 * target left anywhere in them. One that still has a target, which happens
 * when one was added to it meanwhile, is kept with everything in it. Returns
 * the groups that went, those inside included.
 */
export async function deleteEmptyGroups(groups: string[]): Promise<string[]> {
  const database = await getDatabase();

  const chosen = [...new Set(groups.map(normalizeGroupPath).filter(Boolean))];
  if (chosen.length === 0) return [];

  const inUse = (await allSql<{ group_name: string }>(database, 'SELECT DISTINCT group_name FROM targets'))
    .map(row => row.group_name)
    .filter(Boolean);
  const empty = chosen.filter(group => !inUse.some(used => isWithinGroup(used, group)));
  if (empty.length === 0) return [];

  const within = (rows: { group_name: string }[]) =>
    rows.map(row => row.group_name).filter(name => empty.some(group => isWithinGroup(name, group)));
  const kept = within(await allSql<{ group_name: string }>(database, 'SELECT group_name FROM target_groups'));
  const ordered = within(await allSql<{ group_name: string }>(database, 'SELECT group_name FROM group_orders'));

  await runSql(database, 'BEGIN IMMEDIATE');
  try {
    for (const group of kept) await runSql(database, 'DELETE FROM target_groups WHERE group_name = ?', [group]);
    for (const group of ordered) await runSql(database, 'DELETE FROM group_orders WHERE group_name = ?', [group]);
    await runSql(database, 'COMMIT');
  } catch (error) {
    await runSql(database, 'ROLLBACK').catch(() => {});
    throw error;
  }
  return [...new Set([...empty, ...kept])];
}

/**
 * Remove the groups that deleting targets left empty. Given the groups the
 * deleted targets were in, it takes away each of those, and each group they
 * sat inside, that now has no target anywhere beneath it.
 *
 * Only those groups are looked at: an empty group somebody made and has not
 * filled yet is not touched. A group is kept for as long as one of its
 * subgroups is, so the tree is never left with a gap in it. Returns the groups
 * that went.
 */
export async function pruneEmptyGroups(groups: string[]): Promise<string[]> {
  const database = await getDatabase();

  const candidates = new Set(groups.flatMap(group => groupWithAncestors(normalizeGroupPath(group))));
  if (candidates.size === 0) return [];

  const inUse = (await allSql<{ group_name: string }>(database, 'SELECT DISTINCT group_name FROM targets'))
    .map(row => row.group_name)
    .filter(Boolean);
  const kept = (await allSql<{ group_name: string }>(database, 'SELECT group_name FROM target_groups'))
    .map(row => row.group_name);

  const prune = new Set([...candidates].filter(group => !inUse.some(used => isWithinGroup(used, group))));

  // A group with a subgroup that is staying stays too, and so does every group
  // above it; going round again until nothing more is put back.
  for (let changed = true; changed; ) {
    changed = false;
    for (const group of [...prune]) {
      if (kept.some(other => other !== group && isWithinGroup(other, group) && !prune.has(other))) {
        prune.delete(group);
        changed = true;
      }
    }
  }
  if (prune.size === 0) return [];

  await runSql(database, 'BEGIN IMMEDIATE');
  try {
    for (const group of prune) {
      await runSql(database, 'DELETE FROM target_groups WHERE group_name = ?', [group]);
      await runSql(database, 'DELETE FROM group_orders WHERE group_name = ?', [group]);
    }
    await runSql(database, 'COMMIT');
  } catch (error) {
    await runSql(database, 'ROLLBACK').catch(() => {});
    throw error;
  }
  return [...prune];
}

/**
 * Update sort_order for multiple targets in a batch
 */
export async function updateTargetSortOrders(updates: { id: string; sortOrder: number; group?: string }[]): Promise<void> {
  const database = await getDatabase();

  for (const update of updates) {
    if (update.group !== undefined) await keepGroup(database, update.group);
  }

  const promises = updates.map((update) =>
    new Promise<void>((resolve, reject) => {
      const fields = ['sort_order = ?'];
      const values: (string | number)[] = [update.sortOrder];
      if (update.group !== undefined) {
        fields.push('group_name = ?');
        values.push(normalizeGroupPath(update.group));
      }
      values.push(update.id);
      database.run(
        `UPDATE targets SET ${fields.join(', ')} WHERE id = ?`,
        values,
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    })
  );

  await Promise.all(promises);
  saveDatabase();
}

/**
 * Aggregate measurements into fixed time buckets in SQL.
 *
 * The alternative — shipping every raw row and folding them in the browser —
 * makes the response grow without bound: a 30-day window at a 30-second probe
 * interval is roughly 86,000 rows per target. Bucketing here keeps the payload
 * proportional to the number of points the chart can actually draw.
 *
 * Empty buckets are simply absent from the result. Callers distinguish "no
 * probe ran" from "probe ran and lost everything" by the presence of the row,
 * not by a zero.
 *
 * Pass a `family` to read one side of a target probed over both, and a
 * `probe` to read one of the probes that measure it.
 */
export async function getBucketedMeasurements(
  targetId: string,
  startTime: Date,
  endTime: Date,
  bucketMs: number,
  scope: ReadingScope = {}
): Promise<BucketedMeasurement[]> {
  const database = await getDatabase();
  const width = Math.max(1000, Math.floor(bucketMs));
  const only = readingFilter(scope);

  return new Promise((resolve, reject) => {
    database.all(
      `
      SELECT
        (timestamp / ?) * ? AS bucket_start,
        COUNT(*)            AS samples,
        AVG(latency)        AS avg_latency,
        MIN(COALESCE(latency_min, latency)) AS min_latency,
        MAX(COALESCE(latency_max, latency)) AS max_latency,
        -- Averaging each percentile across the probes in a bucket is an
        -- approximation, but a faithful one for drawing: the alternative is
        -- shipping every raw sample to recompute quantiles in the browser.
        AVG(latency_p10) AS p10_latency,
        AVG(latency_p25) AS p25_latency,
        AVG(latency_p50) AS p50_latency,
        AVG(latency_p75) AS p75_latency,
        AVG(latency_p90) AS p90_latency,
        AVG(COALESCE(packet_loss, 0)) AS avg_loss,
        MAX(COALESCE(packet_loss, 0)) AS max_loss,
        AVG(jitter)         AS avg_jitter,
        SUM(success)        AS successes
      FROM measurements
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ${only.clause}
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
      `,
      [width, width, targetId, startTime.getTime(), endTime.getTime(), ...only.params],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(
          (rows ?? []).map(row => {
            const r = row as {
              bucket_start: number;
              samples: number;
              avg_latency: number | null;
              min_latency: number | null;
              max_latency: number | null;
              p10_latency: number | null;
              p25_latency: number | null;
              p50_latency: number | null;
              p75_latency: number | null;
              p90_latency: number | null;
              avg_loss: number | null;
              max_loss: number | null;
              avg_jitter: number | null;
              successes: number;
            };
            return {
              // Centre of the bucket: a point drawn at the left edge implies the
              // reading happened at a moment no measurement was taken.
              timestamp: new Date(r.bucket_start + width / 2),
              sampleCount: r.samples,
              latency: r.avg_latency,
              minLatency: r.min_latency,
              maxLatency: r.max_latency,
              p10Latency: r.p10_latency,
              p25Latency: r.p25_latency,
              p50Latency: r.p50_latency,
              p75Latency: r.p75_latency,
              p90Latency: r.p90_latency,
              packetLoss: r.avg_loss ?? 0,
              maxPacketLoss: r.max_loss ?? 0,
              jitter: r.avg_jitter,
              isOnline: r.successes > 0,
            };
          })
        );
      }
    );
  });
}

/**
 * How each resolver of a DNS target did in every probe of a period, oldest
 * first. Probes taken before the target had resolvers of its own, and so with
 * nothing to say about them, are left out.
 */
export async function getResolverRounds(
  targetId: string,
  startTime: Date,
  endTime: Date,
  scope: ReadingScope = {}
): Promise<Array<{ timestamp: number; readings: DnsResolverReading[] }>> {
  const database = await getDatabase();
  // A target on both families asks for a different record over each, and the
  // two are not one resolver's line. Nor are two probes': each asks its own.
  const only = readingFilter(scope);

  const rows = await allSql<{ timestamp: number; details: string }>(
    database,
    // The text is looked for before any of it is parsed: on a target that has
    // only lately been given resolvers most rows have none to read.
    `SELECT timestamp, details FROM measurements
     WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ${only.clause} AND details LIKE '%"resolvers"%'
     ORDER BY timestamp ASC`,
    [targetId, startTime.getTime(), endTime.getTime(), ...only.params]
  );

  return rows.flatMap(row => {
    const readings = parseJson<ProbeDetails>(row.details)?.resolvers;
    return Array.isArray(readings) && readings.length > 0 ? [{ timestamp: row.timestamp, readings }] : [];
  });
}

/**
 * Delete measurements older than the retention window.
 *
 * Returns the number of rows removed so the caller can log it; a retention job
 * that silently does nothing is indistinguishable from one that is not running.
 */
export async function cleanOldMeasurements(daysToKeep: number = 90): Promise<number> {
  const database = await getDatabase();
  const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

  const removed = await new Promise<number>((resolve, reject) => {
    database.run('DELETE FROM measurements WHERE timestamp < ?', [cutoffTime], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });

  // A probe taken off a monitor is listed only while readings of it remain.
  await runSql(
    database,
    `DELETE FROM target_probes WHERE removed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM measurements m WHERE m.target_id = target_probes.target_id AND m.probe = target_probes.probe)`
  );
  return removed;
}

/**
 * Recent measurements for every target, newest last, capped per target.
 *
 * Feeds the sparkline traces in the sidebar. One window-function query rather
 * than one query per target, so adding targets does not multiply round trips.
 *
 * Rows sharing a target and a timestamp are one round of a target probed over
 * both families, and are drawn as one point carrying the worse loss. Left as
 * two, the trace would zigzag between the IPv4 and IPv6 latencies.
 *
 * Of one probe when `probe` is given, otherwise of each target's primary
 * probe: a monitor measured from several would otherwise zigzag between them.
 */
export async function getRecentSeriesForAllTargets(
  pointsPerTarget = 24,
  probe?: ProbeId
): Promise<Record<string, SparklinePoint[]>> {
  const database = await getDatabase();
  const limit = Math.min(120, Math.max(2, Math.floor(pointsPerTarget)));
  const from = probe ? '?' : "COALESCE(tp.probe, 'local')";

  return new Promise((resolve, reject) => {
    database.all(
      `
      SELECT target_id, timestamp, latency, packet_loss, success
      FROM (
        SELECT m.target_id, m.timestamp,
               AVG(m.latency) AS latency,
               -- A failed probe with no recorded loss lost everything.
               MAX(COALESCE(m.packet_loss, CASE WHEN m.success = 1 THEN 0 ELSE 100 END)) AS packet_loss,
               MIN(m.success) AS success,
               ROW_NUMBER() OVER (PARTITION BY m.target_id ORDER BY m.timestamp DESC) AS rn
        FROM targets t
        LEFT JOIN target_probes tp ON tp.target_id = t.id AND tp.position = 0 AND tp.removed_at IS NULL
        -- Only the newest rows of each target are looked at, found through the
        -- (target_id, timestamp) index. A target probed over both families
        -- has two rows per reading, so twice the limit is read and the
        -- ROW_NUMBER below keeps the newest readings among them. Looking at
        -- every row there is took longer the more history was kept.
        CROSS JOIN measurements m ON m.target_id = t.id AND m.probe = ${from}
          AND m.timestamp >= COALESCE(
            (SELECT timestamp FROM measurements WHERE target_id = t.id AND probe = ${from} ORDER BY timestamp DESC LIMIT 1 OFFSET ?),
            0
          )
        GROUP BY m.target_id, m.timestamp
      )
      WHERE rn <= ?
      ORDER BY target_id ASC, timestamp ASC
      `,
      probe ? [probe, probe, limit * 2 - 1, limit] : [limit * 2 - 1, limit],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        const series: Record<string, SparklinePoint[]> = {};

        for (const row of (rows ?? [])) {
          const r = row as {
            target_id: string;
            timestamp: number;
            latency: number | null;
            packet_loss: number | null;
            success: number;
          };

          (series[r.target_id] ??= []).push({
            timestamp: r.timestamp,
            latency: r.latency,
            packetLoss: r.packet_loss ?? (r.success === 1 ? 0 : 100),
          });
        }

        resolve(series);
      }
    );
  });
}
