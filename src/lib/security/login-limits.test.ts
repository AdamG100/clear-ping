import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

/** Who failed sign-ins can and cannot keep out, through the sign-in route itself. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-login-limits-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { initDatabase, closeDatabase } = await import('../db/database')
const store = await import('./store')
const { closeAuth, getAuth, placeholderEmail, ssoPlaceholderEmail } = await import('./auth')
const { loginLockedFor, noteLoginFailure, noteLoginSuccess } = await import('./http')
const { ssoSessionOver } = await import('./oidc')
const login = await import('@/app/api/auth/login/route')

const PASSWORD = 'a long password'

function attempt(username: string, password: string, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'ping.example' }
  if (cookie) headers.cookie = cookie
  return login.POST(new NextRequest('http://ping.example/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username, password }) }))
}

function knownDeviceCookie(response: Response): string {
  const line = response.headers.getSetCookie().find(each => each.startsWith('clearping.known_device='))
  expect(line).toBeDefined()
  return line!.split(';')[0]
}

async function fail(username: string, times: number, cookie?: string): Promise<number> {
  let status = 0
  for (let i = 0; i < times; i++) status = (await attempt(username, 'not the password', cookie)).status
  return status
}

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await initDatabase()
  await store.createUser('admin-one', PASSWORD, 'admin')
  await store.createUser('admin-two', PASSWORD, 'admin')
  await store.createUser('admin-four', PASSWORD, 'admin')
})

afterAll(async () => {
  closeAuth()
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('wrong passwords from someone else', () => {
  it('keep a new browser out, but not one that has signed in before', async () => {
    const cookie = knownDeviceCookie(await attempt('admin-one', PASSWORD))
    expect(await fail('admin-one', 8)).toBe(429)
    expect((await attempt('admin-one', PASSWORD)).status).toBe(429)
    expect((await attempt('admin-one', PASSWORD, cookie)).status).toBe(200)
  })

  it('still slow down guessing from a browser that has signed in before', async () => {
    const cookie = knownDeviceCookie(await attempt('admin-two', PASSWORD))
    expect(await fail('admin-two', 8, cookie)).toBe(429)
    expect((await attempt('admin-two', PASSWORD, cookie)).status).toBe(429)
  })

  it('do not take a mark for one account as a mark for another, or a made-up one', async () => {
    await store.createUser('admin-three', PASSWORD, 'admin')
    const another = knownDeviceCookie(await attempt('admin-four', PASSWORD))
    expect(await fail('admin-three', 8)).toBe(429)
    expect((await attempt('admin-three', PASSWORD, another)).status).toBe(429)
    expect((await attempt('admin-three', PASSWORD, 'clearping.known_device=made-up')).status).toBe(429)
  })
})

describe('the count of failures', () => {
  it('keeps recent locks when flooded with made-up names, rather than emptying', () => {
    const victim = ['user:flood-victim']
    for (let i = 0; i < 8; i++) noteLoginFailure(victim)
    expect(loginLockedFor(victim)).toBeGreaterThan(0)
    for (let i = 0; i < 9_000; i++) noteLoginFailure([`user:made-up-${i}`])
    expect(loginLockedFor(victim)).toBeGreaterThan(0)
    for (let i = 0; i < 1_100; i++) noteLoginFailure([`user:more-${i}`])
    // The oldest went once it was full, and nothing else did.
    expect(loginLockedFor(victim)).toBe(0)
    noteLoginSuccess(victim)
  })
})

describe('an account made through single sign-on', () => {
  it('has an address of its own, however alike two ids are', () => {
    expect(placeholderEmail('sso-Bob')).toBe(placeholderEmail('sso-bob'))
    expect(ssoPlaceholderEmail('Bob')).not.toBe(ssoPlaceholderEmail('bob'))
    expect(ssoPlaceholderEmail('bob+corp')).not.toBe(ssoPlaceholderEmail('bob-corp'))
    expect(ssoPlaceholderEmail('bob')).toBe(ssoPlaceholderEmail('bob'))
  })

  it('has a session that ends after a day, however much it is used', () => {
    const now = Date.now()
    expect(ssoSessionOver(new Date(now - 23 * 3_600_000), now)).toBe(false)
    expect(ssoSessionOver(new Date(now - 25 * 3_600_000), now)).toBe(true)
  })

  it('is never linked to another by a matching address', async () => {
    const auth = await getAuth()
    expect(auth.options.account.accountLinking.disableImplicitLinking).toBe(true)
  })
})
