import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// A folder the process must not write to, so opening the database fails the
// way a root-owned Docker bind mount does. The mode is staged before import:
// database.ts reads CLEARPING_DB_PATH when it opens, not when it loads.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-open-'))
const dataDir = path.join(root, 'data')
fs.mkdirSync(dataDir)
const dbFile = path.resolve(dataDir, 'clearping.db')
const previousDbPath = process.env.CLEARPING_DB_PATH
process.env.CLEARPING_DB_PATH = dbFile

/** Take write permission off `directory`, and give back how to restore it. */
function lockDirectory(directory: string): () => void {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME
    if (!user) throw new Error('USERNAME is not set')
    execFileSync('icacls', [directory, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(RX)`], { stdio: 'pipe' })
    return () => {
      execFileSync('icacls', [directory, '/reset'], { stdio: 'pipe' })
    }
  }
  fs.chmodSync(directory, 0o555)
  return () => {
    fs.chmodSync(directory, 0o755)
  }
}

const unlock = lockDirectory(dataDir)

function canWrite(directory: string): boolean {
  const probe = path.join(directory, '.write-probe')
  try {
    fs.writeFileSync(probe, '')
    fs.rmSync(probe)
    return true
  } catch {
    return false
  }
}

// Root ignores the mode bits, so the failure cannot be staged there.
const blocked = !canWrite(dataDir)

const previousGetuid = process.getuid
process.getuid = () => 1000

afterAll(() => {
  if (previousGetuid) process.getuid = previousGetuid
  else delete process.getuid
  if (previousDbPath === undefined) delete process.env.CLEARPING_DB_PATH
  else process.env.CLEARPING_DB_PATH = previousDbPath
  unlock()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('opening a database the process cannot write', () => {
  it.skipIf(!blocked)('tells you to give the data folder to the container user', async () => {
    const { initDatabase, closeDatabase } = await import('./database')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(initDatabase()).rejects.toThrow(
        `Cannot open the database at ${dbFile}: permission denied. It runs as uid 1000. For a Docker bind mount, on the host in the directory with the Compose file:\n\n  sudo chown -R 1000:1000 ./data\n\nor use a named volume, as the docker run examples do.`
      )
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('sudo chown -R 1000:1000 ./data'))
    } finally {
      errorLog.mockRestore()
      await closeDatabase()
    }
  })
})
