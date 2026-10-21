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
  deleteTargets,
  updateTarget,
  getTargetById,
  setResolvedAddress,
  storeMeasurement,
  getTargetStatistics,
  getLatestMeasurementForAllTargets,
  getBucketedMeasurements,
  cleanOldMeasurements,
  getMeasurements,
  getNeverAnswered,
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

describe('address family and resolved address', () => {
  const DOMAIN = 'domain-under-test'

  it('defaults to auto and round-trips an explicit choice', async () => {
    expect((await getTargetById(TARGET))?.ipVersion).toBe('auto')

    await createTarget({
      id: DOMAIN,
      name: 'Domain',
      host: 'example.com',
      probeType: 'ping',
      interval: 300,
      status: 'active',
      ipVersion: 'ipv6',
    })
    expect((await getTargetById(DOMAIN))?.ipVersion).toBe('ipv6')
  })

  it('remembers what the last probe resolved to', async () => {
    await setResolvedAddress(DOMAIN, '2001:db8::1')
    expect((await getTargetById(DOMAIN))?.resolvedAddress).toBe('2001:db8::1')
  })

  it('keeps the resolved address across edits that do not move the target', async () => {
    await updateTarget(DOMAIN, { name: 'Renamed' })
    expect((await getTargetById(DOMAIN))?.resolvedAddress).toBe('2001:db8::1')
  })

  it('forgets it once the family changes, since it no longer describes the target', async () => {
    await updateTarget(DOMAIN, { ipVersion: 'ipv4' })
    const target = await getTargetById(DOMAIN)
    expect(target?.ipVersion).toBe('ipv4')
    expect(target?.resolvedAddress).toBeUndefined()

    await deleteTarget(DOMAIN)
  })
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

  it('deletes several at once, with their measurements, and leaves the rest', async () => {
    const window = [new Date(base - 60_000), new Date(base + 60_000)] as const
    for (const id of ['bulk-a', 'bulk-b', 'bulk-kept']) {
      await createTarget({ id, name: id, host: '198.51.100.9', probeType: 'ping', interval: 300, status: 'active' })
      await storeMeasurement({ id: `m-${id}`, targetId: id, timestamp: new Date(base), latency: 5, packetLoss: 0, jitter: 1, success: true })
    }

    // One that is not there is passed over, not counted, and stops nothing.
    expect(await deleteTargets(['bulk-a', 'never-was', 'bulk-b'])).toBe(2)

    expect(await getTargetById('bulk-a')).toBeNull()
    expect(await getTargetById('bulk-b')).toBeNull()
    expect(await getMeasurements('bulk-a', ...window)).toHaveLength(0)
    expect(await getMeasurements('bulk-b', ...window)).toHaveLength(0)

    expect(await getTargetById('bulk-kept')).not.toBeNull()
    expect(await getMeasurements('bulk-kept', ...window)).toHaveLength(1)

    expect(await deleteTargets([])).toBe(0)
    expect(await deleteTargets(['bulk-kept'])).toBe(1)
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

describe('getNeverAnswered', () => {
  it('names the targets that have readings and not one answer among them', async () => {
    const reading = (targetId: string, minute: number, success: boolean) =>
      storeMeasurement({
        id: `n-${targetId}-${minute}`,
        targetId,
        timestamp: new Date(base + minute * 60_000),
        latency: success ? 20 : null,
        packetLoss: success ? 0 : 100,
        jitter: null,
        success,
      })
    for (const id of ['silent', 'answered-once', 'unprobed']) {
      await createTarget({ id, name: id, host: '203.0.113.9', probeType: 'game', interval: 60, status: 'active', probeConfig: { port: 21299, gameQuery: 'unreachable' } })
    }
    for (let minute = 0; minute < 5; minute++) await reading('silent', minute, false)
    // One answer, long ago, and silence since: an outage, not a server it can't measure.
    await reading('answered-once', 0, true)
    for (let minute = 1; minute < 5; minute++) await reading('answered-once', minute, false)

    expect(await getNeverAnswered(['silent', 'answered-once', 'unprobed'])).toEqual(new Set(['silent']))
    expect(await getNeverAnswered([])).toEqual(new Set())
  })
})
