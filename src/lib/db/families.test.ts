import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressFamily } from '@/types/probe'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-families-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

// Imported after the env var is set: the module resolves its path on first use.
const {
  initDatabase,
  closeDatabase,
  getDatabase,
  createTarget,
  updateTarget,
  setResolvedAddress,
  storeMeasurement,
  getMeasurements,
  getTargetStatistics,
  getBucketedMeasurements,
  getLatestMeasurementForAllTargets,
  getRecentSeriesForAllTargets,
} = await import('./database')

const DUAL = 'dual-stack-target'
const SINGLE = 'single-target'
const base = Date.parse('2026-08-19T12:00:00.000Z')
const windowStart = new Date(base - 60_000)
const windowEnd = new Date(base + 60 * 60_000)

let counter = 0

async function measure(
  targetId: string,
  minute: number,
  family: AddressFamily | undefined,
  fields: { latency: number | null; packetLoss: number; success: boolean; errorMessage?: string }
) {
  await storeMeasurement({
    id: `m-${counter++}`,
    targetId,
    timestamp: new Date(base + minute * 60_000),
    latency: fields.latency,
    packetLoss: fields.packetLoss,
    jitter: 1,
    success: fields.success,
    errorMessage: fields.errorMessage,
    family,
  })
}

/** One round of a dual-stack target: both families, stamped with the same moment. */
async function round(minute: number, v4: number | null, v6: number | null) {
  const reading = (latency: number | null) =>
    latency === null
      ? { latency: null, packetLoss: 100, success: false, errorMessage: 'All packets lost' }
      : { latency, packetLoss: 0, success: true }

  await measure(DUAL, minute, 4, reading(v4))
  await measure(DUAL, minute, 6, reading(v6))
}

beforeAll(async () => {
  await initDatabase()
  await createTarget({
    id: DUAL,
    name: 'Dual',
    host: 'example.com',
    probeType: 'ping',
    interval: 60,
    status: 'active',
    ipVersion: 'both',
  })
  await createTarget({
    id: SINGLE,
    name: 'Single',
    host: '198.51.100.1',
    probeType: 'ping',
    interval: 60,
    status: 'active',
  })

  await round(0, 10, 30)
  await round(1, 12, 32)
  // IPv6 goes away while IPv4 carries on.
  await round(2, 14, null)

  await measure(SINGLE, 0, 4, { latency: 5, packetLoss: 0, success: true })
})

afterAll(async () => {
  // Windows keeps the file locked until the handle is closed.
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('a target probed over both families', () => {
  it('stores each family as its own reading', async () => {
    const stored = await getMeasurements(DUAL, windowStart, windowEnd)
    expect(stored).toHaveLength(6)
    expect(stored.filter(m => m.family === 4)).toHaveLength(3)
    expect(stored.filter(m => m.family === 6)).toHaveLength(3)
  })

  it('reports statistics for one family without the other bleeding in', async () => {
    const v4 = await getTargetStatistics(DUAL, windowStart, windowEnd, { family: 4 })
    const v6 = await getTargetStatistics(DUAL, windowStart, windowEnd, { family: 6 })

    expect(v4?.sampleCount).toBe(3)
    expect(v4?.avgLatency).toBeCloseTo(12)
    expect(v4?.packetLoss).toBe(0)
    expect(v4?.uptime).toBe(100)

    expect(v6?.sampleCount).toBe(3)
    expect(v6?.avgLatency).toBeCloseTo(31)
    expect(v6?.packetLoss).toBeCloseTo(100 / 3)
    expect(v6?.uptime).toBeCloseTo(200 / 3)
  })

  it('still reads the whole target when no family is asked for', async () => {
    const all = await getTargetStatistics(DUAL, windowStart, windowEnd)
    expect(all?.sampleCount).toBe(6)
  })

  it('buckets one family at a time', async () => {
    const v4 = await getBucketedMeasurements(DUAL, windowStart, windowEnd, 60_000, { family: 4 })
    const v6 = await getBucketedMeasurements(DUAL, windowStart, windowEnd, 60_000, { family: 6 })

    expect(v4.map(bucket => bucket.latency)).toEqual([10, 12, 14])
    expect(v6.map(bucket => bucket.latency)).toEqual([30, 32, null])
    expect(v6[2].packetLoss).toBe(100)
    // The same grid for both, so the two lines can share one time axis.
    expect(v4.map(bucket => bucket.timestamp.getTime())).toEqual(v6.map(bucket => bucket.timestamp.getTime()))
  })
})

describe('getLatestMeasurementForAllTargets with a dual-stack target', () => {
  it('gives the newest reading of each family', async () => {
    const latest = await getLatestMeasurementForAllTargets()
    const reading = latest[DUAL]

    expect(reading.byFamily?.[4]).toMatchObject({ success: true, latency: 14, packetLoss: 0 })
    expect(reading.byFamily?.[6]).toMatchObject({ success: false, latency: null, packetLoss: 100 })
  })

  it('calls the target reachable when one family is, but shows the loss of the other', async () => {
    const reading = (await getLatestMeasurementForAllTargets())[DUAL]

    expect(reading.success).toBe(true)
    expect(reading.packetLoss).toBe(100)
    expect(reading.latency).toBe(14)
    expect(reading.errorMessage).toBe('IPv6: All packets lost')
  })

  it('leaves a single-family target as one plain reading', async () => {
    const reading = (await getLatestMeasurementForAllTargets())[SINGLE]

    expect(reading.byFamily).toBeUndefined()
    expect(reading).toMatchObject({ success: true, latency: 5 })
  })

  it('stops splitting a target that is no longer probed over both', async () => {
    await updateTarget(DUAL, { ipVersion: 'ipv4' })
    expect((await getLatestMeasurementForAllTargets())[DUAL].byFamily).toBeUndefined()

    await updateTarget(DUAL, { ipVersion: 'both' })
    expect((await getLatestMeasurementForAllTargets())[DUAL].byFamily).toBeDefined()
  })
})

describe('getRecentSeriesForAllTargets with a dual-stack target', () => {
  it('draws each round as one point, not a zigzag between the families', async () => {
    const series = (await getRecentSeriesForAllTargets(24))[DUAL]

    expect(series).toHaveLength(3)
    expect(series.map(point => point.latency)).toEqual([20, 22, 14])
  })

  it('carries the worse loss of the pair', async () => {
    const series = (await getRecentSeriesForAllTargets(24))[DUAL]
    expect(series.map(point => point.packetLoss)).toEqual([0, 0, 100])
  })
})

describe('readings stored before the family was recorded', () => {
  const families = async (targetId: string) =>
    (await getMeasurements(targetId, windowStart, windowEnd)).map(m => m.family)

  it('are filed under the family their target is probed over, on the next start', async () => {
    await createTarget({ id: 'legacy-v6-address', name: 'a', host: '2001:db8::1', probeType: 'ping', interval: 60, status: 'active' })
    await createTarget({ id: 'legacy-pinned', name: 'b', host: 'example.org', probeType: 'ping', interval: 60, status: 'active', ipVersion: 'ipv6' })
    await createTarget({ id: 'legacy-resolved', name: 'c', host: 'example.net', probeType: 'ping', interval: 60, status: 'active' })
    await createTarget({ id: 'legacy-unknown', name: 'd', host: 'example.edu', probeType: 'ping', interval: 60, status: 'active' })
    await setResolvedAddress('legacy-resolved', '203.0.113.7')

    for (const id of ['legacy-v6-address', 'legacy-pinned', 'legacy-resolved', 'legacy-unknown']) {
      await measure(id, 0, undefined, { latency: 9, packetLoss: 0, success: true })
    }
    expect(await families('legacy-pinned')).toEqual([undefined])

    // The filing happens as the database is opened, once: a database made
    // before the family column has never been marked as filed.
    const database = await getDatabase()
    await new Promise<void>((resolve, reject) => {
      database.run("DELETE FROM settings WHERE key = 'upgrade.families-backfilled'", err => (err ? reject(err) : resolve()))
    })
    await closeDatabase()
    await initDatabase()

    expect(await families('legacy-v6-address')).toEqual([6])
    expect(await families('legacy-pinned')).toEqual([6])
    expect(await families('legacy-resolved')).toEqual([4])
    // A name that was never resolved gives nothing to go on, so it is left alone.
    expect(await families('legacy-unknown')).toEqual([undefined])
  })

  it('leaves readings that already have a family where they are', async () => {
    const database = await getDatabase()
    const count = await new Promise<number>((resolve, reject) => {
      database.get(
        'SELECT COUNT(*) AS n FROM measurements WHERE target_id = ? AND family = 6',
        [DUAL],
        (err, row) => (err ? reject(err) : resolve((row as { n: number }).n))
      )
    })
    expect(count).toBe(3)
  })
})
