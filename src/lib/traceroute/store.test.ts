import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Traceroute } from '@/types/probe'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-traces-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, createTarget, deleteTarget } = await import('../db/database')
const {
  ensureTracerouteSchema,
  storeTraceroute,
  getTraceroutes,
  countTraceroutes,
  deleteTraceroute,
  deleteOlderTraceroutes,
  lastAlertTraceAt,
  trimAlertTraces,
  purgeAlertTraces,
} = await import('./store')

/** A stored trace, `minutesAgo` old, to `address`. */
async function keep(
  id: string,
  targetId: string,
  minutesAgo: number,
  address = '192.0.2.1',
  trigger: Traceroute['trigger'] = 'manual',
  alertId?: string
): Promise<void> {
  const trace: Traceroute = {
    id,
    targetId,
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    trigger,
    address,
    hops: [{ hop: 1, address, rtts: [1.2, 1.4, 1.1], sent: 3 }],
    reached: true,
    alertId,
  }
  await storeTraceroute(trace)
}

const listed = async (targetId: string) => (await getTraceroutes(targetId, 50)).map(trace => trace.id)

beforeAll(async () => {
  await initDatabase()
  await ensureTracerouteSchema()
  for (const id of ['single', 'dual', 'other']) {
    await createTarget({ id, name: id, host: `${id}.example`, probeType: 'ping', interval: 60, status: 'active' })
  }
})

afterAll(async () => {
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('deleting one trace', () => {
  it('removes that trace and no other', async () => {
    await keep('s1', 'single', 30)
    await keep('s2', 'single', 20)
    await keep('s3', 'single', 10)

    expect(await deleteTraceroute('single', 's2')).toBe(true)
    expect(await listed('single')).toEqual(['s3', 's1'])
    expect(await countTraceroutes('single')).toBe(2)
  })

  it('says so when there is no such trace', async () => {
    expect(await deleteTraceroute('single', 's2')).toBe(false)
    expect(await deleteTraceroute('single', 'never-was')).toBe(false)
  })

  it('will not delete a trace through another target', async () => {
    await keep('o1', 'other', 5)
    expect(await deleteTraceroute('single', 'o1')).toBe(false)
    expect(await listed('other')).toEqual(['o1'])
  })
})

describe('deleting the old traces', () => {
  it('leaves only the newest', async () => {
    await keep('s4', 'single', 2)
    expect(await deleteOlderTraceroutes('single')).toBe(2)
    expect(await listed('single')).toEqual(['s4'])
  })

  it('leaves the newest over each family of a target traced over both', async () => {
    await keep('v4-old', 'dual', 60, '192.0.2.1')
    await keep('v6-old', 'dual', 59, '2001:db8::1')
    await keep('v4-new', 'dual', 3, '192.0.2.1')
    await keep('v6-new', 'dual', 2, '2001:db8::1')

    expect(await deleteOlderTraceroutes('dual')).toBe(2)
    expect(await listed('dual')).toEqual(['v6-new', 'v4-new'])
  })

  it('reaches the ones too old to be listed', async () => {
    for (let age = 100; age < 160; age++) await keep(`bulk-${age}`, 'other', age)
    expect(await countTraceroutes('other')).toBe(61)
    expect((await getTraceroutes('other')).length).toBe(10)

    expect(await deleteOlderTraceroutes('other')).toBe(60)
    expect(await listed('other')).toEqual(['o1'])
  })

  it('does nothing where there is nothing old, and touches no other target', async () => {
    expect(await deleteOlderTraceroutes('single')).toBe(0)
    expect(await deleteOlderTraceroutes('nobody')).toBe(0)
    expect(await listed('dual')).toEqual(['v6-new', 'v4-new'])
  })
})

describe('the last trace taken on an alert', () => {
  it('is none until an alert has traced the target', async () => {
    // 'single' has only ever been traced by hand.
    expect(await lastAlertTraceAt('single')).toBeNull()
  })

  it('is the newest of those taken on an alert, whatever was traced by hand since', async () => {
    await keep('a-old', 'single', 40, '192.0.2.1', 'alert')
    await keep('a-new', 'single', 25, '192.0.2.1', 'alert')
    await keep('by-hand', 'single', 1)

    const at = await lastAlertTraceAt('single')
    expect(Date.now() - at!.getTime()).toBeGreaterThanOrEqual(25 * 60_000)
    expect(Date.now() - at!.getTime()).toBeLessThan(26 * 60_000)
  })
})

describe('routes an alert keeps', () => {
  const DAY = 24 * 60

  it('drops routes older than the days it keeps, and past the newest it keeps, for each target', async () => {
    await createTarget({ id: 'kept', name: 'kept', host: 'kept.example', probeType: 'ping', interval: 60, status: 'active' })
    await createTarget({ id: 'kept2', name: 'kept2', host: 'kept2.example', probeType: 'ping', interval: 60, status: 'active' })
    await keep('aged', 'kept', 31 * DAY, '192.0.2.1', 'alert', 'alert-keep')
    await keep('hand', 'kept', 40 * DAY)
    await keep('other', 'kept', 40 * DAY, '192.0.2.1', 'alert', 'alert-other')
    await keep('a1', 'kept', 30, '192.0.2.1', 'alert', 'alert-keep')
    await keep('a2', 'kept', 20, '192.0.2.1', 'alert', 'alert-keep')
    await keep('a3', 'kept', 10, '192.0.2.1', 'alert', 'alert-keep')
    await keep('b1', 'kept2', 30, '192.0.2.1', 'alert', 'alert-keep')
    await keep('b2', 'kept2', 20, '192.0.2.1', 'alert', 'alert-keep')
    await keep('b3', 'kept2', 10, '192.0.2.1', 'alert', 'alert-keep')

    expect(await trimAlertTraces('alert-keep', 2, 30)).toBe(3)
    const kept = await listed('kept')
    expect(kept.slice(0, 2)).toEqual(['a3', 'a2'])
    expect(kept.slice(2).sort()).toEqual(['hand', 'other'])
    expect(await listed('kept2')).toEqual(['b3', 'b2'])
    expect((await getTraceroutes('kept', 50)).find(trace => trace.id === 'a3')?.alertId).toBe('alert-keep')
    expect((await getTraceroutes('kept', 50)).find(trace => trace.id === 'hand')?.alertId).toBeUndefined()
  })

  it('deletes every route that alert took, and no other', async () => {
    expect(await purgeAlertTraces('alert-keep')).toBe(4)
    expect((await listed('kept')).sort()).toEqual(['hand', 'other'])
    expect(await listed('kept2')).toEqual([])
    expect(await purgeAlertTraces('alert-keep')).toBe(0)
    expect(await trimAlertTraces('', 1, 1)).toBe(0)
    expect(await purgeAlertTraces('')).toBe(0)
  })
})

describe('deleting a target', () => {
  it('takes its traces with it', async () => {
    await deleteTarget('dual')
    expect(await countTraceroutes('dual')).toBe(0)
  })
})
