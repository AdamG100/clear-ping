import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { base32 } from '@better-auth/utils/base32'
import { createOTP } from '@better-auth/utils/otp'

/**
 * Signing in with an authenticator app, end to end through ClearPing's own
 * routes and Better Auth's two-factor plugin behind them, on a database of
 * its own.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-two-factor-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { initDatabase, closeDatabase } = await import('../db/database')
const store = await import('./store')
const { closeAuth } = await import('./auth')
const { identify } = await import('./access')
const login = await import('@/app/api/auth/login/route')
const secondStep = await import('@/app/api/auth/two-factor/route')
const twoFactor = await import('@/app/api/security/me/two-factor/route')
const me = await import('@/app/api/security/me/route')
const security = await import('@/app/api/security/route')

const PASSWORD = 'a long password'
const SITE = 'https://ping.example'

/** A browser's cookie jar, as far as these routes go. */
class Browser {
  cookies = new Map<string, string>()
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      const expired = attributes.some(each => /max-age=0\b/i.test(each)) || value === ''
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }
  request(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const headers: Record<string, string> = { origin: SITE, host: 'ping.example', 'x-forwarded-proto': 'https' }
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (body !== undefined) headers['content-type'] = 'application/json'
    return new NextRequest(`${SITE}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
}

/** The code an authenticator app would show now, from the address it was set up with. */
async function codeFor(totpURI: string): Promise<string> {
  const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get('secret')!))
  return createOTP(secret).totp()
}

beforeAll(async () => {
  await initDatabase()
  await store.createUser('jo', PASSWORD, 'editor')
})

afterAll(async () => {
  closeAuth()
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('an authenticator app', () => {
  let totpURI = ''
  let backupCodes: string[] = []

  it('is set up with the password, and on once a code from it is right', async () => {
    const browser = new Browser()
    const signedIn = browser.take(await login.POST(browser.request('/api/auth/login', { username: 'jo', password: PASSWORD })))
    expect(signedIn.status).toBe(200)

    const wrongPassword = await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'enable', password: 'not my password' }))
    expect(wrongPassword.status).toBe(400)

    const started = browser.take(await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'enable', password: PASSWORD })))
    expect(started.status).toBe(200)
    ;({ totpURI, backupCodes } = await started.json())
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/ClearPing:/)
    expect(backupCodes).toHaveLength(10)

    // Not on until a code from the app has been seen.
    expect((await store.getUser((await store.listUsers())[0].id))?.twoFactor).toBe(false)
    expect((await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'verify', code: '000000' }))).status).toBe(400)

    const verified = browser.take(
      await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'verify', code: await codeFor(totpURI) }))
    )
    expect(verified.status).toBe(200)
    const mine = await (await me.GET(browser.request('/api/security/me'))).json()
    expect(mine).toMatchObject({ twoFactor: true, passkeys: [], owes: null })
  })

  it('is asked for after the password, and signs in with a right code', async () => {
    const browser = new Browser()
    const first = browser.take(await login.POST(browser.request('/api/auth/login', { username: 'jo', password: PASSWORD })))
    expect(await first.json()).toEqual({ twoFactor: true })
    // Not signed in yet: the password alone is not enough.
    expect((await identify(browser.request('/api/targets'))).actor).toBeNull()

    expect((await secondStep.POST(browser.request('/api/auth/two-factor', { code: '123456' }))).status).toBe(401)

    const second = browser.take(await secondStep.POST(browser.request('/api/auth/two-factor', { code: await codeFor(totpURI) })))
    expect(second.status).toBe(200)
    expect((await identify(browser.request('/api/targets'))).actor).toMatchObject({ kind: 'user', name: 'jo' })
  })

  it('takes a backup code once', async () => {
    const [code] = backupCodes
    for (const expected of [200, 401]) {
      const browser = new Browser()
      browser.take(await login.POST(browser.request('/api/auth/login', { username: 'jo', password: PASSWORD })))
      const answer = await secondStep.POST(browser.request('/api/auth/two-factor', { code, backup: true }))
      expect(answer.status).toBe(expected)
    }
  })

  it('cannot be turned off while an admin requires it, and can once they do not', async () => {
    const browser = new Browser()
    browser.take(await login.POST(browser.request('/api/auth/login', { username: 'jo', password: PASSWORD })))
    browser.take(await secondStep.POST(browser.request('/api/auth/two-factor', { code: await codeFor(totpURI) })))

    await store.setFactorPolicy({ require: 'totp', appliesTo: 'others' })
    const refused = await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'disable', password: PASSWORD }))
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toMatch(/requires an authenticator app/)

    // A passkey required instead: this account has none, so it owes one.
    await store.setFactorPolicy({ require: 'passkey', appliesTo: 'others' })
    expect((await identify(browser.request('/api/targets'))).actor).toMatchObject({ owes: { either: false, missing: ['passkey'] } })

    await store.setFactorPolicy({ require: 'none', appliesTo: 'everyone' })
    const off = await twoFactor.POST(browser.request('/api/security/me/two-factor', { action: 'disable', password: PASSWORD }))
    expect(off.status).toBe(200)
    const again = new Browser()
    const plain = await login.POST(again.request('/api/auth/login', { username: 'jo', password: PASSWORD }))
    expect(await plain.json()).toEqual({ username: 'jo' })
  })
})

describe('what an admin requires', () => {
  it('is never something the admin setting it does not have', async () => {
    await store.createUser('boss', PASSWORD, 'admin')
    const browser = new Browser()
    browser.take(await login.POST(browser.request('/api/auth/login', { username: 'boss', password: PASSWORD })))
    const put = (factorPolicy: unknown) => security.PUT(browser.request('/api/security', { factorPolicy }, 'PUT'))

    const ownToo = await put({ require: 'totp', appliesTo: 'everyone' })
    expect(ownToo.status).toBe(400)
    expect((await ownToo.json()).error).toMatch(/before requiring it/)
    expect(await store.getFactorPolicy()).toEqual({ require: 'none', appliesTo: 'everyone' })

    // Of the others only, it does not apply to the admin.
    expect((await put({ require: 'totp', appliesTo: 'others' })).status).toBe(200)
    expect(await store.getFactorPolicy()).toEqual({ require: 'totp', appliesTo: 'others' })

    expect((await put({ require: 'sms', appliesTo: 'others' })).status).toBe(400)
    expect((await put({ require: 'none', appliesTo: 'everyone' })).status).toBe(200)
  })
})
