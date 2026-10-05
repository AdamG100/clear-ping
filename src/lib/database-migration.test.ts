import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sqlite3 from 'sqlite3'

/**
 * Upgrading a database created before TCP and HTTP probes existed.
 *
 * `targets.probe_type` and `alert_rules.metric` used to carry CHECK
 * constraints listing their allowed values, and SQLite cannot alter a CHECK,
 * so both tables are rebuilt. The rebuild drops and recreates a table that
 * every measurement points at, which makes it the one migration capable of
 * destroying history if it is done carelessly. These tests start from a real
 * old-format file and assert that nothing is lost.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-migrate-'))
const dbFile = path.join(dir, 'legacy.db')
process.env.CLEARPING_DB_PATH = dbFile

const LEGACY_SCHEMA = `
  CREATE TABLE targets (
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
  );
  CREATE TABLE measurements (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    latency REAL,
    packet_loss REAL DEFAULT 0,
    success INTEGER NOT NULL,
    error_message TEXT,
    FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
  );
  CREATE TABLE alert_rules (
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
  );
  CREATE INDEX idx_alert_rules_target ON alert_rules(target_id);

  INSERT INTO targets VALUES ('old-ping', 'Router', '192.0.2.1', 'ping', 300, 'active', 'LAN', 1000, 2000, 3000);
  INSERT INTO targets VALUES ('old-dns', 'Resolver', '192.0.2.53', 'dns', 60, 'paused', '', 1000, 2000, 0);
  INSERT INTO measurements VALUES ('m1', 'old-ping', 5000, 12.5, 0, 1, NULL);
  INSERT INTO measurements VALUES ('m2', 'old-ping', 6000, NULL, 100, 0, 'Request timed out.');
  INSERT INTO measurements VALUES ('m3', 'old-dns', 7000, 4, 0, 1, NULL);
  INSERT INTO alert_rules VALUES ('r1', 'old-ping', 'packetLoss', 5, 3, 'https://hooks.example/x', 1, 'firing', 2, 111, NULL, 999);
`

function execFile(file: string, sql: string) {
  return new Promise<void>((resolve, reject) => {
    const handle = new sqlite3.Database(file)
    handle.exec(sql, err => handle.close(() => (err ? reject(err) : resolve())))
  })
}

// Written before the module is imported: it opens the file on first use.
await execFile(dbFile, LEGACY_SCHEMA)

const database = await import('./database')
const alerts = await import('./alerts')

function all<T>(sql: string): Promise<T[]> {
  return database.getDatabase().then(
    db => new Promise<T[]>((resolve, reject) => db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows as T[]))))
  )
}

beforeAll(async () => {
  await database.initDatabase()
  await alerts.ensureAlertSchema()
})

afterAll(async () => {
  await database.closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('migrating a database from before new probe types', () => {
  it('keeps every target, with its settings', async () => {
    const targets = (await database.getAllTargets()).sort((a, b) => a.id.localeCompare(b.id))
    expect(targets.map(t => [t.id, t.name, t.host, t.probeType, t.interval, t.status, t.group])).toEqual([
      ['old-dns', 'Resolver', '192.0.2.53', 'dns', 60, 'paused', ''],
      ['old-ping', 'Router', '192.0.2.1', 'ping', 300, 'active', 'LAN'],
    ])
    expect(targets[1].createdAt.getTime()).toBe(1000)
    expect(targets[1].ipVersion).toBe('auto')
  })

  it('keeps the measurement history the rebuilt table is referenced by', async () => {
    // The failure this guards against: dropping `targets` with foreign keys on
    // cascades into `measurements` and silently deletes all of it.
    const rows = await all<{ id: string; target_id: string; latency: number | null }>(
      'SELECT id, target_id, latency FROM measurements ORDER BY id'
    )
    expect(rows).toEqual([
      { id: 'm1', target_id: 'old-ping', latency: 12.5 },
      { id: 'm2', target_id: 'old-ping', latency: null },
      { id: 'm3', target_id: 'old-dns', latency: 4 },
    ])
  })

  it('keeps alert rules, including a rule that was firing', async () => {
    const [rule] = await alerts.getAlertRules('old-ping')
    expect(rule).toMatchObject({
      id: 'r1',
      metric: 'packetLoss',
      threshold: 5,
      webhookUrl: 'https://hooks.example/x',
      state: 'firing',
      streak: 2,
    })
    expect(rule.lastFiredAt?.getTime()).toBe(111)
  })

  it('leaves no dangling references and turns foreign keys back on', async () => {
    expect(await all('PRAGMA foreign_key_check')).toEqual([])
    expect(await all('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
  })

  it('accepts the probe types and alert metrics the old schema rejected', async () => {
    await database.createTarget({
      id: 'new-tcp',
      name: 'Postgres',
      host: 'db.example',
      probeType: 'tcp',
      interval: 60,
      status: 'active',
      probeConfig: { port: 5432 },
    })
    await database.createTarget({
      id: 'new-http',
      name: 'Site',
      host: 'example.com',
      probeType: 'http',
      interval: 60,
      status: 'active',
      probeConfig: { scheme: 'https', path: '/health', expectedStatus: 200 },
    })

    expect((await database.getTargetById('new-tcp'))?.probeConfig).toEqual({ port: 5432 })
    expect((await database.getTargetById('new-http'))?.probeConfig).toEqual({
      scheme: 'https',
      path: '/health',
      expectedStatus: 200,
    })

    const rule = await alerts.createAlertRule({
      targetId: 'new-http',
      metric: 'certExpiry',
      threshold: 14,
      consecutiveProbes: 1,
    })
    expect(rule.metric).toBe('certExpiry')
  })

  it('still cascades when a target is deleted', async () => {
    await database.deleteTarget('new-http')
    expect(await alerts.getAlertRules('new-http')).toEqual([])
  })

  it('takes a snapshot of the old file before rewriting it', () => {
    const backups = fs.readdirSync(dir).filter(name => name.includes('.before-probe-types-'))
    expect(backups).toHaveLength(1)
  })

  it('does nothing on the next start', async () => {
    await database.closeDatabase()
    await database.initDatabase()
    await alerts.ensureAlertSchema()

    expect(fs.readdirSync(dir).filter(name => name.includes('.before-probe-types-'))).toHaveLength(1)
    expect((await database.getAllTargets()).map(t => t.id).sort()).toEqual(['new-tcp', 'old-dns', 'old-ping'])
  })

  it('stores and returns probe settings and details', async () => {
    await database.updateTarget('new-tcp', { probeConfig: { port: 6432 } })
    expect((await database.getTargetById('new-tcp'))?.probeConfig).toEqual({ port: 6432 })

    await database.storeMeasurement({
      id: 'm-details',
      targetId: 'new-tcp',
      timestamp: new Date(9000),
      latency: 20,
      packetLoss: 0,
      jitter: 1,
      success: true,
      details: { statusCode: 200, certExpiresAt: 123456 },
    })
    const latest = await database.getLatestMeasurementForAllTargets()
    expect(latest['new-tcp'].details).toEqual({ statusCode: 200, certExpiresAt: 123456 })
  })
})
