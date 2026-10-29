import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-maintenance-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile
process.env.CLEARPING_RETENTION_DAYS = '30'

const { initDatabase, closeDatabase, getDatabase, createTarget } = await import('./database')
const {
  runMaintenance,
  getMaintenanceHistory,
  getMaintenanceSettings,
  saveMaintenanceSettings,
  parseMaintenanceSettings,
  nextRunAfter,
  nextScheduledRun,
} = await import('./maintenance')

async function exec(sql: string, params: unknown[] = []): Promise<void> {
  const db = await getDatabase()
  await new Promise<void>((resolve, reject) => db.run(sql, params, err => (err ? reject(err) : resolve())))
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const db = await getDatabase()
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(Object.values(row as Record<string, number>)[0])))
  )
}

async function addTarget(id: string, group?: string) {
  await createTarget({ id, name: id, host: `${id}.example`, probeType: 'ping', interval: 60, status: 'active', group })
}

async function addMeasurement(id: string, targetId: string, timestamp: number) {
  await exec('INSERT INTO measurements (id, target_id, timestamp, latency, success) VALUES (?, ?, ?, 5, 1)', [id, targetId, timestamp])
}

beforeAll(async () => {
  await initDatabase()
})

afterAll(async () => {
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

const step = (report: Awaited<ReturnType<typeof runMaintenance>>, id: string) => report!.steps.find(item => item.id === id)!

describe('a run', () => {
  it('leaves a database that is in order as it was, and reports no problems', async () => {
    await addTarget('fine', 'Home')
    await addMeasurement('m-fine', 'fine', Date.now())

    const report = await runMaintenance('manual')

    expect(report!.ok).toBe(true)
    expect(report!.removed).toBe(0)
    expect(await count('SELECT COUNT(*) FROM measurements')).toBe(1)
    expect(report!.steps.map(item => item.id)).toEqual([
      'integrity', 'measurements', 'traceroutes', 'alerts', 'groups', 'clock', 'retention', 'database', 'scheduler',
    ])
  })

  it('removes history and saved routes left behind by targets that are gone', async () => {
    // What a delete with foreign keys off, or a killed one, leaves.
    await exec('PRAGMA foreign_keys = OFF')
    await addMeasurement('ghost-1', 'ghost', Date.now())
    await addMeasurement('ghost-2', 'ghost', Date.now() - 1000)
    await addMeasurement('ghost-3', 'other-ghost', Date.now())
    await exec(
      `INSERT INTO traceroutes (id, target_id, timestamp, trigger_source, address, hops, reached) VALUES ('t1', 'ghost', ?, 'manual', '1.1.1.1', '[]', 0)`,
      [Date.now()]
    )
    await exec('PRAGMA foreign_keys = ON')

    const report = await runMaintenance('manual')

    expect(step(report, 'measurements').removed).toBe(3)
    expect(step(report, 'traceroutes').removed).toBe(1)
    expect(await count(`SELECT COUNT(*) FROM measurements WHERE target_id IN ('ghost', 'other-ghost')`)).toBe(0)
    // The real target's history is untouched.
    expect(await count(`SELECT COUNT(*) FROM measurements WHERE target_id = 'fine'`)).toBe(1)
  })

  it('removes alert ticks that point at nothing', async () => {
    await exec('PRAGMA foreign_keys = OFF')
    await exec(`INSERT INTO alerts (id, name, metric, threshold, consecutive_probes, enabled, created_at) VALUES ('a1', 'x', 'packetLoss', 5, 3, 1, 0)`)
    await exec(`INSERT INTO alert_targets (alert_id, target_id) VALUES ('a1', 'fine'), ('a1', 'ghost'), ('missing-alert', 'fine')`)
    await exec('PRAGMA foreign_keys = ON')

    const report = await runMaintenance('manual')

    expect(step(report, 'alerts').removed).toBe(2)
    expect(await count('SELECT COUNT(*) FROM alert_targets')).toBe(1)
  })

  it('puts back a group a target is in, and the ones above it, and drops saved positions of groups that are gone', async () => {
    await addTarget('nested', 'Lab/Rack/Top')
    await exec(`DELETE FROM target_groups WHERE group_name IN ('Lab', 'Lab/Rack', 'Lab/Rack/Top')`)
    await exec(`INSERT OR REPLACE INTO group_orders (group_name, sort_order) VALUES ('Vanished', 3), ('Home', 1)`)

    const report = await runMaintenance('manual')

    expect(step(report, 'groups').status).toBe('fixed')
    expect(await count(`SELECT COUNT(*) FROM target_groups WHERE group_name IN ('Lab', 'Lab/Rack', 'Lab/Rack/Top')`)).toBe(3)
    expect(await count(`SELECT COUNT(*) FROM group_orders WHERE group_name = 'Vanished'`)).toBe(0)
    expect(await count(`SELECT COUNT(*) FROM group_orders WHERE group_name = 'Home'`)).toBe(1)
  })

  it('leaves an empty group somebody made', async () => {
    await exec(`INSERT OR IGNORE INTO target_groups (group_name) VALUES ('Planned')`)
    await runMaintenance('manual')
    expect(await count(`SELECT COUNT(*) FROM target_groups WHERE group_name = 'Planned'`)).toBe(1)
  })

  it('makes a target marked as probed in the future due again', async () => {
    await exec('UPDATE targets SET last_probe_at = ? WHERE id = ?', [Date.now() + 24 * 60 * 60 * 1000, 'fine'])
    const report = await runMaintenance('manual')
    expect(step(report, 'clock').status).toBe('fixed')
    expect(await count(`SELECT last_probe_at FROM targets WHERE id = 'fine'`)).toBe(0)
  })

  it('removes measurements past the retention window and keeps the rest', async () => {
    await addMeasurement('old', 'fine', Date.now() - 40 * 24 * 60 * 60 * 1000)
    await addMeasurement('recent', 'fine', Date.now() - 5 * 24 * 60 * 60 * 1000)

    const report = await runMaintenance('manual')

    expect(step(report, 'retention').removed).toBe(1)
    expect(await count(`SELECT COUNT(*) FROM measurements WHERE id = 'old'`)).toBe(0)
    expect(await count(`SELECT COUNT(*) FROM measurements WHERE id = 'recent'`)).toBe(1)
  })

  it('does not run twice at once', async () => {
    const [first, second] = await Promise.all([runMaintenance('manual'), runMaintenance('manual')])
    expect([first, second].filter(report => report === null)).toHaveLength(1)
  })

  it('keeps the last ten runs, newest first', async () => {
    for (let i = 0; i < 12; i++) await runMaintenance('schedule')
    const history = await getMaintenanceHistory()
    expect(history).toHaveLength(10)
    expect(history[0].startedAt).toBeGreaterThanOrEqual(history[1].startedAt)
  })
})

describe('the settings', () => {
  const valid = { enabled: true, frequency: 'weekly', hour: 4, weekday: 2, alertId: null, notify: 'problems', reclaimSpace: false }

  it('start with a run every Sunday at three', async () => {
    expect(await getMaintenanceSettings()).toMatchObject({ enabled: true, frequency: 'weekly', weekday: 0, hour: 3 })
    expect(await nextScheduledRun()).not.toBeNull()
  })

  it('are saved and read back', async () => {
    const parsed = parseMaintenanceSettings(valid)
    if (!parsed.ok) throw new Error(parsed.error)
    await saveMaintenanceSettings(parsed.settings)
    expect(await getMaintenanceSettings()).toMatchObject(valid)
    expect(await nextScheduledRun()).not.toBeNull()
  })

  it.each([
    [{ ...valid, enabled: 'yes' }],
    [{ ...valid, frequency: 'hourly' }],
    [{ ...valid, hour: 24 }],
    [{ ...valid, hour: 1.5 }],
    [{ ...valid, weekday: 7 }],
    [{ ...valid, alertId: 5 }],
    [{ ...valid, notify: 'sometimes' }],
    [{ ...valid, reclaimSpace: 1 }],
    [null],
  ])('refuse %j', input => {
    expect(parseMaintenanceSettings(input).ok).toBe(false)
  })
})

describe('when it is next due', () => {
  const at = (iso: string) => new Date(iso).getTime()

  // 10 March 2026 is a Tuesday.
  it('is the same hour the next day for a daily run', () => {
    const next = nextRunAfter(at('2026-03-10T03:00:30'), { frequency: 'daily', hour: 3, weekday: 0 })
    expect(new Date(next).getDate()).toBe(11)
    expect(new Date(next).getHours()).toBe(3)
  })

  it('is the next of the day chosen for a weekly one', () => {
    const next = nextRunAfter(at('2026-03-10T09:00:00'), { frequency: 'weekly', hour: 3, weekday: 0 })
    expect(new Date(next).getDate()).toBe(15)
    expect(new Date(next).getHours()).toBe(3)
  })

  it('is later the same day when the hour has not come yet', () => {
    const next = nextRunAfter(at('2026-03-10T01:00:00'), { frequency: 'weekly', hour: 3, weekday: 2 })
    expect(new Date(next).getDate()).toBe(10)
  })

  it('is the first of the day chosen in the next month for a monthly one', () => {
    const next = new Date(nextRunAfter(at('2026-03-10T09:00:00'), { frequency: 'monthly', hour: 3, weekday: 0 }))
    expect([next.getMonth(), next.getDate()]).toEqual([3, 5])
  })
})
