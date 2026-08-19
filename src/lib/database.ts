import path from 'path';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { Target, ProbeMeasurement, TargetStatistics, GroupOrder, LatestMeasurement, BucketedMeasurement, SparklinePoint } from '@/types/probe';
import { median } from './metrics';

// Use sqlite3.Database type
type Database = sqlite3.Database;

// Database row types
interface TargetRow {
  id: string;
  name: string;
  host: string;
  probe_type: 'ping' | 'dns';
  interval: number;
  status: 'active' | 'paused' | 'error';
  group_name?: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
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
    const dbPath = process.env.CLEARPING_DB_PATH
      ? path.resolve(process.env.CLEARPING_DB_PATH)
      : path.join(process.cwd(), 'data', 'clearping.db');

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
      db!.run(`
        CREATE TABLE IF NOT EXISTS targets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          host TEXT NOT NULL,
          probe_type TEXT NOT NULL CHECK(probe_type IN ('ping', 'dns')),
          interval INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'error')),
          group_name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_probe_at INTEGER DEFAULT 0
        )
      `, function(err) {
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

  return new Promise<Target>((resolve, reject) => {
    database.run(`
      INSERT INTO targets (id, name, host, probe_type, interval, status, group_name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [target.id, target.name, target.host, target.probeType, target.interval, target.status, target.group || '', target.sortOrder ?? 0, now, now], function(err) {
      if (err) {
        reject(err);
        return;
      }
      saveDatabase();
      resolve({
        ...target,
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

      const targets: Target[] = rows.map((row) => {
        const r = row as TargetRow;
        return {
          id: r.id,
          name: r.name,
          host: r.host,
          probeType: r.probe_type,
          interval: r.interval,
          status: r.status,
          group: r.group_name,
          sortOrder: r.sort_order ?? 0,
          createdAt: new Date(r.created_at),
          updatedAt: new Date(r.updated_at),
        };
      });
      
      resolve(targets);
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

      const r = row as TargetRow;
      resolve({
        id: r.id,
        name: r.name,
        host: r.host,
        probeType: r.probe_type,
        interval: r.interval,
        status: r.status,
        group: r.group_name,
        sortOrder: r.sort_order ?? 0,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
      });
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
  const values: (string | number)[] = [];

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
    values.push(updates.group || '');
  }
  if (updates.sortOrder !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sortOrder);
  }

  if (fields.length === 0) return false;

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

export async function storeMeasurement(measurement: ProbeMeasurement & { packetLoss?: number }): Promise<void> {
  const database = await getDatabase();
  
  return new Promise<void>((resolve, reject) => {
    database.run(`
      INSERT INTO measurements (id, target_id, timestamp, latency, latency_min, latency_max, latency_p10, latency_p25, latency_p50, latency_p75, latency_p90, packet_loss, jitter, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
      measurement.errorMessage || null
    ], function(err) {
      if (err) {
        reject(err);
        return;
      }
      saveDatabase();
      resolve();
    });
  });
}

/**
 * Store multiple measurements
 */
export async function storeMeasurements(measurements: ProbeMeasurement[]): Promise<void> {
  const database = await getDatabase();
  
  const promises = measurements.map(item => 
    new Promise<void>((resolve, reject) => {
      database.run(`
        INSERT INTO measurements (id, target_id, timestamp, latency, latency_min, latency_max, latency_p10, latency_p25, latency_p50, latency_p75, latency_p90, packet_loss, jitter, success, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        item.id,
        item.targetId,
        item.timestamp.getTime(),
        item.latency,
        item.minLatency ?? null,
        item.maxLatency ?? null,
        item.p10Latency ?? null,
        item.p25Latency ?? null,
        item.p50Latency ?? null,
        item.p75Latency ?? null,
        item.p90Latency ?? null,
        item.packetLoss ?? 0,
        item.jitter,
        item.success ? 1 : 0,
        item.errorMessage || null
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    })
  );
  
  await Promise.all(promises);
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
        };
      });
      
      resolve(measurements);
    });
  });
}

/**
 * Get target statistics for a time range.
 *
 * Packet loss is the mean of the per-probe `packet_loss` column, not the share
 * of probes that failed outright. Those are different quantities: a path that
 * drops half its packets on every probe has 50% loss and 100% uptime, and only
 * the former tells you the path is degraded. `uptime` reports the second
 * quantity separately.
 */
export async function getTargetStatistics(
  targetId: string,
  startTime: Date,
  endTime: Date
): Promise<TargetStatistics | null> {
  const database = await getDatabase();

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
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
    `, [targetId, startTime.getTime(), endTime.getTime()], (err, row) => {
      if (err) reject(err);
      else resolve((row as StatisticsRow) ?? null);
    });
  });

  if (!aggregates || aggregates.total === 0) return null;

  // SQLite has no median aggregate, so pull the latency column for the window.
  const latencies = await new Promise<number[]>((resolve, reject) => {
    database.all(`
      SELECT latency FROM measurements
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? AND latency IS NOT NULL
    `, [targetId, startTime.getTime(), endTime.getTime()], (err, rows) => {
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

/**
 * Get the most recent measurement for every target.
 *
 * Returns success and timestamp alongside loss so callers can tell "reachable
 * with 40% loss" from "unreachable" and from "no data yet" — the sidebar needs
 * all three. Joined against `targets` so measurements orphaned by an old
 * delete never resurrect a target in the UI.
 */
export async function getLatestMeasurementForAllTargets(): Promise<Record<string, LatestMeasurement>> {
  const database = await getDatabase();

  return new Promise((resolve, reject) => {
    database.all(`
      SELECT m.target_id, m.timestamp, m.packet_loss, m.latency, m.success
      FROM measurements m
      JOIN targets t ON t.id = m.target_id
      JOIN (
        SELECT target_id, MAX(timestamp) AS max_ts
        FROM measurements
        GROUP BY target_id
      ) latest ON latest.target_id = m.target_id AND latest.max_ts = m.timestamp
      GROUP BY m.target_id
    `, [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      const map: Record<string, LatestMeasurement> = {};
      for (const row of (rows ?? [])) {
        const r = row as {
          target_id: string;
          timestamp: number;
          packet_loss: number | null;
          latency: number | null;
          success: number;
        };
        map[r.target_id] = {
          targetId: r.target_id,
          timestamp: new Date(r.timestamp),
          packetLoss: r.packet_loss ?? 0,
          latency: r.latency,
          success: r.success === 1,
        };
      }

      resolve(map);
    });
  });
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
        [order.groupName, order.sortOrder],
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
 * Update sort_order for multiple targets in a batch
 */
export async function updateTargetSortOrders(updates: { id: string; sortOrder: number; group?: string }[]): Promise<void> {
  const database = await getDatabase();

  const promises = updates.map((update) =>
    new Promise<void>((resolve, reject) => {
      const fields = ['sort_order = ?'];
      const values: (string | number)[] = [update.sortOrder];
      if (update.group !== undefined) {
        fields.push('group_name = ?');
        values.push(update.group || '');
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
 */
export async function getBucketedMeasurements(
  targetId: string,
  startTime: Date,
  endTime: Date,
  bucketMs: number
): Promise<BucketedMeasurement[]> {
  const database = await getDatabase();
  const width = Math.max(1000, Math.floor(bucketMs));

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
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
      `,
      [width, width, targetId, startTime.getTime(), endTime.getTime()],
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
        SELECT m.target_id, m.timestamp, m.latency, m.packet_loss, m.success,
               ROW_NUMBER() OVER (PARTITION BY m.target_id ORDER BY m.timestamp DESC) AS rn
        FROM measurements m
        JOIN targets t ON t.id = m.target_id
      )
      WHERE rn <= ?
      ORDER BY target_id ASC, timestamp ASC
      `,
      [limit],
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
            // A failed probe with no recorded loss lost everything.
            packetLoss: r.packet_loss ?? (r.success === 1 ? 0 : 100),
          });
        }

        resolve(series);
      }
    );
  });
}
