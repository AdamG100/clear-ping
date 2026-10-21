import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

/**
 * Forgotten passwords, through the routes the pages call. The primary account
 * resets its own with a code from the server's log; every other account's is
 * set by an admin, who can never set the primary account's. And a failed
 * sign-in saying why, in the log.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-reset-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { initDatabase, closeDatabase } = await import('../db/database')
const store = await import('./store')
const { closeAuth } = await import('./auth')
const login = (await import('@/app/api/auth/login/route')).POST
const reset = (await import('@/app/api/auth/password-reset/route')).POST
const setPassword = (await import('@/app/api/security/users/[id]/password/route')).PUT

const OLD = 'the old password'
const NEW = 'a brand new password'
const ORIGIN = 'http://192.168.1.20:3000'

function request(url: string, method: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`${ORIGIN}${url}`, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', host: '192.168.1.20:3000', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  })
}

const signIn = (username: string, password: string) => login(request('/api/auth/login', 'POST', { username, password }))
const ask = (username: string) => reset(request('/api/auth/password-reset', 'POST', { step: 'ask', username }))
const useCode = (code: string | undefined, password: string) =>
  reset(request('/api/auth/password-reset', 'POST', { step: 'reset', code, password }))

/** Signed in as this account: its session cookie, as a browser would send it back. */
async function cookieOf(username: string, password: string): Promise<string> {
  const answer = await signIn(username, password)
  expect(answer.status).toBe(200)
  return answer.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
}

const setPasswordOf = async (id: string, password: string, cookie: string) =>
  setPassword(request(`/api/security/users/${id}/password`, 'PUT', { password }, cookie), { params: Promise.resolve({ id }) })

/** Every line the server logged while `work` ran. */
async function logged(work: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  const log = vi.spyOn(console, 'log').mockImplementation(capture)
  const warn = vi.spyOn(console, 'warn').mockImplementation(capture)
  try {
    await work()
  } finally {
    log.mockRestore()
    warn.mockRestore()
  }
  return lines.join('\n')
}

const codeIn = (log: string) => /reset code for "[^"]+": (\S+)/.exec(log)?.[1]

let primary: Awaited<ReturnType<typeof store.createUser>>
let second: Awaited<ReturnType<typeof store.createUser>>
let editor: Awaited<ReturnType<typeof store.createUser>>

beforeAll(async () => {
  await initDatabase()
  primary = await store.createUser('Adam', OLD, 'admin')
  second = await store.createUser('Sam', OLD, 'admin')
  editor = await store.createUser('Eve', OLD, 'editor')
})

afterAll(async () => {
  closeAuth()
  await closeDatabase()
})

describe('the primary account', () => {
  it('is the oldest admin on an install from before there was one, and is kept', async () => {
    expect(await store.primaryUserId()).toBe(primary.id)
    expect((await store.getUser(primary.id))?.primary).toBe(true)
    expect((await store.getUser(second.id))?.primary).toBe(false)
  })

  it('is always an admin, and cannot be removed', async () => {
    await expect(store.setRole(primary.id, 'viewer')).rejects.toThrow(/primary account/)
    await expect(store.deleteUser(primary.id)).rejects.toThrow(/primary account/)
    expect((await store.getUser(primary.id))?.role).toBe('admin')
  })
})

describe('a code from the server log', () => {
  it('resets the primary account\'s password, once', async () => {
    let asked: Response | undefined
    const log = await logged(async () => { asked = await ask('adam') })
    expect(asked?.status).toBe(200)
    const code = codeIn(log)
    expect(code).toMatch(/^\w{20,}$/)

    expect((await useCode(code, NEW)).status).toBe(200)
    expect((await signIn('Adam', NEW)).status).toBe(200)
    expect((await signIn('Adam', OLD)).status).toBe(401)

    const again = await useCode(code, 'yet another password')
    expect(again.status).toBe(400)
    expect((await again.json()).error).toMatch(/not right, or it has run out/)
  })

  it('is never written for any other account, admin or not, and the page cannot tell', async () => {
    for (const username of ['Sam', 'Eve', 'nobody']) {
      let asked: Response | undefined
      const log = await logged(async () => { asked = await ask(username) })
      expect(await asked?.json()).toEqual({ asked: true })
      expect(codeIn(log)).toBeUndefined()
      expect(log).toMatch(username === 'nobody' ? /no account by that name/ : /not the primary account/)
    }
  })

  it('refuses a made-up code and a short password', async () => {
    expect((await useCode('madeUpCode123456789012', NEW)).status).toBe(400)
    expect((await useCode('x', 'short')).status).toBe(400)
  })
})

describe('an admin setting a password', () => {
  it('sets another account\'s, and signs it out everywhere', async () => {
    const editorSession = await cookieOf('Eve', OLD)
    expect(await store.userForHeaders(new Headers({ cookie: editorSession }))).not.toBeNull()

    const admin = await cookieOf('Sam', OLD)
    expect((await setPasswordOf(editor.id, 'eve has a new one', admin)).status).toBe(200)

    expect(await store.userForHeaders(new Headers({ cookie: editorSession }))).toBeNull()
    expect((await signIn('Eve', 'eve has a new one')).status).toBe(200)
    expect((await signIn('Eve', OLD)).status).toBe(401)
  })

  it('never sets the primary account\'s, or their own', async () => {
    const admin = await cookieOf('Sam', OLD)
    const primaryAnswer = await setPasswordOf(primary.id, 'taken over at last', admin)
    expect(primaryAnswer.status).toBe(400)
    expect((await primaryAnswer.json()).error).toMatch(/primary account/)
    expect((await signIn('Adam', 'taken over at last')).status).toBe(401)

    expect((await setPasswordOf(second.id, 'my own new password', admin)).status).toBe(400)
  })

  it('is for admins only', async () => {
    const editorSession = await cookieOf('Eve', 'eve has a new one')
    expect((await setPasswordOf(second.id, 'an editor tried', editorSession)).status).toBe(403)
  })
})

describe('a failed sign-in', () => {
  it('says only "wrong username or password" to the page, and why in the log', async () => {
    let answer: Response | undefined
    const wrongPassword = await logged(async () => { answer = await signIn('Sam', 'not the password') })
    expect(await answer?.json()).toEqual({ error: 'Wrong username or password' })
    expect(wrongPassword).toMatch(/"Sam" .* refused: the password is wrong/)

    const noAccount = await logged(async () => { answer = await signIn('ghost', 'not the password') })
    expect(await answer?.json()).toEqual({ error: 'Wrong username or password' })
    expect(noAccount).toMatch(/"ghost" .* refused: there is no account by that name/)
  })
})
