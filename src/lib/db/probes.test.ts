import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-probes-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

// Imported after the env var is set: the module resolves its path on first use.
const {
  initDatabase,
  closeDatabase,
  getDatabase,
  createTarget,
  getTargetById,
  setTargetProbes,
  setGroupProbes,
  storeMeasurement,
  getMeasurements,
  getTargetStatistics,
  getBucketedMeasurements,
  getLatestMeasurementForAllTargets,
  getRecentSeriesForAllTargets,
  getNeverAnswered,
  cleanOldMeasurements,
} = await import('./database')

const MONITOR = 'two-probes'
const base = Date.now() - 30 * 60_000
const windowStart = new Date(base - 60_000)
const windowEnd = new Date(base + 60 * 60_000)

let counter = 0

async function measure(probe: string, minute: number, latency: number | null) {
  await storeMeasurement({
    id: `m-${counter++}`,
    targetId: MONITOR,
    timestamp: new Date(base + minute * 60_000),
    latency,
    packetLoss: latency === null ? 100 : 0,
    jitter: 1,
    success: latency !== null,
    errorMessage: latency === null ? 'All packets lost' : undefined,
    probe,
  })
}

beforeAll(async () => {
  await initDatabase()
  // The probe agent that a monitor's primary probe can be (it is a foreign key).
  const database = await getDatabase()
  await new Promise<void>((resolve, reject) => {
    database.run(
      "INSERT INTO probe_agents (id, name, address, port, token, created_at, updated_at) VALUES ('home', 'Home', '192.0.2.50', 8443, 'token', 0, 0)",
      err => (err ? reject(err) : resolve())
    )
  })
  await createTarget({
    id: MONITOR,
    name: 'Example',
    host: '192.0.2.1',
    probeType: 'ping',
    interval: 60,
    status: 'active',
    probeAgentId: null,
    probes: [{ id: 'local', position: 0 }, { id: 'home', position: 1 }],
  })
  for (const minute of [0, 1, 2]) {
    await measure('local', minute, 10 + minute)
    await measure('home', minute, 100 + minute)
  }
})

afterAll(async () => {
  await closeDatabase()
})

describe('a monitor measured from several probes', () => {
  it('lists its probes, the first being the primary one an older client reads', async () => {
    const monitor = await getTargetById(MONITOR)
    expect(monitor?.probes?.map(probe => probe.id)).toEqual(['local', 'home'])
    expect(monitor?.probeAgentId).toBeNull()
  })

  it('reads each probe’s readings apart', async () => {
    const local = await getMeasurements(MONITOR, windowStart, windowEnd, { probe: 'local' })
    const home = await getMeasurements(MONITOR, windowStart, windowEnd, { probe: 'home' })
    expect(local.map(reading => reading.latency)).toEqual([10, 11, 12])
    expect(home.map(reading => reading.latency)).toEqual([100, 101, 102])
    expect(await getMeasurements(MONITOR, windowStart, windowEnd)).toHaveLength(6)
  })

  it('works out statistics and buckets for one probe without the other bleeding in', async () => {
    const stats = await getTargetStatistics(MONITOR, windowStart, windowEnd, { probe: 'home' })
    expect(stats?.sampleCount).toBe(3)
    expect(stats?.avgLatency).toBe(101)

    const buckets = await getBucketedMeasurements(MONITOR, windowStart, windowEnd, 3_600_000, { probe: 'local' })
    expect(buckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0)).toBe(3)
  })

  it('gives the latest reading of each probe, and of the two together', async () => {
    await measure('home', 3, null)
    const latest = (await getLatestMeasurementForAllTargets())[MONITOR]

    expect(latest.byProbe?.local.success).toBe(true)
    expect(latest.byProbe?.home.success).toBe(false)
    // Reachable if any probe reaches it, with the loss of the worst.
    expect(latest.success).toBe(true)
    expect(latest.packetLoss).toBe(100)
    expect(latest.latency).toBe(12)
  })

  it('draws the sparkline of the primary probe, or of the one asked for', async () => {
    const primary = (await getRecentSeriesForAllTargets(24))[MONITOR]
    const home = (await getRecentSeriesForAllTargets(24, 'home'))[MONITOR]
    expect(primary.map(point => point.latency)).toEqual([10, 11, 12])
    expect(home.map(point => point.latency)).toEqual([100, 101, 102, null])
  })

  it('asks whether a server has ever answered of one probe at a time', async () => {
    await createTarget({ id: 'quiet', name: 'Quiet', host: '192.0.2.9', probeType: 'ping', interval: 60, status: 'active' })
    for (const [probe, latency] of [['local', null], ['home', 5]] as const) {
      await storeMeasurement({
        id: `q-${probe}`, targetId: 'quiet', timestamp: new Date(base), latency, packetLoss: latency === null ? 100 : 0,
        jitter: null, success: latency !== null, probe,
      })
    }
    expect((await getNeverAnswered(['quiet'], 'local')).has('quiet')).toBe(true)
    expect((await getNeverAnswered(['quiet'], 'home')).has('quiet')).toBe(false)
    expect((await getNeverAnswered(['quiet'])).has('quiet')).toBe(false)
  })
})

describe('taking a probe off a monitor', () => {
  it('keeps its readings as a former probe, and picks them up again when it is put back', async () => {
    await setTargetProbes(MONITOR, ['local'])
    let monitor = await getTargetById(MONITOR)
    expect(monitor?.probes?.map(probe => [probe.id, !!probe.former])).toEqual([['local', false], ['home', true]])
    expect(await getMeasurements(MONITOR, windowStart, windowEnd, { probe: 'home' })).toHaveLength(4)

    // Only the probes that measure it now stand for it.
    const latest = (await getLatestMeasurementForAllTargets())[MONITOR]
    expect(latest.byProbe).toBeUndefined()
    expect(latest.success).toBe(true)

    await setTargetProbes(MONITOR, ['home', 'local'])
    monitor = await getTargetById(MONITOR)
    expect(monitor?.probes?.map(probe => [probe.id, !!probe.former])).toEqual([['home', false], ['local', false]])
    // The primary probe is what the older column holds.
    expect(monitor?.probeAgentId).toBe('home')
  })

  it('forgets a former probe once none of its readings remain', async () => {
    await setTargetProbes(MONITOR, ['local'])
    await cleanOldMeasurements(0)
    const monitor = await getTargetById(MONITOR)
    expect(monitor?.probes?.map(probe => probe.id)).toEqual(['local'])
  })
})

describe('a group measured from several probes', () => {
  it('sets every monitor in it, and in groups inside it, and leaves those already there', async () => {
    await createTarget({ id: 'g1', name: 'A', host: '192.0.2.21', probeType: 'ping', interval: 60, status: 'active', group: 'Lab' })
    await createTarget({ id: 'g2', name: 'B', host: '192.0.2.22', probeType: 'ping', interval: 60, status: 'active', group: 'Lab/Inner' })

    expect(await setGroupProbes('Lab', ['local', 'home'])).toBe(2)
    expect((await getTargetById('g2'))?.probes?.map(probe => probe.id)).toEqual(['local', 'home'])
    expect(await setGroupProbes('Lab', ['local', 'home'])).toBe(0)
  })
})
