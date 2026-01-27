import path from 'path';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { Target, ProbeMeasurement, TargetStatistics } from '@/types/probe';

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
  created_at: number;
  updated_at: number;
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
  failures: number;
  last_probe: number;
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
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'clearping.db');
    
    // Initialize sqlite3 database
    const sqlite = sqlite3.verbose();
    db = new sqlite.Database(dbPath);

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

    // Add jitter column if it doesn't exist (for existing databases)
    await new Promise<void>((resolve, reject) => {
      db!.run(`ALTER TABLE measurements ADD COLUMN jitter REAL`, function(err) {
        // Ignore error if column already exists
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Database: Error adding jitter column:', err);
          reject(err);
        } else {
          console.log('Database: Ensured jitter column exists');
          resolve();
        }
      });
    });

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
      INSERT INTO targets (id, name, host, probe_type, interval, status, group_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [target.id, target.name, target.host, target.probeType, target.interval, target.status, target.group || '', now, now], function(err) {
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
    database.all('SELECT * FROM targets ORDER BY name', [], (err, rows) => {
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
      resolve(true);
    });
  });
}

/**
 * Delete a target and all its measurements
 */
export async function deleteTarget(id: string): Promise<boolean> {
  const database = await getDatabase();
  
  return new Promise<boolean>((resolve, reject) => {
    database.run('DELETE FROM targets WHERE id = ?', [id], function(err) {
      if (err) {
        reject(err);
        return;
      }
      saveDatabase();
      resolve(true);
    });
  });
}

export async function storeMeasurement(measurement: ProbeMeasurement & { packetLoss?: number }): Promise<void> {
  const database = await getDatabase();
  
  return new Promise<void>((resolve, reject) => {
    database.run(`
      INSERT INTO measurements (id, target_id, timestamp, latency, packet_loss, jitter, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      measurement.id,
      measurement.targetId,
      measurement.timestamp.getTime(),
      measurement.latency,
      measurement.packetLoss || 0,
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
        INSERT INTO measurements (id, target_id, timestamp, latency, packet_loss, jitter, success, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        item.id,
        item.targetId,
        item.timestamp.getTime(),
        item.latency,
        item.packetLoss || 0,
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
 * Get target statistics for a time range
 */
export async function getTargetStatistics(
  targetId: string,
  startTime: Date,
  endTime: Date
): Promise<TargetStatistics | null> {
  const database = await getDatabase();

  return new Promise((resolve, reject) => {
    database.get(`
      SELECT 
        COUNT(*) as total,
        AVG(latency) as avg_latency,
        MIN(latency) as min_latency,
        MAX(latency) as max_latency,
        AVG(jitter) as avg_jitter,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
        MAX(timestamp) as last_probe
      FROM measurements
      WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
    `, [targetId, startTime.getTime(), endTime.getTime()], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!row) {
        resolve(null);
        return;
      }

      const r = row as StatisticsRow;
      const total = r.total;
      
      if (total === 0) {
        resolve(null);
        return;
      }

      const avgLatency = r.avg_latency || 0;
      const minLatency = r.min_latency || 0;
      const maxLatency = r.max_latency || 0;
      const avgJitter = r.avg_jitter || 0;
      const failures = r.failures;
      const lastProbe = r.last_probe;

      const packetLoss = (failures / total) * 100;
      const uptime = 100 - packetLoss;

      resolve({
        targetId,
        avgLatency,
        minLatency,
        maxLatency,
        packetLoss,
        uptime,
        lastProbe: new Date(lastProbe),
        jitter: avgJitter,
      });
    });
  });
}

/**
 * Get latest packet loss for all targets
 */
export async function getLatestPacketLossForAllTargets(): Promise<Record<string, number>> {
  const database = await getDatabase();
  
  return new Promise((resolve, reject) => {
    database.all(`
      SELECT target_id, packet_loss
      FROM measurements
      WHERE (target_id, timestamp) IN (
        SELECT target_id, MAX(timestamp)
        FROM measurements
        GROUP BY target_id
      )
    `, [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!rows || rows.length === 0) {
        resolve({});
        return;
      }

      const packetLossMap: Record<string, number> = {};
      rows.forEach((row) => {
        const r = row as { target_id: string; packet_loss: number };
        packetLossMap[r.target_id] = r.packet_loss;
      });

      resolve(packetLossMap);
    });
  });
}

/**
 * Clean up old measurements (data retention)
 */
export async function cleanOldMeasurements(daysToKeep: number = 30): Promise<void> {
  const database = await getDatabase();
  const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  return new Promise<void>((resolve, reject) => {
    database.run('DELETE FROM measurements WHERE timestamp < ?', [cutoffTime], function(err) {
      if (err) {
        reject(err);
        return;
      }
      saveDatabase();
      resolve();
    });
  });
}
