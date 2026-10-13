import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Traceroute } from '@/types/probe'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-traces-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, createTarget, deleteTarget } = await import('./database')
const {
  ensureTracerouteSchema,
  storeTraceroute,
  getTraceroutes,
  countTraceroutes,
  deleteTraceroute,
  deleteOlderTraceroutes,
} = await import('./traceroute')

/** A stored trace, `minutesAgo` old, to `address`. */
async function keep(id: string, targetId: string, minutesAgo: number, address = '192.0.2.1'): Promise<void> {
  const trace: Traceroute = {
    id,
    targetId,
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    trigger: 'manual',
    address,
    hops: [{ hop: 1, address, rtts: [1.2, 1.4, 1.1], sent: 3 }],
    reached: true,
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

describe('deleting a target', () => {
  it('takes its traces with it', async () => {
    await deleteTarget('dual')
    expect(await countTraceroutes('dual')).toBe(0)
  })
})
