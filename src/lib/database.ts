import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { Target, ProbeMeasurement, TargetStatistics } from '@/types/probe';

let db: SqlJsDatabase | null = null;
let dbInitPromise: Promise<SqlJsDatabase> | null = null;

/**
 * Initialize the SQLite database and create tables
 */
export async function initDatabase(): Promise<SqlJsDatabase> {
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
    
    // Initialize SQL.js with WASM file from public directory
    const wasmPath = path.join(process.cwd(), 'public', 'sql-wasm.wasm');
    const SQL = await initSqlJs({
      wasmBinary: fs.readFileSync(wasmPath) as unknown as ArrayBuffer
    });
    
    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    // Create tables
    db.run(`
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
    `);

    // Add last_probe_at column if it doesn't exist (for existing databases)
    try {
      db.run(`ALTER TABLE targets ADD COLUMN last_probe_at INTEGER DEFAULT 0`);
    } catch (error) {
      // Column already exists, ignore error
    }

    // Add group_name column if it doesn't exist (for existing databases)
    try {
      db.run(`ALTER TABLE targets ADD COLUMN group_name TEXT`);
    } catch (error) {
      // Column already exists, ignore error
    }

    // Add packet_loss column to measurements if it doesn't exist (for existing databases)
    try {
      db.run(`ALTER TABLE measurements ADD COLUMN packet_loss REAL DEFAULT 0`);
    } catch (error) {
      // Column already exists, ignore error
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS measurements (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        latency REAL,
        packet_loss REAL DEFAULT 0,
        success INTEGER NOT NULL,
        error_message TEXT,
        FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_measurements_target_timestamp 
            ON measurements(target_id, timestamp DESC)`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_measurements_timestamp 
            ON measurements(timestamp DESC)`);

    return db;
  })();

  return dbInitPromise;
}

/**
 * Save database to disk
 */
function saveDatabase() {
  if (!db) return;
  
  const dataDir = path.join(process.cwd(), 'data');
  const dbPath = path.join(dataDir, 'clearping.db');
  const data = db.export();
  fs.writeFileSync(dbPath, data);
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
export async function getDatabase(): Promise<SqlJsDatabase> {
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

  database.run(`
    INSERT INTO targets (id, name, host, probe_type, interval, status, group_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [target.id, target.name, target.host, target.probeType, target.interval, target.status, target.group || '', now, now]);

  saveDatabase();

  return {
    ...target,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Get all targets
 */
export async function getAllTargets(): Promise<Target[]> {
  const database = await getDatabase();
  const result = database.exec('SELECT * FROM targets ORDER BY name');
  
  if (!result.length || !result[0].values.length) return [];

  const columns = result[0].columns;
  return result[0].values.map(row => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    
    return {
      id: obj.id as string,
      name: obj.name as string,
      host: obj.host as string,
      probeType: obj.probe_type as 'ping' | 'dns',
      interval: obj.interval as number,
      status: obj.status as 'active' | 'paused' | 'error',
      group: obj.group_name as string | undefined,
      createdAt: new Date(obj.created_at as number),
      updatedAt: new Date(obj.updated_at as number),
    };
  });
}

/**
 * Get a single target by ID
 */
export async function getTargetById(id: string): Promise<Target | null> {
  const database = await getDatabase();
  const result = database.exec('SELECT * FROM targets WHERE id = ?', [id]);

  if (!result.length || !result[0].values.length) return null;

  const columns = result[0].columns;
  const row = result[0].values[0];
  const obj: Record<string, unknown> = {};
  columns.forEach((col, idx) => {
    obj[col] = row[idx];
  });

  return {
    id: obj.id as string,
    name: obj.name as string,
    host: obj.host as string,
    probeType: obj.probe_type as 'ping' | 'dns',
    interval: obj.interval as number,
    status: obj.status as 'active' | 'paused' | 'error',
    group: obj.group_name as string | undefined,
    createdAt: new Date(obj.created_at as number),
    updatedAt: new Date(obj.updated_at as number),
  };
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

  database.run(`UPDATE targets SET ${fields.join(', ')} WHERE id = ?`, values);
  saveDatabase();

  return true;
}

/**
 * Delete a target and all its measurements
 */
export async function deleteTarget(id: string): Promise<boolean> {
  const database = await getDatabase();
  database.run('DELETE FROM targets WHERE id = ?', [id]);
  saveDatabase();
  return true;
}

export async function storeMeasurement(measurement: ProbeMeasurement & { packetLoss?: number }): Promise<void> {
  const database = await getDatabase();
  
  database.run(`
    INSERT INTO measurements (id, target_id, timestamp, latency, packet_loss, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    measurement.id,
    measurement.targetId,
    measurement.timestamp.getTime(),
    measurement.latency,
    measurement.packetLoss || 0,
    measurement.success ? 1 : 0,
    measurement.errorMessage || null
  ]);

  saveDatabase();
}

/**
 * Store multiple measurements
 */
export async function storeMeasurements(measurements: ProbeMeasurement[]): Promise<void> {
  const database = await getDatabase();
  
  for (const item of measurements) {
    database.run(`
      INSERT INTO measurements (id, target_id, timestamp, latency, packet_loss, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      item.id,
      item.targetId,
      item.timestamp.getTime(),
      item.latency,
      item.packetLoss || 0,
      item.success ? 1 : 0,
      item.errorMessage || null
    ]);
  }

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
  
  const result = database.exec(`
    SELECT * FROM measurements
    WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `, [targetId, startTime.getTime(), endTime.getTime()]);

  if (!result.length || !result[0].values.length) return [];

  const columns = result[0].columns;
  return result[0].values.map(row => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    
    return {
      id: obj.id as string,
      targetId: obj.target_id as string,
      timestamp: new Date(obj.timestamp as number),
      latency: obj.latency as number | null,
      packetLoss: obj.packet_loss as number || 0,
      success: obj.success === 1,
      errorMessage: obj.error_message as string | undefined,
    };
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

  const result = database.exec(`
    SELECT 
      COUNT(*) as total,
      AVG(latency) as avg_latency,
      MIN(latency) as min_latency,
      MAX(latency) as max_latency,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
      MAX(timestamp) as last_probe
    FROM measurements
    WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
  `, [targetId, startTime.getTime(), endTime.getTime()]);

  if (!result.length || !result[0].values.length) return null;

  const row = result[0].values[0];
  const total = row[0] as number;
  
  if (total === 0) return null;

  const avgLatency = row[1] as number || 0;
  const minLatency = row[2] as number || 0;
  const maxLatency = row[3] as number || 0;
  const failures = row[4] as number;
  const lastProbe = row[5] as number;

  const packetLoss = (failures / total) * 100;
  const uptime = 100 - packetLoss;

  return {
    targetId,
    avgLatency,
    minLatency,
    maxLatency,
    packetLoss,
    uptime,
    lastProbe: new Date(lastProbe),
  };
}

/**
 * Get latest packet loss for all targets
 */
export async function getLatestPacketLossForAllTargets(): Promise<Record<string, number>> {
  const database = await getDatabase();
  const result = database.exec(`
    SELECT target_id, packet_loss
    FROM measurements
    WHERE (target_id, timestamp) IN (
      SELECT target_id, MAX(timestamp)
      FROM measurements
      GROUP BY target_id
    )
  `);

  if (!result.length || !result[0].values.length) return {};

  const packetLossMap: Record<string, number> = {};
  result[0].values.forEach(row => {
    packetLossMap[row[0] as string] = row[1] as number;
  });

  return packetLossMap;
}

/**
 * Clean up old measurements (data retention)
 */
export async function cleanOldMeasurements(daysToKeep: number = 30): Promise<number> {
  const database = await getDatabase();
  const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  database.run('DELETE FROM measurements WHERE timestamp < ?', [cutoffTime]);
  saveDatabase();
  
  return database.getRowsModified();
}
