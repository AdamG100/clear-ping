import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A database the process may read but not write, as one restored or copied in
 * by root is to a container running as uid 1000. Said plainly, with what fixes
 * it, before any change is tried; and opened once it is fixed.
 */

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-readonly-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase } = await import('./database')
const { upgradeProgress } = await import('./upgrade-progress')

afterAll(async () => {
  fs.chmodSync(dbFile, 0o644)
  await closeDatabase()
})

describe('a database that cannot be written', () => {
  it('says which file and how to fix it, changes nothing, and opens once it is fixed', async () => {
    await initDatabase()
    await closeDatabase()
    for (const extra of ['-wal', '-shm']) fs.rmSync(dbFile + extra, { force: true })
    fs.chmodSync(dbFile, 0o444)

    await expect(initDatabase()).rejects.toThrow(/can be read but not changed/)
    expect(upgradeProgress().phase).toBe('failed')
    expect(upgradeProgress().error).toContain(dbFile)

    fs.chmodSync(dbFile, 0o644)
    await initDatabase()
    expect(upgradeProgress().phase).toBe('ready')
  })
})
