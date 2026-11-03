import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProbeResult } from '@/types/probe'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-alert-probes-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, createTarget, getDatabase } = await import('../db/database')
const { createAlert, evaluateAlerts, getAlerts, parseAlertInput, updateAlert } = await import('./store')
const { getAlertEvents } = await import('./history')

const MONITOR = { id: 'm1', name: 'Example DNS', host: '192.0.2.53', interval: 60, group: 'Lab' }

const result = (probe: string, loss: number): ProbeResult => ({
  targetId: MONITOR.id,
  timestamp: new Date(),
  latency: loss === 100 ? null : 20,
  packetLoss: loss,
  jitter: 1,
  success: loss < 100,
  probe,
})
const feed = (probe: string, loss: number) => evaluateAlerts(MONITOR, result(probe, loss))

beforeAll(async () => {
  await initDatabase()
  await createTarget({
    ...MONITOR,
    probeType: 'ping',
    status: 'active',
    probeAgentId: null,
    probes: [{ id: 'local', position: 0 }, { id: 'a', position: 1 }, { id: 'b', position: 2 }],
  })
  await createTarget({ id: 'other', name: 'Elsewhere', host: '192.0.2.99', probeType: 'ping', interval: 60, status: 'active', group: 'Elsewhere' })
})

afterAll(async () => {
  await closeDatabase()
})

describe('an alert that needs two of three probes to agree', () => {
  let alertId = ''

  it('fires only when the second probe sees it, and says which', async () => {
    const alert = await createAlert({
      metric: 'packetLoss', threshold: 5, consecutiveProbes: 1, notifyUrls: [], targetIds: [MONITOR.id],
      policy: { kind: 'atLeast', count: 2 },
    })
    alertId = alert.id

    expect(await feed('local', 50)).toHaveLength(0)
    const fired = await feed('a', 50)
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ transition: 'firing', probeCount: 3 })
    expect(fired[0].breaching?.sort()).toEqual(['a', 'local'])
    expect(fired[0].policyText).toBe('at least 2 of 3 probes: 2 in breach')
  })

  it('records why, in its history', async () => {
    const [event] = await getAlertEvents(alertId)
    expect(event).toMatchObject({ transition: 'firing', targetId: MONITOR.id, reason: 'at least 2 of 3 probes: 2 in breach' })
    expect(event.conditions[0]).toMatchObject({ label: 'Packet loss above 5%', observed: '50%', held: true })
    expect(event.probes.filter(probe => probe.breaching).map(probe => probe.probe).sort()).toEqual(['a', 'local'])
  })

  it('stays firing while two probes still see it, and resolves once only one does', async () => {
    expect(await feed('b', 0)).toHaveLength(0)
    expect(await feed('local', 50)).toHaveLength(0)
    const resolved = await feed('a', 0)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].transition).toBe('resolved')
  })

  it('treats a probe it does not count as nothing', async () => {
    await updateAlert(alertId, { probes: ['local', 'a'], policy: { kind: 'all' } })
    expect(await feed('b', 100)).toHaveLength(0)
    expect(await feed('local', 50)).toHaveLength(0)
    expect(await feed('a', 50)).toHaveLength(1)
  })
})

describe('where an alert applies', () => {
  it('covers every monitor in a group, including one that is added later', async () => {
    const alert = await createAlert({
      metric: 'unreachable', threshold: 0, consecutiveProbes: 1, notifyUrls: [], targetIds: [],
      scope: [{ kind: 'group', ref: 'Elsewhere' }],
    })
    const down = (id: string): ProbeResult => ({ targetId: id, timestamp: new Date(), latency: null, packetLoss: 100, jitter: null, success: false, probe: 'local' })
    expect(await evaluateAlerts({ id: 'other', name: 'Elsewhere', host: '192.0.2.99', group: 'Elsewhere', interval: 60 }, down('other'))).toHaveLength(1)

    await createTarget({ id: 'later', name: 'Later', host: '192.0.2.98', probeType: 'ping', interval: 60, status: 'active', group: 'Elsewhere/Inner' })
    expect(await evaluateAlerts({ id: 'later', name: 'Later', host: '192.0.2.98', group: 'Elsewhere/Inner', interval: 60 }, down('later'))).toHaveLength(1)
    // A monitor outside it is left alone.
    expect(await evaluateAlerts(MONITOR, { ...down(MONITOR.id), probe: 'local' })).toHaveLength(0)
    expect((await getAlerts()).find(each => each.id === alert.id)?.scope).toEqual([{ kind: 'group', ref: 'Elsewhere' }])
  })
})

describe('what the API accepts for an alert', () => {
  it('takes conditions, with the first as its metric and threshold', () => {
    const parsed = parseAlertInput({
      conditions: [{ metric: 'packetLoss', threshold: 5, clearThreshold: 2 }, { metric: 'latency', threshold: 200, window: 3 }],
      combine: 'all', forMinutes: 5, clearAfter: 10, policy: { kind: 'share', percent: 60 }, probes: ['local'],
      scope: [{ kind: 'probe', ref: 'local' }], consecutiveProbes: 3, notifyUrls: [], targetIds: [],
    })
    expect(parsed).toMatchObject({ ok: true, input: { metric: 'packetLoss', threshold: 5, combine: 'all', forMinutes: 5, policy: { kind: 'share', percent: 60 } } })
  })

  it('refuses what it cannot judge', () => {
    for (const body of [
      { conditions: [], consecutiveProbes: 1, notifyUrls: [], targetIds: [] },
      { conditions: [{ metric: 'nonsense', threshold: 1 }], consecutiveProbes: 1, notifyUrls: [], targetIds: [] },
      { metric: 'latency', threshold: 1, consecutiveProbes: 1, notifyUrls: [], targetIds: [], policy: { kind: 'atLeast', count: 0 } },
      { metric: 'latency', threshold: 1, consecutiveProbes: 1, notifyUrls: [], targetIds: [], scope: [{ kind: 'nowhere', ref: 'x' }] },
    ]) {
      expect(parseAlertInput(body)).toMatchObject({ ok: false })
    }
  })

  it('keeps alerts that predate rules as they were', async () => {
    const database = await getDatabase()
    expect(database).toBeTruthy()
    const old = await createAlert({ metric: 'latency', threshold: 100, consecutiveProbes: 2, notifyUrls: [], targetIds: [MONITOR.id] })
    const stored = (await getAlerts()).find(each => each.id === old.id)!
    expect(stored.policy).toEqual({ kind: 'any' })
    expect(stored.combine).toBe('any')
    expect(stored.probes).toBeNull()
  })
})
