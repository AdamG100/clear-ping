import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-upgrade-progress-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, getUpgradeHistory } = await import('./database')
const { SCHEMA_VERSION } = await import('./migrations')
const { databaseOpening, upgradeProgress } = await import('./upgrade-progress')

afterAll(async () => {
  await closeDatabase()
})

describe('saying what opening the database is doing', () => {
  it('is opening until the database is ready, with each change it made, and keeps a record of them', async () => {
    const opening = initDatabase()
    expect(databaseOpening()).toBe(true)
    await opening

    const progress = upgradeProgress()
    expect(progress.phase).toBe('ready')
    expect(progress.to).toBe(SCHEMA_VERSION)
    expect(progress.steps.every(step => step.status === 'done')).toBe(true)
    expect(progress.steps.filter(step => step.id.startsWith('migration-'))).toHaveLength(SCHEMA_VERSION)

    const [record] = await getUpgradeHistory()
    expect(record).toMatchObject({ from: 0, to: SCHEMA_VERSION })
    expect(record.steps.length).toBe(progress.steps.length)
  })

  it('records nothing for a start that had nothing to do', async () => {
    await closeDatabase()
    await initDatabase()
    expect(upgradeProgress().steps).toEqual([])
    expect(await getUpgradeHistory()).toHaveLength(1)
  })
})
