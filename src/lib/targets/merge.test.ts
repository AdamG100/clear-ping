import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Target } from '@/types/probe'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-merge-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, getDatabase, createTarget, getTargetById, getAllTargets, storeMeasurement, addProbeToMonitors } = await import('../db/database')
const { findDuplicateSets, mergeMonitors } = await import('./merge')

type Row = Record<string, unknown>
async function sql(statement: string, params: unknown[] = []): Promise<Row[]> {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    database.all(statement, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as Row[])))
  })
}

const ping = (id: string, name: string, host: string, probe: string, group = '') => ({
  id, name, host, probeType: 'ping' as const, interval: 60, status: 'active' as const, group,
  probeAgentId: probe === 'local' ? null : probe,
  probes: [{ id: probe, position: 0 }],
})

beforeAll(async () => {
  await initDatabase()
  await sql("INSERT INTO probe_agents (id, name, address, port, token, created_at, updated_at) VALUES ('home', 'Home', '192.0.2.50', 8443, 't', 0, 0)")
  await createTarget(ping('work', 'Cloudflare DNS', '192.0.2.53', 'local', 'Work'))
  await createTarget(ping('home-copy', 'Cloudflare DNS (home)', '192.0.2.53', 'home', 'Home'))
  await createTarget(ping('other', 'Different', '192.0.2.54', 'local'))
  for (const [id, probe, latency] of [['work', 'local', 10], ['home-copy', 'home', 90]] as const) {
    await storeMeasurement({ id: `m-${id}`, targetId: id, timestamp: new Date(1000), latency, packetLoss: 0, jitter: 1, success: true, probe })
  }
  await sql("INSERT INTO alerts (id, name, metric, threshold, consecutive_probes, created_at) VALUES ('a1', 'Loss', 'packetLoss', 5, 3, 0)")
  await sql("INSERT INTO alert_targets (alert_id, target_id, state) VALUES ('a1', 'work', 'ok'), ('a1', 'home-copy', 'firing')")
  await sql("INSERT INTO alert_probe_states (alert_id, target_id, probe, in_breach, streak) VALUES ('a1', 'home-copy', 'home', 1, 0)")
})

afterAll(async () => {
  await closeDatabase()
})

describe('finding monitors set up once for each probe', () => {
  it('pairs those that measure the same thing from different probes, and leaves the rest', async () => {
    const sets = findDuplicateSets(await getAllTargets())
    expect(sets).toHaveLength(1)
    expect(sets[0].monitors.map(monitor => monitor.id).sort()).toEqual(['home-copy', 'work'])
  })

  it('pairs them when only their settings differ, and says so', () => {
    const tuned = [
      { ...ping('x', 'X', '192.0.2.1', 'local'), probeConfig: { packetCount: 20 } },
      { ...ping('y', 'Y', '192.0.2.1', 'home'), probeConfig: { packetCount: 5 } },
    ] as unknown as Target[]
    const [set] = findDuplicateSets(tuned)
    expect(set.monitors).toHaveLength(2)
    expect(set.settingsDiffer).toBe(true)
    expect(findDuplicateSets([tuned[0], { ...tuned[1], probeConfig: { packetCount: 20 } }] as Target[])[0].settingsDiffer).toBe(false)
  })

  it('does not pair different methods on the same address', () => {
    const mixed = [ping('x', 'X', '192.0.2.1', 'local'), { ...ping('y', 'Y', '192.0.2.1', 'home'), probeType: 'tcp' }] as unknown as Target[]
    expect(findDuplicateSets(mixed)).toEqual([])
  })

  it('leaves two that share a probe alone', () => {
    const same = [
      { ...ping('x', 'X', '192.0.2.1', 'local') },
      { ...ping('y', 'Y', '192.0.2.1', 'local') },
    ] as unknown as Target[]
    expect(findDuplicateSets(same)).toEqual([])
  })
})

describe('adding a new probe to monitors that exist', () => {
  it('adds it to a group and the groups inside it, keeping each monitor\'s probes and its first', async () => {
    await createTarget(ping('lab-a', 'Lab A', '192.0.2.60', 'local', 'Lab'))
    await createTarget(ping('lab-b', 'Lab B', '192.0.2.61', 'local', 'Lab/Rack 1'))
    await createTarget(ping('elsewhere', 'Elsewhere', '192.0.2.62', 'local', 'Labs'))

    expect(await addProbeToMonitors('home', { group: 'Lab' })).toBe(2)
    expect((await getTargetById('lab-a'))!.probes!.map(probe => probe.id)).toEqual(['local', 'home'])
    expect((await getTargetById('lab-b'))!.probes!.map(probe => probe.id)).toEqual(['local', 'home'])
    expect((await getTargetById('elsewhere'))!.probes!.map(probe => probe.id)).toEqual(['local'])
    expect((await getTargetById('lab-a'))!.probeAgentId ?? null).toBeNull()

    // Again: nothing to add.
    expect(await addProbeToMonitors('home', { group: 'Lab' })).toBe(0)
  })
})

describe('merging them', () => {
  it('moves readings under the kept monitor, each with its probe, and keeps what its alerts knew', async () => {
    const moved = await mergeMonitors('work', ['home-copy'])
    expect(moved).toBe(1)

    const monitor = await getTargetById('work')
    expect(monitor?.probes?.map(probe => probe.id)).toEqual(['local', 'home'])
    expect(await getTargetById('home-copy')).toBeNull()

    const readings = await sql("SELECT probe, latency FROM measurements WHERE target_id = 'work' ORDER BY latency")
    expect(readings).toEqual([{ probe: 'local', latency: 10 }, { probe: 'home', latency: 90 }])

    // The alert that was firing on one of them is firing on the merged monitor.
    const [state] = await sql("SELECT state FROM alert_targets WHERE alert_id = 'a1' AND target_id = 'work'")
    expect(state.state).toBe('firing')
    const [probeState] = await sql("SELECT in_breach FROM alert_probe_states WHERE target_id = 'work' AND probe = 'home'")
    expect(probeState.in_breach).toBe(1)
  })
})
