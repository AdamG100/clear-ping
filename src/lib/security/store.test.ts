import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-security-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { initDatabase, closeDatabase } = await import('../database')
const store = await import('./store')
const { authDatabase, closeAuth, getAuth } = await import('./auth')
const { identify, securityPolicy } = await import('./access')

const PASSWORD = 'a long password'

function request(headers: Record<string, string> = {}) {
  return new Request('https://ping.example/api/targets', { headers })
}

/** Sign in as Better Auth does for the login route; the cookie it sets, as a browser would send it back. */
async function signIn(username: string, password = PASSWORD): Promise<string | null> {
  const auth = await getAuth()
  const answer = await auth.api.signInUsername({ body: { username, password }, asResponse: true }).catch(() => null)
  if (!answer?.ok) return null
  return answer.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
}

const as = (cookie: string | null) => identify(request(cookie ? { cookie } : {}))

beforeAll(async () => {
  await initDatabase()
})

afterAll(async () => {
  closeAuth()
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => vi.unstubAllEnvs())

describe('accounts and sessions', () => {
  it('makes an account, signs it in, and knows it by its cookie', async () => {
    const user = await store.createUser('Adam', PASSWORD, 'admin')
    expect(user).toMatchObject({ username: 'Adam', role: 'admin', hasPassword: true, sso: false })
    expect(await store.countUsers()).toBe(1)

    expect(await signIn('adam', 'wrong password!')).toBeNull()
    expect(await signIn('nobody')).toBeNull()
    const cookie = await signIn('ADAM')
    expect(cookie).toContain(store.SESSION_COOKIE)
    expect((await as(cookie)).actor).toEqual({ kind: 'user', id: user.id, name: 'Adam', role: 'admin' })

    const auth = await getAuth()
    await auth.api.signOut({ headers: new Headers({ cookie: cookie! }) })
    expect((await as(cookie)).actor).toBeNull()
  })

  it('will not make two accounts of one name, whatever the case', async () => {
    await expect(store.createUser('adam', 'another long one', 'viewer')).rejects.toThrow('taken')
    await expect(store.createUser('bad name!', 'another long one', 'viewer')).rejects.toThrow('A username')
  })

  it('refuses a cookie that was tampered with', async () => {
    const cookie = await signIn('adam')
    expect((await as(cookie!.replace(/=([^.]+)\./, '=x$1.'))).actor).toBeNull()
  })

  it('checks a password without signing in', async () => {
    const [adam] = await store.listUsers()
    expect(await store.checkPassword(adam.id, PASSWORD)).toBe(true)
    expect(await store.checkPassword(adam.id, 'not it at all')).toBe(false)
  })
})

describe('sessions made through the identity provider', () => {
  /** A session as a sign-in through the provider leaves one: marked, with the provider's session id. */
  async function viaSso(username: string, sub: string, sid: string | null) {
    const cookie = await signIn(username)
    const db = await authDatabase()
    const user = (await store.listUsers()).find(each => each.username.toLowerCase() === username.toLowerCase())!
    if (!db.prepare("SELECT 1 FROM account WHERE userId = ? AND providerId = 'sso'").get(user.id)) {
      db.prepare(
        "INSERT INTO account (id, accountId, providerId, userId, idToken, createdAt, updatedAt) VALUES (?, ?, 'sso', ?, 'the.id.token', ?, ?)"
      ).run(`acct-${sub}`, sub, user.id, new Date().toISOString(), new Date().toISOString())
    }
    const token = decodeURIComponent(cookie!.split('=')[1].split('.')[0])
    db.prepare('UPDATE session SET viaSso = 1, ssoSid = ? WHERE token = ?').run(sid, token)
    return cookie
  }

  it('says which sign-in at the provider a session came from', async () => {
    await store.createUser('jo', PASSWORD, 'editor')
    const sso = await viaSso('jo', 'sub-jo', 'sid-laptop')
    const password = await signIn('jo')
    expect(await store.sessionSso(new Headers({ cookie: sso! }))).toEqual({ sid: 'sid-laptop', idToken: 'the.id.token' })
    expect(await store.sessionSso(new Headers({ cookie: password! }))).toBeNull()
    expect((await store.listUsers()).find(user => user.username === 'jo')).toMatchObject({ sso: true, hasPassword: true })
  })

  it('ends the session a sign-out at the provider names, and leaves the rest', async () => {
    const laptop = await viaSso('jo', 'sub-jo', 'sid-laptop-2')
    const phone = await viaSso('jo', 'sub-jo', 'sid-phone')
    const password = await signIn('jo')

    const ended = await store.endSsoSessions({ sub: 'sub-jo', sid: 'sid-laptop-2' })
    expect(ended.map(user => user.username)).toEqual(['jo'])
    expect((await as(laptop)).actor).toBeNull()
    expect((await as(phone)).actor).not.toBeNull()

    // Without a session id, everything they signed in to through the provider; never a password session.
    await store.endSsoSessions({ sub: 'sub-jo' })
    expect((await as(phone)).actor).toBeNull()
    expect((await as(password)).actor).not.toBeNull()
  })

  it('takes a session whose sign-in gave no id to be the one ended, when it is the same person', async () => {
    await store.createUser('sam', PASSWORD, 'viewer')
    const unnamed = await viaSso('sam', 'sub-sam', null)
    const someoneElse = await viaSso('adam', 'sub-adam', null)
    await store.endSsoSessions({ sub: 'sub-sam', sid: 'sid-anything' })
    expect((await as(unnamed)).actor).toBeNull()
    expect((await as(someoneElse)).actor).not.toBeNull()
    expect(await store.endSsoSessions({ sub: 'nobody-at-all' })).toEqual([])
  })

  it('unlinks an account from the provider', async () => {
    const sam = (await store.listUsers()).find(user => user.username === 'sam')!
    await store.unlinkSso(sam.id)
    expect(await store.getUser(sam.id)).toMatchObject({ sso: false })
  })
})

describe('keys', () => {
  it('knows a key by itself, keeps only its hash, and stops knowing it once revoked', async () => {
    const [adam] = await store.listUsers()
    const { key, record } = await store.createApiKey('Claude', 'read', { id: adam.id, name: adam.username })
    expect(key).toMatch(/^cp_[A-Za-z0-9_-]{43}$/)
    expect(key.startsWith(record.prefix)).toBe(true)
    expect(record).toMatchObject({ name: 'Claude', access: 'read', createdBy: 'Adam', ownerId: adam.id, revokedAt: null })

    expect((await identify(request({ authorization: `Bearer ${key}` }))).actor).toEqual({ kind: 'key', id: record.id, name: 'Claude', access: 'read' })
    expect((await identify(request({ 'x-api-key': key }))).actor).toMatchObject({ name: 'Claude' })

    // Only its hash is kept.
    const db = await authDatabase()
    expect(JSON.stringify(db.prepare('SELECT * FROM apikey WHERE id = ?').get(record.id))).not.toContain(key)

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

describe('roles', () => {
  it('never leaves no admin, by a change of role or by removing the account', async () => {
    const adam = (await store.listUsers()).find(user => user.username === 'Adam')!
    expect(adam.role).toBe('admin')
    await expect(store.setRole(adam.id, 'viewer')).rejects.toThrow('only admin')
    await expect(store.deleteUser(adam.id)).rejects.toThrow('only admin')

    const second = await store.createUser('second-admin', PASSWORD, 'admin')
    expect((await store.setRole(adam.id, 'editor')).role).toBe('editor')
    await expect(store.setRole(second.id, 'viewer')).rejects.toThrow('only admin')
    await store.setRole(adam.id, 'admin')
    await store.deleteUser(second.id)
  })

  it('takes a role change at once, on the next request of a session already signed in', async () => {
    const pat = await store.createUser('pat', PASSWORD, 'editor')
    const cookie = await signIn('pat')
    await store.setRole(pat.id, 'viewer')
    expect((await as(cookie)).actor).toMatchObject({ role: 'viewer' })
  })

  it('never lets a key do more than the account that made it, now', async () => {
    const lee = await store.createUser('lee', PASSWORD, 'editor')
    const { key } = await store.createApiKey("Lee's GPT", 'write', { id: lee.id, name: lee.username })
    const asKey = async () => (await identify(request({ authorization: `Bearer ${key}` }))).actor
    expect(await asKey()).toMatchObject({ access: 'write' })

    await store.setRole(lee.id, 'viewer')
    expect(await asKey()).toMatchObject({ access: 'read' })

    // Gone with the account that made it, and its sessions with it.
    const cookie = await signIn('lee')
    await store.deleteUser(lee.id)
    expect(await identify(request({ authorization: `Bearer ${key}` }))).toEqual({ actor: null, invalidKey: true })
    expect((await as(cookie)).actor).toBeNull()
  })

  it('lists only the keys an account made, when asked for its own', async () => {
    const kim = await store.createUser('kim', PASSWORD, 'viewer')
    await store.createApiKey("Kim's script", 'read', { id: kim.id, name: kim.username })
    expect((await store.listApiKeys(kim.id)).map(key => key.name)).toEqual(["Kim's script"])
    expect((await store.listApiKeys()).length).toBeGreaterThan(1)
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

  it('stop password sign-in when it is turned off, and CLEARPING_AUTH=off brings it back', async () => {
    await store.setSecuritySettings({ passwordLogin: false })
    expect(await signIn('kim')).toBeNull()
    vi.stubEnv('CLEARPING_AUTH', 'off')
    expect(await signIn('kim')).not.toBeNull()
    await store.setSecuritySettings({ passwordLogin: true })
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
