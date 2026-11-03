import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-comparisons-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, getDatabase, createTarget, deleteTarget } = await import('../db/database')
const { createComparison, deleteComparison, getComparison, listComparisons, readComparisonInput, updateComparison } = await import('./store')

const monitor = (id: string, group: string, probe = 'local') => ({
  id, name: id, host: `192.0.2.${id.length}`, probeType: 'ping' as const, interval: 60, status: 'active' as const, group,
  probeAgentId: probe === 'local' ? null : probe,
  probes: [{ id: probe, position: 0 }],
})

beforeAll(async () => {
  await initDatabase()
  const database = await getDatabase()
  await new Promise<void>((resolve, reject) => {
    database.run("INSERT INTO probe_agents (id, name, address, port, token, created_at, updated_at) VALUES ('home', 'Home', '192.0.2.50', 8443, 't', 0, 0)", err => (err ? reject(err) : resolve()))
  })
  await createTarget(monitor('a', 'Work'))
  await createTarget(monitor('bb', 'Home'))
  await createTarget({ ...monitor('ccc', 'Home', 'home') })
})

afterAll(async () => {
  await closeDatabase()
})

describe('checking what a comparison is sent', () => {
  it('wants a name and at least two lines', async () => {
    expect(await readComparisonInput({ name: ' ', lines: [] })).toMatchObject({ ok: false })
    expect(await readComparisonInput({ name: 'X', lines: [{ targetId: 'a', probe: 'local' }] })).toMatchObject({ ok: false })
  })

  it('leaves out lines on monitors that are gone or probes that never measured them, and repeats', async () => {
    const input = await readComparisonInput({
      name: 'Mixed',
      lines: [
        { targetId: 'a', probe: 'local' },
        { targetId: 'a', probe: 'local' },
        { targetId: 'a', probe: 'home' },
        { targetId: 'gone', probe: 'local' },
        { targetId: 'bb', probe: 'local' },
      ],
    })
    expect(input).toEqual({ ok: true, name: 'Mixed', lines: [{ targetId: 'a', probe: 'local' }, { targetId: 'bb', probe: 'local' }] })
  })
})

describe('saved comparisons', () => {
  it('keep monitors from any group, each with its probe, in order', async () => {
    const made = await createComparison('Work and home', [
      { targetId: 'a', probe: 'local' },
      { targetId: 'ccc', probe: 'home' },
    ])
    expect((await getComparison(made.id))?.lines).toEqual([{ targetId: 'a', probe: 'local' }, { targetId: 'ccc', probe: 'home' }])
    expect((await listComparisons()).map(each => each.name)).toEqual(['Work and home'])
  })

  it('can be renamed and given other lines', async () => {
    const [first] = await listComparisons()
    const changed = await updateComparison(first.id, { name: 'Renamed', lines: [{ targetId: 'bb', probe: 'local' }, { targetId: 'a', probe: 'local' }] })
    expect(changed?.name).toBe('Renamed')
    expect(changed?.lines.map(line => line.targetId)).toEqual(['bb', 'a'])
  })

  it('lose a line when its monitor is deleted, and go when deleted themselves', async () => {
    const [first] = await listComparisons()
    await deleteTarget('bb')
    expect((await getComparison(first.id))?.lines.map(line => line.targetId)).toEqual(['a'])
    expect(await deleteComparison(first.id)).toBe(true)
    expect(await listComparisons()).toEqual([])
  })
})
