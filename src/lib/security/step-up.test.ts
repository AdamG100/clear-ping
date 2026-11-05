import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { base32 } from '@better-auth/utils/base32'
import { createOTP } from '@better-auth/utils/otp'

/**
 * Whether a required factor is really asked for at sign-in, through
 * ClearPing's own routes and Better Auth behind them. The browser's passkey
 * prompt cannot run here, so Better Auth's check of what it signed is stood in
 * for: it answers as it does for a good passkey, with a real session.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-step-up-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { initDatabase, closeDatabase } = await import('../db/database')
const store = await import('./store')
const { authDatabase, closeAuth, getAuth } = await import('./auth')
const { setFactorPolicy } = await import('./settings-store')
const { identify } = await import('./access')
const login = await import('@/app/api/auth/login/route')
const secondStep = await import('@/app/api/auth/two-factor/route')
const passkeyRoute = await import('@/app/api/auth/passkey/route')
const twoFactor = await import('@/app/api/security/me/two-factor/route')

const PASSWORD = 'a long password'
const SITE = 'https://ping.example'

class Browser {
  cookies = new Map<string, string>()
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (attributes.some(each => /max-age=0\b/i.test(each)) || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }
  request(url: string, body?: unknown) {
    const headers: Record<string, string> = { origin: SITE, host: 'ping.example', 'x-forwarded-proto': 'https' }
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (body !== undefined) headers['content-type'] = 'application/json'
    return new NextRequest(`${SITE}${url}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  async signedIn() {
    return (await identify(this.request('/api/targets'))).actor
  }
  async password(username: string) {
    return this.take(await login.POST(this.request('/api/auth/login', { username, password: PASSWORD })))
  }
  async code(value: string) {
    return this.take(await secondStep.POST(this.request('/api/auth/two-factor', { code: value })))
  }
}

async function codeFor(uri: string): Promise<string> {
  const secret = new TextDecoder().decode(base32.decode(new URL(uri).searchParams.get('secret')!))
  return createOTP(secret).totp()
}

/** The URI an authenticator app is set up from, for an account now using one. */
async function giveApp(username: string): Promise<string> {
  const browser = new Browser()
  await browser.password(username)
  const started = await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'enable', password: PASSWORD }))
  const { totpURI } = await browser.take(started).json()
  browser.take(await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'verify', code: await codeFor(totpURI) })))
  return totpURI
}

async function givePasskey(username: string) {
  const db = await authDatabase()
  const user = await store.findUserByUsername(username)
  db.prepare(
    `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt)
     VALUES (?, 'test', 'key', ?, ?, 0, 'singleDevice', 0, ?)`
  ).run(`pk-${username}`, user!.id, `cred-${username}`, Date.now())
}

/** Sign in with a passkey, Better Auth having accepted what it signed. */
async function usePasskey(browser: Browser, username: string) {
  const auth = await getAuth('ping.example')
  const user = await store.findUserByUsername(username)
  const context = await auth.$context
  const session = await context.internalAdapter.createSession(user!.id)
  const cookie = await context.createAuthCookie('session_token')
  const spy = vi.spyOn(auth.api, 'verifyPasskeyAuthentication').mockResolvedValueOnce(
    new Response(JSON.stringify({ session }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': `${cookie.name}=${session.token}; Path=/; HttpOnly` },
    }) as never
  )
  const answer = browser.take(await passkeyRoute.POST(browser.request('/api/auth/passkey', { step: 'verify', response: { id: 'x' } })))
  spy.mockRestore()
  return { answer, token: session.token, context }
}

let appUri = ''
let appOnlyUri = ''

beforeAll(async () => {
  await initDatabase()
  await store.createUser('passkey-only', PASSWORD, 'editor')
  await givePasskey('passkey-only')
  await store.createUser('app-only', PASSWORD, 'editor')
  appOnlyUri = await giveApp('app-only')
  await store.createUser('nothing', PASSWORD, 'editor')
  await store.createUser('admin-passkey', PASSWORD, 'admin')
  await givePasskey('admin-passkey')
  await store.createUser('both', PASSWORD, 'editor')
  appUri = await giveApp('both')
  await givePasskey('both')
})

afterAll(async () => {
  closeAuth()
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await setFactorPolicy({ require: 'none', appliesTo: 'everyone' })
})

describe('a password, for an account with a passkey', () => {
  for (const require of ['passkey', 'either', 'both'] as const) {
    it(`gets no session under "${require}", only a request for the passkey`, async () => {
      await setFactorPolicy({ require, appliesTo: 'everyone' })
      const browser = new Browser()
      const answer = await browser.password('passkey-only')
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual({ passkey: true })
      expect(await browser.signedIn()).toBeNull()
    })
  }

  it('leaves no session behind in the database', async () => {
    await setFactorPolicy({ require: 'passkey', appliesTo: 'everyone' })
    const db = await authDatabase()
    const user = await store.findUserByUsername('passkey-only')
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?').get(user!.id) as { n: number }).n
    const before = count()
    await new Browser().password('passkey-only')
    expect(count()).toBe(before)
  })

  it('is enough with no requirement, and for an admin the requirement leaves out', async () => {
    const browser = new Browser()
    await browser.password('passkey-only')
    expect((await browser.signedIn())?.kind).toBe('user')

    await setFactorPolicy({ require: 'passkey', appliesTo: 'others' })
    const admin = new Browser()
    await admin.password('admin-passkey')
    expect((await admin.signedIn())?.kind).toBe('user')
  })

  it('is enough to go and add a factor the account does not have yet', async () => {
    await setFactorPolicy({ require: 'passkey', appliesTo: 'everyone' })
    const browser = new Browser()
    await browser.password('nothing')
    expect(await browser.signedIn()).toMatchObject({ kind: 'user', owes: { missing: ['passkey'] } })
  })

  it('is enough while CLEARPING_AUTH=off is set', async () => {
    await setFactorPolicy({ require: 'passkey', appliesTo: 'everyone' })
    process.env.CLEARPING_AUTH = 'off'
    try {
      const browser = new Browser()
      await browser.password('passkey-only')
      expect((await browser.signedIn())?.kind).toBe('user')
    } finally {
      delete process.env.CLEARPING_AUTH
    }
  })
})

describe('the code, then the passkey', () => {
  it('asks a passkey-only policy for the passkey rather than the code', async () => {
    await setFactorPolicy({ require: 'passkey', appliesTo: 'everyone' })
    const browser = new Browser()
    expect(await (await browser.password('both')).json()).toEqual({ passkey: true })
  })

  it('takes the code alone under "either" and "totp"', async () => {
    for (const require of ['either', 'totp'] as const) {
      await setFactorPolicy({ require, appliesTo: 'everyone' })
      const browser = new Browser()
      expect(await (await browser.password('app-only')).json()).toEqual({ twoFactor: true })
      await browser.code(await codeFor(appOnlyUri))
      expect((await browser.signedIn())?.kind).toBe('user')
    }
  })

  it('needs both under "both": the code gives no session, the passkey after it does', async () => {
    await setFactorPolicy({ require: 'both', appliesTo: 'everyone' })
    const browser = new Browser()
    expect(await (await browser.password('both')).json()).toEqual({ twoFactor: true })
    const coded = await browser.code(await codeFor(appUri))
    expect(await coded.json()).toEqual({ passkey: true })
    expect(await browser.signedIn()).toBeNull()

    const { answer, token, context } = await usePasskey(browser, 'both')
    expect(answer.status).toBe(200)
    expect(await context.internalAdapter.findSession(token)).not.toBeNull()
    expect([...browser.cookies.values()]).toContain(token)
  })
})

describe('a passkey on its own', () => {
  it('signs in where it is what is required', async () => {
    await setFactorPolicy({ require: 'passkey', appliesTo: 'everyone' })
    const browser = new Browser()
    const { answer, token, context } = await usePasskey(browser, 'passkey-only')
    expect(answer.status).toBe(200)
    expect(await context.internalAdapter.findSession(token)).not.toBeNull()
    expect([...browser.cookies.values()]).toContain(token)
  })

  for (const require of ['totp', 'both'] as const) {
    it(`is refused under "${require}" for an account that has the app, and its session ended`, async () => {
      await setFactorPolicy({ require, appliesTo: 'everyone' })
      const browser = new Browser()
      const { answer, token, context } = await usePasskey(browser, 'both')
      expect(answer.status).toBe(403)
      expect(await context.internalAdapter.findSession(token)).toBeNull()
      expect(await browser.signedIn()).toBeNull()
    })
  }

  it("does not count another account's code", async () => {
    await setFactorPolicy({ require: 'both', appliesTo: 'everyone' })
    const browser = new Browser()
    await browser.password('both')
    await browser.code(await codeFor(appUri))
    await store.createUser('both-two', PASSWORD, 'editor')
    await giveApp('both-two')
    await givePasskey('both-two')
    const { answer } = await usePasskey(browser, 'both-two')
    expect(answer.status).toBe(403)
  })

  it('counts a code only once', async () => {
    await setFactorPolicy({ require: 'both', appliesTo: 'everyone' })
    const browser = new Browser()
    await browser.password('both')
    await browser.code(await codeFor(appUri))
    const proof = [...browser.cookies].find(([name]) => name.includes('totp_proved'))!
    expect((await usePasskey(browser, 'both')).answer.status).toBe(200)

    const again = new Browser()
    again.cookies.set(proof[0], proof[1])
    expect((await usePasskey(again, 'both')).answer.status).toBe(403)
  })
})
