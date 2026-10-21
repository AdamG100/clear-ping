import { afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-auth-move-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { closeDatabase, getDatabase } = await import('../db/database')
const { hashPassword } = await import('./secrets')

const OLD_KEY = 'cp_' + 'k'.repeat(43)
const REVOKED_KEY = 'cp_' + 'r'.repeat(43)
const hex = (key: string) => createHash('sha256').update(key).digest('hex')

afterAll(async () => {
  const { closeAuth } = await import('./auth')
  closeAuth()
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** An install from before Better Auth: accounts and keys in ClearPing's own tables. */
async function legacyInstall() {
  const db = await getDatabase()
  const run = (sql: string, params: unknown[]) => new Promise<void>((resolve, reject) => db.run(sql, params, error => (error ? reject(error) : resolve())))
  const now = Date.now() - 86_400_000
  await run('INSERT INTO users (id, username, password_hash, created_at, last_login_at, sso_issuer, sso_subject, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    'user-adam', 'Adam', await hashPassword('an old long password'), now, now, 'https://auth.example/', 'sub-adam', 'admin',
  ])
  await run('INSERT INTO users (id, username, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?)', ['user-sam', 'sam', '', now, 'viewer'])
  await run('INSERT INTO api_keys (id, name, prefix, key_hash, access, created_at, created_by, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    'key-old', 'Claude', OLD_KEY.slice(0, 9), hex(OLD_KEY), 'write', now, 'Adam', null,
  ])
  await run('INSERT INTO api_keys (id, name, prefix, key_hash, access, created_at, created_by, owner_id, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    'key-revoked', 'Old script', REVOKED_KEY.slice(0, 9), hex(REVOKED_KEY), 'read', now, 'sam', 'user-sam', now,
  ])
}

describe('moving to Better Auth', () => {
  it('brings accounts across with their passwords, roles and links, and keys still working', async () => {
    await legacyInstall()
    const store = await import('./store')
    const { getAuth } = await import('./auth')
    const { identify } = await import('./access')

    const users = await store.listUsers()
    expect(users.map(user => [user.id, user.username, user.role, user.sso, user.hasPassword])).toEqual([
      ['user-adam', 'Adam', 'admin', true, true],
      ['user-sam', 'sam', 'viewer', false, false],
    ])

    // The password set before the move still signs in.
    const auth = await getAuth()
    expect((await auth.api.signInUsername({ body: { username: 'adam', password: 'an old long password' }, asResponse: true })).ok).toBe(true)

    // The key made before the move still works, as the account named its maker, and the revoked one does not.
    const asKey = (key: string) => identify(new Request('https://ping.example/api/targets', { headers: { authorization: `Bearer ${key}` } }))
    expect((await asKey(OLD_KEY)).actor).toMatchObject({ kind: 'key', id: 'key-old', name: 'Claude', access: 'write' })
    expect(await asKey(REVOKED_KEY)).toEqual({ actor: null, invalidKey: true })
    expect((await store.listApiKeys()).map(key => [key.id, key.ownerId, key.revokedAt === null])).toEqual([
      ['key-old', 'user-adam', true],
      ['key-revoked', 'user-sam', false],
    ])
  })

  it('happens once', async () => {
    const { authDatabase } = await import('./auth')
    const { moveLegacyAccounts } = await import('./auth-migration')
    expect(await moveLegacyAccounts(await authDatabase())).toBeNull()
  })
})
