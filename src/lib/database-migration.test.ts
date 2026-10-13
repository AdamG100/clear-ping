import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sqlite3 from 'sqlite3'

/**
 * Upgrading a database left behind by an old version, which is what every
 * container does the first time it starts on a new image.
 *
 * The file below is in the oldest shape there is: before TCP and HTTP probes,
 * before nested groups, and with alerts still set one target at a time.
 * Opening it has to bring it all the way up to date with nothing lost.
 *
 * `targets.probe_type` used to carry a CHECK constraint listing its allowed
 * values, and SQLite cannot alter a CHECK, so that table is rebuilt. The
 * rebuild drops and recreates a table that every measurement points at, which
 * makes it the one step capable of destroying history if it is done
 * carelessly.
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
  INSERT INTO targets VALUES ('old-lab', 'Pi', '192.0.2.7', 'ping', 60, 'active', ' Home / Lab ', 1000, 2000, 0);
  INSERT INTO measurements VALUES ('m1', 'old-ping', 5000, 12.5, 0, 1, NULL);
  INSERT INTO measurements VALUES ('m2', 'old-ping', 6000, NULL, 100, 0, 'Request timed out.');
  INSERT INTO measurements VALUES ('m3', 'old-dns', 7000, 4, 0, 1, NULL);
  INSERT INTO alert_rules VALUES ('r1', 'old-ping', 'packetLoss', 5, 3, 'https://hooks.example/x', 1, 'firing', 2, 111, NULL, 999);
  INSERT INTO alert_rules VALUES ('r2', 'old-dns', 'packetLoss', 5, 3, 'https://hooks.example/x', 1, 'ok', 1, NULL, 222, 1500);
  INSERT INTO alert_rules VALUES ('r3', 'old-dns', 'latency', 200, 3, NULL, 0, 'ok', 0, NULL, NULL, 1600);
  INSERT INTO alert_rules VALUES ('r4', 'old-lab', 'unreachable', 0, 3, 'https://discord.com/api/webhooks/123456789012345678/tok-EN_1', 1, 'ok', 0, NULL, NULL, 1700);
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
const { SCHEMA_VERSION, legacyNotifyUrls } = await import('./migrations')

function all<T>(sql: string): Promise<T[]> {
  return database.getDatabase().then(
    db => new Promise<T[]>((resolve, reject) => db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows as T[]))))
  )
}

beforeAll(async () => {
  await database.initDatabase()
})

afterAll(async () => {
  await database.closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('opening a database left by an old version', () => {
  it('keeps every target, with its settings', async () => {
    const targets = (await database.getAllTargets()).sort((a, b) => a.id.localeCompare(b.id))
    expect(targets.map(t => [t.id, t.name, t.host, t.probeType, t.interval, t.status, t.group])).toEqual([
      ['old-dns', 'Resolver', '192.0.2.53', 'dns', 60, 'paused', ''],
      // A group name with a slash in it is now a group inside a group, and
      // is stored the one way such a path is written.
      ['old-lab', 'Pi', '192.0.2.7', 'ping', 60, 'active', 'Home/Lab'],
      ['old-ping', 'Router', '192.0.2.1', 'ping', 300, 'active', 'LAN'],
    ])
    expect(targets[2].createdAt.getTime()).toBe(1000)
    expect(targets[2].ipVersion).toBe('auto')
  })

  it('enters every group in use, and the groups those sit inside, as a group in its own right', async () => {
    expect(await database.getGroups()).toEqual(['Home', 'Home/Lab', 'LAN'])
  })

  it('records how far the database has been brought', async () => {
    expect(await all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }])
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

  it('turns rules set per target into alerts, one for each distinct rule', async () => {
    const migrated = await alerts.getAlerts()
    expect(migrated).toHaveLength(3)

    // The same rule on two targets is one alert ticked for both.
    const loss = migrated.find(alert => alert.metric === 'packetLoss')!
    expect(loss).toMatchObject({ threshold: 5, consecutiveProbes: 3, enabled: true })
    expect(loss.createdAt.getTime()).toBe(999)
    expect(loss.targets.map(entry => entry.targetId).sort()).toEqual(['old-dns', 'old-ping'])

    const muted = migrated.find(alert => alert.metric === 'latency')!
    expect(muted).toMatchObject({ threshold: 200, enabled: false })
    expect(muted.targets.map(entry => entry.targetId)).toEqual(['old-dns'])
  })

  it('gives each alert the Apprise URL that reaches where it was already sent', async () => {
    const migrated = await alerts.getAlerts()
    const urlsOf = (metric: string) => migrated.find(alert => alert.metric === metric)!.notifyUrls

    // A webhook becomes Apprise's JSON service, and a Discord webhook Discord's
    // own, posted as the embed it used to be.
    expect(urlsOf('packetLoss')).toEqual(['jsons://hooks.example/x?format=text'])
    expect(urlsOf('unreachable')).toEqual(['discord://123456789012345678/tok-EN_1/?format=markdown'])
    // One that was sent nowhere still is.
    expect(urlsOf('latency')).toEqual([])
  })

  it('leaves what an older version would send by where it would look for it', async () => {
    expect(await all('SELECT destination, webhook_url FROM alerts ORDER BY created_at')).toEqual([
      { destination: 'webhook', webhook_url: 'https://hooks.example/x' },
      { destination: 'none', webhook_url: null },
      { destination: 'discord', webhook_url: 'https://discord.com/api/webhooks/123456789012345678/tok-EN_1' },
    ])
  })

  it('keeps each target’s state, so a rule that was firing does not fire again', async () => {
    const [firing] = await alerts.getAlertRules('old-ping')
    expect(firing).toMatchObject({ metric: 'packetLoss', state: 'firing', streak: 2 })
    expect(firing.lastFiredAt?.getTime()).toBe(111)

    const quiet = (await alerts.getAlertRules('old-dns')).find(rule => rule.metric === 'packetLoss')!
    expect(quiet).toMatchObject({ state: 'ok', streak: 1 })
    expect(quiet.lastResolvedAt?.getTime()).toBe(222)
  })

  it('leaves the old rules where an older version would look for them', async () => {
    expect(await all('SELECT id FROM alert_rules ORDER BY id')).toEqual([
      { id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' },
    ])
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

    const alert = await alerts.createAlert({
      metric: 'certExpiry',
      threshold: 14,
      consecutiveProbes: 1,
      notifyUrls: [],
      targetIds: ['new-http'],
    })
    expect(alert.metric).toBe('certExpiry')
    expect(alert.targets.map(entry => entry.targetId)).toEqual(['new-http'])
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
    const before = await alerts.getAlerts()

    await database.closeDatabase()
    await database.initDatabase()

    expect(fs.readdirSync(dir).filter(name => name.includes('.before-probe-types-'))).toHaveLength(1)
    expect((await database.getAllTargets()).map(t => t.id).sort()).toEqual(['new-tcp', 'old-dns', 'old-lab', 'old-ping'])
    // In particular, the old rules are not turned into alerts a second time.
    expect(await alerts.getAlerts()).toEqual(before)
    expect(await all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }])
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

describe('the Apprise URL for where an alert used to be sent', () => {
  const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/tok-EN_1'
  const ROLE = '111111111111111111'
  const USER = '222222222222222222'

  it('keeps a Discord alert an embed, mentioning who it mentioned', () => {
    expect(legacyNotifyUrls('discord', DISCORD)).toEqual(['discord://123456789012345678/tok-EN_1/?format=markdown'])

    const [url] = legacyNotifyUrls('discord', DISCORD, [ROLE], [USER])
    expect(new URL(url).searchParams.get('ping')).toBe(`<@&${ROLE}>,<@${USER}>`)
    expect(url.startsWith('discord://123456789012345678/tok-EN_1/?format=markdown&ping=')).toBe(true)
  })

  it('finds the webhook on any of Discord’s hosts and API versions, and keeps its thread', () => {
    expect(legacyNotifyUrls('discord', 'https://canary.discord.com/api/v10/webhooks/123/abc?wait=true&thread_id=99'))
      .toEqual(['discord://123/abc/?format=markdown&thread=99'])
    // The Slack-compatible endpoint of a Discord webhook was sent plain text.
    expect(legacyNotifyUrls('webhook', `${DISCORD}/slack`)).toEqual(['discord://123456789012345678/tok-EN_1/'])
  })

  it('turns any other address into Apprise’s JSON service, query and login included', () => {
    expect(legacyNotifyUrls('webhook', 'https://hooks.example.com/a/b')).toEqual([
      'jsons://hooks.example.com/a/b?format=text',
    ])
    expect(legacyNotifyUrls('webhook', 'http://user:pass@10.0.0.5:8080/hook?token=abc&format=x')).toEqual([
      'json://user:pass@10.0.0.5:8080/hook?-token=abc&-format=x&format=text',
    ])
    // Set to Discord but pointed at something else: all that can be sent there is JSON.
    expect(legacyNotifyUrls('discord', 'https://relay.example.com/x')).toEqual(['jsons://relay.example.com/x?format=text'])
  })

  it('leaves a Slack webhook as it is, since Apprise knows it by that address', () => {
    const slack = 'https://hooks.slack.com/services/T000/B000/XXXX'
    expect(legacyNotifyUrls('webhook', slack)).toEqual([slack])
  })

  it('gives an alert that was sent nowhere no URLs', () => {
    expect(legacyNotifyUrls('none', DISCORD)).toEqual([])
    expect(legacyNotifyUrls('webhook', null)).toEqual([])
    expect(legacyNotifyUrls('webhook', '')).toEqual([])
  })
})
