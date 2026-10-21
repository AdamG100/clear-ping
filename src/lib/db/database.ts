import path from 'path';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { Target, ProbeMeasurement, TargetStatistics, GroupOrder, LatestMeasurement, FamilyReading, BucketedMeasurement, SparklinePoint, IpVersion, ProbeType, AddressFamily, DnsResolverReading, ProbeDetails } from '@/types/probe';
import { addressFamilyFor, FAMILY_LABEL, isDualStack } from '../probes/host';
import { median } from '../probes/metrics';
import { groupWithAncestors, isWithinGroup, normalizeGroupPath, parentGroup, rebaseGroupPath } from '../targets/group-path';
import { runMigrations } from './migrations';

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
}

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

function targetFromRow(r: TargetRow): Target {
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
}

/** A stored family, or undefined for a row written before it was recorded. */
function familyFromRow(value: number | null): AddressFamily | undefined {
  return value === 4 || value === 6 ? value : undefined;
}

/**
 * Restrict a measurements query to one address family. Without a family the
 * query covers every row, which is right for any target that is not split.
 */
function familyFilter(family?: AddressFamily): { clause: string; params: number[] } {
  return family ? { clause: 'AND family = ?', params: [family] } : { clause: '', params: [] };
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

let db: Database | null = null;
let dbInitPromise: Promise<Database> | null = null;

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
 * Initialize the SQLite database and create tables
 */
export async function initDatabase(): Promise<Database> {
  if (db) return db;
  
  // Return existing promise if initialization is in progress
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    // Ensure data directory exists
    // Configurable so the standalone prober (which may run from a different
    // working directory) and the tests can point at their own file.
    const dbPath = databasePath();

    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Initialize sqlite3 database
    const sqlite = sqlite3.verbose();
    db = new sqlite.Database(dbPath);

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
        db!.run(pragma, function (err) {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // Create targets table
    await new Promise<void>((resolve, reject) => {
      db!.run(targetsTableSql('targets').replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'), function(err) {
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
      db!.run(`
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
        db!.run(`ALTER TABLE measurements ADD COLUMN ${column}`, function (err) {
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
      db!.run(`CREATE INDEX IF NOT EXISTS idx_measurements_target_timestamp 
              ON measurements(target_id, timestamp DESC)`, function(err) {
        if (err) reject(err);
        else resolve();
      });
    });

    // What finds the newest reading of each family of each target without
    // reading the history behind it.
    await new Promise<void>((resolve, reject) => {
      db!.run(`CREATE INDEX IF NOT EXISTS idx_measurements_target_family_timestamp
              ON measurements(target_id, family, timestamp DESC)`, function(err) {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      db!.run(`CREATE INDEX IF NOT EXISTS idx_measurements_timestamp
              ON measurements(timestamp DESC)`, function(err) {
        if (err) reject(err);
        else resolve();
      });
    });

    // Add sort_order column to targets if missing
    await new Promise<void>((resolve, reject) => {
      db!.run(`ALTER TABLE targets ADD COLUMN sort_order INTEGER DEFAULT 0`, function(err) {
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
        db!.run(`ALTER TABLE targets ADD COLUMN ${column}`, function (err) {
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
    const targetsSql = await tableDefinition(db, 'targets');
    if (targetsSql && /CHECK\s*\(\s*probe_type/i.test(targetsSql)) {
      // A rebuild is transactional, but it is also the one migration here that
      // rewrites existing rows rather than adding to them, so take a snapshot
      // first. VACUUM INTO copies a consistent image, write-ahead log included.
      const backupPath = `${dbPath}.before-probe-types-${Date.now()}.bak`;
      try {
        await runSql(db, 'VACUUM INTO ?', [backupPath]);
        console.log(`Database: Backed up to ${backupPath} before migrating the targets table`);
      } catch (error) {
        console.warn('Database: Could not back up before migrating; continuing:', error);
      }

      await rebuildTable(db, 'targets', targetsTableSql, TARGET_COLUMNS);
      console.log('Database: Migrated targets table to accept new probe types');
    }

    await backfillMeasurementFamilies(db);

    // Create group_orders table
    await new Promise<void>((resolve, reject) => {
      db!.run(`
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
    await runMigrations(db);

    console.log('Database: Tables and indexes created successfully');

    return db!;
  })();

  return dbInitPromise;
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
  const handle = db;
  db = null;
  dbInitPromise = null;
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
  if (!db) {
    return await initDatabase();
  }
  return db;
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

  return new Promise<Target>((resolve, reject) => {
    database.run(`
      INSERT INTO targets (id, name, host, probe_type, interval, status, group_name, sort_order, ip_version, probe_config, probe_agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [target.id, target.name, target.host, target.probeType, target.interval, target.status, group, target.sortOrder ?? 0, target.ipVersion ?? 'auto', toJson(target.probeConfig), target.probeAgentId ?? null, now, now], function(err) {
      if (err) {
        reject(err);
        return;
      }
      saveDatabase();
      resolve({
        ...target,
        group: group || undefined,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
    });
  });
}

/**
 * Get all targets
 */
export async function getAllTargets(): Promise<Target[]> {
  const database = await getDatabase();
  
  return new Promise((resolve, reject) => {
    database.all('SELECT * FROM targets ORDER BY sort_order ASC, name ASC', [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!rows || rows.length === 0) {
        resolve([]);
        return;
      }

      resolve(rows.map(row => targetFromRow(row as TargetRow)));
    });
  });
}

/**
 * Get a single target by ID
 */
export async function getTargetById(id: string): Promise<Target | null> {
  const database = await getDatabase();
  
  return new Promise((resolve, reject) => {
    database.get('SELECT * FROM targets WHERE id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!row) {
        resolve(null);
        return;
      }

      resolve(targetFromRow(row as TargetRow));
    });
  });
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
  if (updates.probeAgentId !== undefined) {
    fields.push('probe_agent_id = ?');
    values.push(updates.probeAgentId);
  }
  // The stored address describes what the old host resolved to. Once the host,
  // its address family or its probe changes it describes nothing, and showing
  // it until the next probe would label the target with somewhere it no longer
  // points.
  // Nor does it once the target is probed from somewhere else, which may
  // resolve the name differently.
  if (updates.host !== undefined || updates.ipVersion !== undefined || updates.probeType !== undefined || updates.probeAgentId !== undefined) {
    fields.push('resolved_address = NULL');
  }

  if (fields.length === 0) return false;

  if (updates.group !== undefined) await keepGroup(database, updates.group);

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  return new Promise<boolean>((resolve, reject) => {
    database.run(`UPDATE targets SET ${fields.join(', ')} WHERE id = ?`, values, function(err) {
      if (err) {
        reject(err);
        return;
      }
      saveDatabase();
      // `this.changes` is 0 when no row matched, which is how callers tell a
      // successful update from an update against a target that doesn't exist.
      resolve(this.changes > 0);
    });
  });
}

/**
 * Delete a target and all its measurements.
 *
 * The measurements are removed explicitly rather than relying only on the
 * cascade, so databases created before foreign keys were enabled still get
 * cleaned up.
 */
export async function deleteTarget(id: string): Promise<boolean> {
  const database = await getDatabase();

  await new Promise<void>((resolve, reject) => {
    database.run('DELETE FROM measurements WHERE target_id = ?', [id], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });

  return new Promise<boolean>((resolve, reject) => {
    database.run('DELETE FROM targets WHERE id = ?', [id], function(err) {
      if (err) {
        reject(err);
        return;
      }
      saveDatabase();
      resolve(this.changes > 0);
    });
  });
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
  INSERT INTO measurements (id, target_id, timestamp, latency, latency_min, latency_max, latency_p10, latency_p25, latency_p50, latency_p75, latency_p90, packet_loss, jitter, success, error_message, details, family)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  endTime: Date
): Promise<ProbeMeasurement[]> {
  const database = await getDatabase();
  
  return new Promise((resolve, reject) => {
    database.all(`
      SELECT * FROM measurements
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `, [targetId, startTime.getTime(), endTime.getTime()], (err, rows) => {
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
export async function getProbeReadings(targetId: string, startTime: Date, endTime: Date): Promise<StoredReading[]> {
  const database = await getDatabase();

  const rows = await allSql<Pick<MeasurementRow, 'timestamp' | 'latency' | 'packet_loss' | 'success' | 'error_message' | 'family'>>(
    database,
    `SELECT timestamp, latency, packet_loss, success, error_message, family FROM measurements
     WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC`,
    [targetId, startTime.getTime(), endTime.getTime()]
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
 */
export async function getTargetStatistics(
  targetId: string,
  startTime: Date,
  endTime: Date,
  family?: AddressFamily
): Promise<TargetStatistics | null> {
  const database = await getDatabase();
  const only = familyFilter(family);
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

  // SQLite has no median aggregate, so pull the latency column for the window.
  const latencies = await new Promise<number[]>((resolve, reject) => {
    database.all(`
      SELECT latency FROM measurements
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? AND latency IS NOT NULL ${only.clause}
    `, window, (err, rows) => {
      if (err) reject(err);
      else resolve((rows as { latency: number }[]).map(r => r.latency));
    });
  });

  const total = aggregates.total;

  return {
    targetId,
    sampleCount: total,
    avgLatency: aggregates.avg_latency,
    minLatency: aggregates.min_latency,
    maxLatency: aggregates.max_latency,
    medianLatency: median(latencies),
    packetLoss: aggregates.avg_loss ?? 0,
    minPacketLoss: aggregates.min_loss ?? 0,
    maxPacketLoss: aggregates.max_loss ?? 0,
    uptime: ((total - aggregates.failures) / total) * 100,
    lastProbe: aggregates.last_probe !== null ? new Date(aggregates.last_probe) : null,
    jitter: aggregates.avg_jitter,
    minJitter: aggregates.min_jitter,
    maxJitter: aggregates.max_jitter,
  };
}

interface LatestRow {
  target_id: string;
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

  const rows = await new Promise<LatestRow[]>((resolve, reject) => {
    // The newest reading of each family of each target is one lookup through
    // idx_measurements_target_family_timestamp. Grouping the whole table for it
    // took longer the more history there was, on every refresh of the
    // dashboard. CROSS JOIN keeps the targets as the outer loop: left to
    // itself SQLite walked the measurements instead.
    const newestOf = (family: string) => `
      SELECT m.target_id, m.family, m.timestamp, m.packet_loss, m.latency, m.success, m.error_message, m.details,
             t.host, t.ip_version
      FROM targets t
      CROSS JOIN measurements m ON m.target_id = t.id AND m.family ${family}
        AND m.timestamp = (SELECT MAX(timestamp) FROM measurements WHERE target_id = t.id AND family ${family})`;

    database.all(`
      SELECT * FROM (
        ${newestOf('IS NULL')} UNION ALL ${newestOf('= 4')} UNION ALL ${newestOf('= 6')}
      )
      ORDER BY timestamp DESC
    `, [], (err, result) => {
      if (err) reject(err);
      else resolve((result ?? []) as LatestRow[]);
    });
  });

  // Newest first, so the first row seen for a target (or for one family of
  // it) is the one to keep.
  const newest = new Map<string, LatestRow>();
  const perFamily = new Map<string, Partial<Record<AddressFamily, FamilyReading>>>();

  for (const row of rows) {
    if (!newest.has(row.target_id)) newest.set(row.target_id, row);

    const family = familyFromRow(row.family);
    if (family && isDualStack(row.host, row.ip_version ?? 'auto')) {
      const readings = perFamily.get(row.target_id) ?? {};
      readings[family] ??= readingFromRow(row);
      perFamily.set(row.target_id, readings);
    }
  }

  const map: Record<string, LatestMeasurement> = {};
  for (const [targetId, row] of newest) {
    const byFamily = perFamily.get(targetId);
    map[targetId] = byFamily ? combineFamilies(byFamily) : readingFromRow(row);
  }

  return map;
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
 * Pass a `family` to read one side of a target probed over both.
 */
export async function getBucketedMeasurements(
  targetId: string,
  startTime: Date,
  endTime: Date,
  bucketMs: number,
  family?: AddressFamily
): Promise<BucketedMeasurement[]> {
  const database = await getDatabase();
  const width = Math.max(1000, Math.floor(bucketMs));
  const only = familyFilter(family);

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
  family?: AddressFamily
): Promise<Array<{ timestamp: number; readings: DnsResolverReading[] }>> {
  const database = await getDatabase();
  // A target on both families asks for a different record over each, and the
  // two are not one resolver's line.
  const only = familyFilter(family);

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

  return new Promise<number>((resolve, reject) => {
    database.run('DELETE FROM measurements WHERE timestamp < ?', [cutoffTime], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
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
 */
export async function getRecentSeriesForAllTargets(
  pointsPerTarget = 24
): Promise<Record<string, SparklinePoint[]>> {
  const database = await getDatabase();
  const limit = Math.min(120, Math.max(2, Math.floor(pointsPerTarget)));

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
        -- Only the newest rows of each target are looked at, found through the
        -- (target_id, timestamp) index. A target probed over both families
        -- has two rows per reading, so twice the limit is read and the
        -- ROW_NUMBER below keeps the newest readings among them. Looking at
        -- every row there is took longer the more history was kept.
        CROSS JOIN measurements m ON m.target_id = t.id
          AND m.timestamp >= COALESCE(
            (SELECT timestamp FROM measurements WHERE target_id = t.id ORDER BY timestamp DESC LIMIT 1 OFFSET ?),
            0
          )
        GROUP BY m.target_id, m.timestamp
      )
      WHERE rn <= ?
      ORDER BY target_id ASC, timestamp ASC
      `,
      [limit * 2 - 1, limit],
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
