import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-test-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

// Imported after the env var is set: the module resolves its path on first use.
const {
  initDatabase,
  createTarget,
  deleteTarget,
  updateTarget,
  storeMeasurement,
  getTargetStatistics,
  getLatestMeasurementForAllTargets,
  getBucketedMeasurements,
  cleanOldMeasurements,
  getMeasurements,
  closeDatabase,
} = await import('./database')

const TARGET = 'target-under-test'
const base = Date.parse('2026-08-19T12:00:00.000Z')

async function measure(
  offsetMinutes: number,
  fields: { latency: number | null; packetLoss: number; success: boolean; jitter?: number | null }
) {
  await storeMeasurement({
    id: `m-${offsetMinutes}-${Math.random()}`,
    targetId: TARGET,
    timestamp: new Date(base + offsetMinutes * 60_000),
    latency: fields.latency,
    packetLoss: fields.packetLoss,
    jitter: fields.jitter ?? 1,
    success: fields.success,
  })
}

beforeAll(async () => {
  await initDatabase()
  await createTarget({
    id: TARGET,
    name: 'Test',
    host: '198.51.100.1',
    probeType: 'ping',
    interval: 300,
    status: 'active',
  })
})

afterAll(async () => {
  // Windows keeps the file locked until the handle is closed.
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('getTargetStatistics', () => {
  it('separates packet loss from uptime', async () => {
    // Every probe got a reply, so uptime is 100% — but half the packets were
    // dropped. Reporting loss as "failed probes / total probes" scored this
    // degraded path as a flawless 0%.
    await measure(0, { latency: 10, packetLoss: 0, success: true })
    await measure(5, { latency: 12, packetLoss: 75, success: true })
    await measure(10, { latency: 11, packetLoss: 25, success: true })

    const stats = await getTargetStatistics(TARGET, new Date(base - 60_000), new Date(base + 60 * 60_000))

    expect(stats).not.toBeNull()
    expect(stats!.uptime).toBe(100)
    expect(stats!.packetLoss).toBeCloseTo((0 + 75 + 25) / 3, 5)
    expect(stats!.maxPacketLoss).toBe(75)
    expect(stats!.minPacketLoss).toBe(0)
  })

  it('reports a true median, not the midrange', async () => {
    const stats = await getTargetStatistics(TARGET, new Date(base - 60_000), new Date(base + 60 * 60_000))
    expect(stats!.medianLatency).toBe(11)
  })

  it('returns null when the window holds no probes', async () => {
    const stats = await getTargetStatistics(TARGET, new Date(base - 86_400_000), new Date(base - 80_000_000))
    expect(stats).toBeNull()
  })

  it('counts a fully failed probe against uptime', async () => {
    await measure(15, { latency: null, packetLoss: 100, success: false })
    const stats = await getTargetStatistics(TARGET, new Date(base - 60_000), new Date(base + 60 * 60_000))
    expect(stats!.sampleCount).toBe(4)
    expect(stats!.uptime).toBe(75)
  })
})

describe('getBucketedMeasurements', () => {
  it('folds every probe in a bucket into one row', async () => {
    const buckets = await getBucketedMeasurements(
      TARGET,
      new Date(base - 60_000),
      new Date(base + 60 * 60_000),
      60 * 60_000 // one hour: all four probes land together
    )

    expect(buckets).toHaveLength(1)
    expect(buckets[0].sampleCount).toBe(4)
    expect(buckets[0].maxPacketLoss).toBe(100)
    expect(buckets[0].isOnline).toBe(true)
  })

  it('omits empty buckets rather than emitting zeroes', async () => {
    const buckets = await getBucketedMeasurements(
      TARGET,
      new Date(base - 60_000),
      new Date(base + 60 * 60_000),
      5 * 60_000
    )
    expect(buckets.every(b => b.sampleCount > 0)).toBe(true)
  })

  it('places each point at the centre of its bucket', async () => {
    const width = 10 * 60_000
    const buckets = await getBucketedMeasurements(
      TARGET,
      new Date(base - 60_000),
      new Date(base + 60 * 60_000),
      width
    )
    for (const bucket of buckets) {
      expect((bucket.timestamp.getTime() - width / 2) % width).toBe(0)
    }
  })
})

describe('getLatestMeasurementForAllTargets', () => {
  it('returns one row per target, the most recent', async () => {
    const latest = await getLatestMeasurementForAllTargets()
    expect(latest[TARGET].success).toBe(false)
    expect(latest[TARGET].packetLoss).toBe(100)
  })
})

describe('updateTarget / deleteTarget', () => {
  it('reports whether a row actually matched', async () => {
    expect(await updateTarget(TARGET, { name: 'Renamed' })).toBe(true)
    expect(await updateTarget('no-such-target', { name: 'x' })).toBe(false)
    expect(await deleteTarget('no-such-target')).toBe(false)
  })

  it('removes a target’s measurements with it', async () => {
    const before = await getMeasurements(TARGET, new Date(base - 60_000), new Date(base + 60 * 60_000))
    expect(before.length).toBeGreaterThan(0)

    expect(await deleteTarget(TARGET)).toBe(true)

    const after = await getMeasurements(TARGET, new Date(base - 60_000), new Date(base + 60 * 60_000))
    expect(after).toHaveLength(0)
  })
})

describe('cleanOldMeasurements', () => {
  it('deletes only rows outside the retention window and reports the count', async () => {
    await createTarget({
      id: 'retention',
      name: 'Retention',
      host: '198.51.100.2',
      probeType: 'ping',
      interval: 300,
      status: 'active',
    })

    const day = 24 * 60 * 60 * 1000
    for (const ageDays of [1, 5, 100, 200]) {
      await storeMeasurement({
        id: `r-${ageDays}`,
        targetId: 'retention',
        timestamp: new Date(Date.now() - ageDays * day),
        latency: 10,
        packetLoss: 0,
        jitter: 0,
        success: true,
      })
    }

    expect(await cleanOldMeasurements(90)).toBe(2)
    expect(await cleanOldMeasurements(90)).toBe(0)
  })
})
