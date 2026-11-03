import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-probe-tags-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, getDatabase, getTargetById } = await import('./database')
const { finishProbeUpgrade, reconcileTargetProbes } = await import('./probe-tags')
const { ensureTracerouteSchema } = await import('../traceroute/store')
const { PROBE_TAGS_KEY } = await import('./migrations')

type Row = Record<string, unknown>

async function sql(statement: string, params: unknown[] = []): Promise<Row[]> {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    database.all(statement, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as Row[])))
  })
}

const MIGRATED_AT = 1_000_000

beforeAll(async () => {
  await initDatabase()
  await ensureTracerouteSchema()
  await sql("INSERT INTO probe_agents (id, name, address, port, token, created_at, updated_at) VALUES ('home', 'Home', '192.0.2.50', 8443, 'token', 0, 0)")
  for (const [id, agent] of [['remote', 'home'], ['here', null]] as const) {
    await sql(
      `INSERT INTO targets (id, name, host, probe_type, interval, status, created_at, updated_at, probe_agent_id)
       VALUES (?, ?, '192.0.2.1', 'ping', 60, 'active', 0, 0, ?)`,
      [id, id, agent]
    )
  }
  await sql("INSERT INTO target_probes (target_id, probe, position, added_at) VALUES ('remote', 'home', 0, 0), ('here', 'local', 0, 0)")
  // 12,000 readings of a monitor on a probe agent (more than two batches),
  // some taken after the migration, and a few of one that was always local.
  await sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
     INSERT INTO measurements (id, target_id, timestamp, success) SELECT 'r' || i, 'remote', i * 100, 1 FROM n`
  )
  await sql("INSERT INTO measurements (id, target_id, timestamp, success) VALUES ('h1', 'here', 5, 1)")
  await sql("INSERT INTO traceroutes (id, target_id, timestamp, trigger_source, address, hops, reached) VALUES ('t1', 'remote', 5, 'manual', '192.0.2.1', '[]', 1)")
  await sql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    PROBE_TAGS_KEY,
    JSON.stringify({ migratedAt: MIGRATED_AT, targets: { remote: { agent: 'home', cursor: 0 } }, done: false }),
  ])
})

afterAll(async () => {
  await closeDatabase()
})

describe('tagging the readings a probe agent took', () => {
  it('tags only those up to the migration, in batches, and builds the index', async () => {
    await finishProbeUpgrade(await getDatabase())

    const [{ tagged }] = await sql("SELECT COUNT(*) AS tagged FROM measurements WHERE target_id = 'remote' AND probe = 'home'")
    // i * 100 <= 1,000,000 is 10,000 readings; the other 2,000 came after.
    expect(tagged).toBe(10_000)
    const [{ local }] = await sql("SELECT COUNT(*) AS local FROM measurements WHERE target_id = 'remote' AND probe = 'local'")
    expect(local).toBe(2_000)
    expect((await sql("SELECT probe FROM measurements WHERE id = 'h1'"))[0].probe).toBe('local')
    expect((await sql("SELECT probe FROM traceroutes WHERE id = 't1'"))[0].probe).toBe('home')

    const indexes = (await sql("SELECT name FROM sqlite_master WHERE type = 'index'")).map(row => row.name)
    expect(indexes).toContain('idx_measurements_target_probe_family_timestamp')
    expect(indexes).not.toContain('idx_measurements_target_family_timestamp')
  })

  it('does nothing the second time', async () => {
    await finishProbeUpgrade(await getDatabase())
    const [{ tagged }] = await sql("SELECT COUNT(*) AS tagged FROM measurements WHERE probe = 'home'")
    expect(tagged).toBe(10_000)
  })
})

describe('starting again after an older image changed where a monitor is measured from', () => {
  it('follows the column the older image wrote, keeping the other probe as a former one', async () => {
    // The older image moved 'remote' back to the local probe and made a monitor of its own.
    await sql("UPDATE targets SET probe_agent_id = NULL WHERE id = 'remote'")
    await sql(
      `INSERT INTO targets (id, name, host, probe_type, interval, status, created_at, updated_at, probe_agent_id)
       VALUES ('made-by-old', 'Old', '192.0.2.3', 'ping', 60, 'active', 0, 0, 'home')`
    )

    await reconcileTargetProbes(await getDatabase())

    const remote = await getTargetById('remote')
    expect(remote?.probes?.map(probe => [probe.id, !!probe.former])).toEqual([['local', false], ['home', true]])
    const old = await getTargetById('made-by-old')
    expect(old?.probes?.map(probe => probe.id)).toEqual(['home'])
  })
})
