import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-groups-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const {
  initDatabase,
  closeDatabase,
  getDatabase,
  createTarget,
  updateTarget,
  getAllTargets,
  getGroupOrders,
  saveGroupOrders,
  updateTargetSortOrders,
  moveGroup,
} = await import('./database')
const { SCHEMA_VERSION, schemaVersion } = await import('./migrations')

async function add(id: string, group?: string) {
  await createTarget({ id, name: id, host: `${id}.example`, probeType: 'ping', interval: 60, status: 'active', group })
}

/** Which group each target is in, by id. */
async function groups(): Promise<Record<string, string>> {
  return Object.fromEntries((await getAllTargets()).map(target => [target.id, target.group ?? '']))
}

beforeAll(async () => {
  await initDatabase()
})

afterAll(async () => {
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('a new database', () => {
  it('starts at the newest schema version', async () => {
    expect(await schemaVersion(await getDatabase())).toBe(SCHEMA_VERSION)
  })
})

describe('storing a target’s group', () => {
  it('writes every spelling of a path the same way', async () => {
    await add('spaced', ' Home / Lab ')
    await add('plain', 'Home/Lab')
    await add('loose')
    expect(await groups()).toEqual({ spaced: 'Home/Lab', plain: 'Home/Lab', loose: '' })

    await updateTarget('loose', { group: 'Home//Lab/' })
    await updateTargetSortOrders([{ id: 'plain', sortOrder: 3, group: ' Home / Network ' }])
    expect(await groups()).toEqual({ spaced: 'Home/Lab', plain: 'Home/Network', loose: 'Home/Lab' })
  })

  it('takes a target out of its group with an empty one', async () => {
    await updateTarget('loose', { group: '' })
    expect((await groups()).loose).toBe('')
  })
})

describe('moveGroup', () => {
  beforeAll(async () => {
    await add('rack', 'Lab')
    await add('pdu', 'Lab/Rack 1')
    await add('labs', 'Labs')
    await add('wildcard', 'L_b')
    await saveGroupOrders([
      { groupName: 'Lab', sortOrder: 0 },
      { groupName: 'Lab/Rack 1', sortOrder: 4 },
      { groupName: 'Labs', sortOrder: 1 },
    ])
  })

  it('moves a group inside another, with everything beneath it', async () => {
    expect(await moveGroup('Lab', 'Office/Lab')).toBe(2)

    const after = await groups()
    expect(after.rack).toBe('Office/Lab')
    expect(after.pdu).toBe('Office/Lab/Rack 1')
  })

  it('leaves alone groups that only look similar', async () => {
    // `Labs` starts with `Lab`, and `L_b` would match it as a LIKE pattern.
    const after = await groups()
    expect(after.labs).toBe('Labs')
    expect(after.wildcard).toBe('L_b')
  })

  it('carries saved positions along, except the moved group’s own among new neighbours', async () => {
    const orders = Object.fromEntries((await getGroupOrders()).map(order => [order.groupName, order.sortOrder]))
    expect(orders).toEqual({ 'Office/Lab/Rack 1': 4, Labs: 1 })
  })

  it('renames in place and keeps the position', async () => {
    expect(await moveGroup('Labs', 'Benches')).toBe(1)
    expect((await groups()).labs).toBe('Benches')
    expect(await getGroupOrders()).toContainEqual({ groupName: 'Benches', sortOrder: 1 })
  })

  it('merges into a group that already exists', async () => {
    expect(await moveGroup('Home/Lab', 'Office/Lab')).toBe(1)
    const after = await groups()
    expect(after.spaced).toBe('Office/Lab')
    expect(after.rack).toBe('Office/Lab')
  })

  it('refuses to put a group inside itself', async () => {
    await expect(moveGroup('Office', 'Office/Lab/Office')).rejects.toThrow('inside itself')
    expect((await groups()).rack).toBe('Office/Lab')
  })

  it('does nothing for a group that is not there, or a move to where it already is', async () => {
    expect(await moveGroup('Nowhere', 'Somewhere')).toBe(0)
    expect(await moveGroup('Office', ' Office ')).toBe(0)
    expect(await moveGroup('', 'Office')).toBe(0)
  })
})

describe('a database from a newer version', () => {
  it('is opened as it is rather than refused', async () => {
    // What an older image finds after a rollback. It cannot undo the upgrade,
    // and refusing to start would turn the rollback into an outage.
    const database = await getDatabase()
    await new Promise<void>((resolve, reject) => {
      database.run(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`, err => (err ? reject(err) : resolve()))
    })
    await closeDatabase()

    await expect(initDatabase()).resolves.toBeDefined()
    expect(await schemaVersion(await getDatabase())).toBe(SCHEMA_VERSION + 5)
    expect((await getAllTargets()).length).toBeGreaterThan(0)
  })
})
