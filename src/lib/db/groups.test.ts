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
  setGroupProbeAgent,
  getGroups,
  createGroup,
  deleteGroup,
  deleteEmptyGroups,
} = await import('./database')
const { SCHEMA_VERSION, schemaVersion } = await import('./migrations')
const { createProbeAgent } = await import('../probe-agents/store')

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

describe('groups in their own right', () => {
  it('makes a group with nothing in it, and the groups it sits inside', async () => {
    expect(await createGroup(' Spare / Shelf ')).toBe('Spare/Shelf')
    expect(await getGroups()).toEqual(expect.arrayContaining(['Spare', 'Spare/Shelf']))
  })

  it('makes nothing out of a name with nothing in it, or a group that is already there', async () => {
    const before = await getGroups()
    expect(await createGroup(' / ')).toBe('')
    await createGroup('Spare/Shelf')
    expect(await getGroups()).toEqual(before)
  })

  it('knows every group a target was put in, however it got there', async () => {
    await add('typed', 'Typed/In')
    await updateTarget('typed', { group: 'Edited/In' })
    await updateTargetSortOrders([{ id: 'typed', sortOrder: 0, group: 'Dragged/In' }])
    expect(await getGroups()).toEqual(
      expect.arrayContaining(['Typed', 'Typed/In', 'Edited', 'Edited/In', 'Dragged', 'Dragged/In'])
    )
  })

  it('keeps a group when its last target leaves', async () => {
    await updateTarget('typed', { group: '' })
    expect(await getGroups()).toContain('Dragged/In')
  })

  it('moves an empty group, and the empty groups inside it, like any other', async () => {
    expect(await moveGroup('Spare', 'Office/Spare')).toBe(0)
    const after = await getGroups()
    expect(after).toEqual(expect.arrayContaining(['Office/Spare', 'Office/Spare/Shelf']))
    expect(after).not.toContain('Spare')
    expect(after).not.toContain('Spare/Shelf')
  })

  it('deletes a group and moves what was in it up to the group it sat in', async () => {
    await add('shelved', 'Office/Spare')
    await add('boxed', 'Office/Spare/Shelf/Box')
    await saveGroupOrders([{ groupName: 'Office/Spare/Shelf', sortOrder: 2 }])

    expect(await deleteGroup('Office/Spare')).toBe(true)

    const after = await groups()
    expect(after.shelved).toBe('Office')
    expect(after.boxed).toBe('Office/Shelf/Box')

    const kept = await getGroups()
    expect(kept).toEqual(expect.arrayContaining(['Office', 'Office/Shelf', 'Office/Shelf/Box']))
    expect(kept.filter(group => group === 'Office/Spare' || group.startsWith('Office/Spare/'))).toEqual([])
    expect((await getGroupOrders()).map(order => order.groupName)).not.toContain('Office/Spare/Shelf')
  })

  it('leaves the targets of a deleted top-level group in no group, with their history', async () => {
    await add('lone', 'Lonely')
    await add('nested', 'Lonely/Inner')

    expect(await deleteGroup('Lonely')).toBe(true)

    const after = await groups()
    expect(after.lone).toBe('')
    expect(after.nested).toBe('Inner')
    expect(await getGroups()).toContain('Inner')
    expect(await getGroups()).not.toContain('Lonely')
  })

  it('leaves alone groups that only look similar to the one deleted', async () => {
    await createGroup('Spares')
    await createGroup('Spare')
    expect(await deleteGroup('Spare')).toBe(true)
    expect(await getGroups()).toContain('Spares')
  })

  it('says so when there is no such group to delete', async () => {
    expect(await deleteGroup('Nowhere')).toBe(false)
    expect(await deleteGroup('')).toBe(false)
  })
})

describe('deleteEmptyGroups', () => {
  it('deletes a group chosen to go, with the empty groups inside it', async () => {
    await createGroup('Closet/Drawer')
    await createGroup('Closet/Box/Lid')
    await createGroup('Closets')
    await saveGroupOrders([{ groupName: 'Closet/Box', sortOrder: 1 }])

    expect((await deleteEmptyGroups(['Closet'])).sort()).toEqual(['Closet', 'Closet/Box', 'Closet/Box/Lid', 'Closet/Drawer'])
    const kept = await getGroups()
    expect(kept.filter(group => group === 'Closet' || group.startsWith('Closet/'))).toEqual([])
    expect(kept).toContain('Closets')
    expect((await getGroupOrders()).map(order => order.groupName)).not.toContain('Closet/Box')
  })

  it('keeps a chosen group that still has a target in it, and all it holds', async () => {
    await add('stays', 'Attic/Crate')
    await createGroup('Attic/Empty')

    expect(await deleteEmptyGroups(['Attic', ' / '])).toEqual([])
    expect(await getGroups()).toEqual(expect.arrayContaining(['Attic', 'Attic/Crate', 'Attic/Empty']))
  })
})

describe('setGroupProbeAgent', () => {
  it('points a group, and the groups inside it, at one probe agent', async () => {
    const { probeAgent } = await createProbeAgent({
      name: 'Frankfurt',
      address: '192.0.2.20',
      port: 9443,
      exposure: 'private',
    })
    await add('probe-a', 'Probe')
    await add('probe-b', 'Probe/Rack')
    await add('probe-c', 'Probes')
    await add('probe-d', 'P_obe')
    await updateTarget('probe-c', { probeAgentId: probeAgent.id })

    const database = await getDatabase()
    await new Promise<void>((resolve, reject) => {
      database.run(
        'UPDATE targets SET resolved_address = ? WHERE id = ?',
        ['192.0.2.50', 'probe-a'],
        err => (err ? reject(err) : resolve())
      )
    })

    expect(await setGroupProbeAgent('Probe', probeAgent.id)).toBe(2)

    const probes = Object.fromEntries((await getAllTargets()).map(target => [target.id, target.probeAgentId ?? null]))
    expect(probes['probe-a']).toBe(probeAgent.id)
    expect(probes['probe-b']).toBe(probeAgent.id)
    // A group that only starts with the same letters is not part of it.
    expect(probes['probe-c']).toBe(probeAgent.id)
    expect(probes['probe-d']).toBeNull()

    const cleared = await new Promise<{ resolved_address: string | null }>((resolve, reject) => {
      database.get(
        'SELECT resolved_address FROM targets WHERE id = ?',
        ['probe-a'],
        (err, row) => (err ? reject(err) : resolve(row as { resolved_address: string | null }))
      )
    })
    expect(cleared.resolved_address).toBeNull()

    expect(await setGroupProbeAgent('Probe', probeAgent.id)).toBe(0)
    expect(await setGroupProbeAgent('Probe', null)).toBe(2)
    const back = Object.fromEntries((await getAllTargets()).map(target => [target.id, target.probeAgentId ?? null]))
    expect(back['probe-a']).toBeNull()
    expect(back['probe-b']).toBeNull()
    expect(back['probe-c']).toBe(probeAgent.id)

    expect(await setGroupProbeAgent('', probeAgent.id)).toBe(0)
    expect(await setGroupProbeAgent('Missing', null)).toBe(0)
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
