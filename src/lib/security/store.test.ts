import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-security-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { initDatabase, closeDatabase } = await import('../database')
const store = await import('./store')
const { identify, securityPolicy } = await import('./access')

function request(headers: Record<string, string> = {}) {
  return new Request('https://ping.example/api/targets', { headers })
}

beforeAll(async () => {
  await initDatabase()
})

afterAll(async () => {
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => vi.unstubAllEnvs())

describe('accounts and sessions', () => {
  it('makes an account, signs it in, and knows it by its cookie', async () => {
    const user = await store.createUser('adam', 'a long password')
    expect(await store.countUsers()).toBe(1)

    expect(await store.checkLogin('adam', 'wrong password!')).toBeNull()
    expect(await store.checkLogin('nobody', 'a long password')).toBeNull()
    expect((await store.checkLogin('ADAM', 'a long password'))?.id).toBe(user.id)

    const { token } = await store.createSession(user.id)
    const { actor } = await identify(request({ cookie: `${store.SESSION_COOKIE}=${token}` }))
    expect(actor).toEqual({ kind: 'user', id: user.id, name: 'adam' })

    await store.endSession(token)
    expect((await identify(request({ cookie: `${store.SESSION_COOKIE}=${token}` }))).actor).toBeNull()
  })

  it('will not make two accounts of one name, whatever the case', async () => {
    await expect(store.createUser('Adam', 'another long one')).rejects.toThrow('taken')
    await expect(store.createUser('bad name!', 'another long one')).rejects.toThrow('A username')
  })

  it('signs every other session out when told to', async () => {
    const [user] = await store.listUsers()
    const kept = await store.createSession(user.id)
    const other = await store.createSession(user.id)
    await store.endOtherSessions(user.id, kept.token)
    expect(await store.userForSession(kept.token)).not.toBeNull()
    expect(await store.userForSession(other.token)).toBeNull()
  })
})

describe('single sign-on accounts', () => {
  const ISSUER = 'https://auth.example/application/o/clearping/'

  it('makes an account with no password, and never takes over one that has the name', async () => {
    const made = await store.createSsoUser('adam', ISSUER, 'sub-1')
    expect(made).toMatchObject({ username: 'adam-2', sso: true, hasPassword: false })
    expect((await store.userForSso(ISSUER, 'sub-1'))?.id).toBe(made.id)
    // No password matches the empty hash an account like this has.
    expect(await store.checkLogin('adam-2', '')).toBeNull()
  })

  it('links an existing account, but not to an identity another account has', async () => {
    const [adam] = await store.listUsers()
    await expect(store.linkSso(adam.id, ISSUER, 'sub-1')).rejects.toThrow('already signs in as adam-2')
    await store.linkSso(adam.id, ISSUER, 'sub-adam')
    expect((await store.userForSso(ISSUER, 'sub-adam'))?.username).toBe('adam')
    await store.unlinkSso(adam.id)
    expect(await store.userForSso(ISSUER, 'sub-adam')).toBeNull()
  })
})

describe('keys', () => {
  it('knows a key by itself, keeps only its hash, and stops knowing it once revoked', async () => {
    const { key, record } = await store.createApiKey('Claude', 'read', 'adam')
    expect(key.startsWith(record.prefix)).toBe(true)

    expect((await identify(request({ authorization: `Bearer ${key}` }))).actor).toEqual({
      kind: 'key',
      id: record.id,
      name: 'Claude',
      access: 'read',
    })

    await store.revokeApiKey(record.id)
    expect(await identify(request({ authorization: `Bearer ${key}` }))).toEqual({ actor: null, invalidKey: true })
    expect((await store.listApiKeys()).find(each => each.id === record.id)?.revokedAt).not.toBeNull()
  })

  it('calls a made-up key invalid rather than treating it as nobody', async () => {
    expect(await identify(request({ authorization: 'Bearer cp_madeup' }))).toEqual({ actor: null, invalidKey: true })
  })

  it('still honours CLEARPING_MCP_TOKEN, as a key that may change things', async () => {
    const identity = await identify(request({ authorization: 'Bearer old-token' }), 'old-token')
    expect(identity.actor).toMatchObject({ kind: 'key', access: 'write', name: 'CLEARPING_MCP_TOKEN' })
  })
})

describe('the switches', () => {
  it('are off until turned on', async () => {
    expect(await securityPolicy()).toMatchObject({ loginRequired: false, mcpKeyRequired: false, recovery: false })
  })

  it('asks for a key at the MCP address whenever sign-in is on', async () => {
    await store.setSecuritySettings({ loginRequired: true })
    expect(await securityPolicy()).toMatchObject({ loginRequired: true, mcpKeyRequired: true })
  })

  it('are overridden by CLEARPING_AUTH=off, for getting back in', async () => {
    vi.stubEnv('CLEARPING_AUTH', 'off')
    expect(await securityPolicy()).toMatchObject({ loginRequired: false, recovery: true })
    await store.setSecuritySettings({ loginRequired: false })
  })
})

describe('activity', () => {
  it('records who did what, newest first, and pages back', async () => {
    const actor = { kind: 'key', id: 'k', name: 'GPT', access: 'write' } as const
    await store.recordActivity(actor, 'mcp', 'mcp.add_targets', '{"targets":[]}')
    await store.recordActivity(store.ANONYMOUS, 'dashboard', 'target.delete', 'Router')

    const [newest, older] = await store.listActivity(2)
    expect(newest).toMatchObject({ action: 'target.delete', actor: { kind: 'anonymous', name: 'Anonymous' }, via: 'dashboard' })
    expect(older).toMatchObject({ action: 'mcp.add_targets', actor: { kind: 'key', name: 'GPT' }, via: 'mcp' })

    const page = await store.listActivity(10, newest.id)
    expect(page[0].id).toBe(older.id)
  })
})
