import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

/** What the proxy lets through and what it adds, on a database of its own. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-proxy-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')

const { initDatabase, closeDatabase } = await import('./lib/db/database')
const { closeAuth } = await import('./lib/security/auth')
const { setSecuritySettings } = await import('./lib/security/settings-store')
const { proxy } = await import('./proxy')

function asked(pathname: string, host: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(`http://${host}${pathname}`, { headers: { host, ...headers } }))
}

beforeAll(async () => {
  await initDatabase()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await setSecuritySettings({ loginRequired: false })
})

afterAll(async () => {
  closeAuth()
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a name that is not listed, with CLEARPING_ALLOWED_HOSTS unset', () => {
  it('is refused while sign-in is off, whichever door it comes to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const url of ['/api/targets', '/api/alerts', '/', '/api/mcp']) {
      expect((await asked(url, 'rebound.example')).status).toBe(421)
    }
  })

  it('is refused when only the proxy in front names it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await asked('/api/targets', 'clearping:3000', { 'x-forwarded-host': 'rebound.example' })).status).toBe(421)
  })

  it('is answered at an address, or a name no website can own', async () => {
    for (const host of ['192.0.2.10:3000', '[2001:db8::1]:3000', 'localhost:3000', 'clearping:3000', 'ping.lan', 'ping.local', 'ping.internal', 'ping.home.arpa']) {
      expect((await asked('/api/targets', host)).status, host).toBe(200)
    }
  })

  it('is answered once sign-in is on, when a request has a session to prove', async () => {
    await setSecuritySettings({ loginRequired: true })
    expect((await asked('/api/targets', 'ping.example')).status).toBe(401)
  })

  it('leaves the health check alone', async () => {
    expect((await asked('/api/health', 'rebound.example')).status).toBe(200)
  })
})

describe('with CLEARPING_ALLOWED_HOSTS set', () => {
  it('answers what is listed, and nothing else, even an address', async () => {
    vi.stubEnv('CLEARPING_ALLOWED_HOSTS', 'ping.example')
    expect((await asked('/api/targets', 'ping.example')).status).toBe(200)
    expect((await asked('/api/targets', 'rebound.example')).status).toBe(421)
    expect((await asked('/api/targets', '192.0.2.10')).status).toBe(421)
  })
})

describe('what a page is sent with', () => {
  it('a policy with a nonce of its own, handed to the page too', async () => {
    const first = await asked('/', 'localhost:3000')
    const policy = first.headers.get('content-security-policy')!
    expect(policy).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/)
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain('upgrade-insecure-requests')
    expect(first.headers.get('x-middleware-request-x-nonce')).toBe(/'nonce-([^']+)'/.exec(policy)![1])

    const second = await asked('/', 'localhost:3000')
    expect(second.headers.get('content-security-policy')).not.toBe(policy)
  })

  it('the same on the sign-in page, which is open to anyone', async () => {
    expect((await asked('/login', 'localhost:3000')).headers.get('content-security-policy')).toContain('nonce-')
  })

  it('no policy on an API answer', async () => {
    expect((await asked('/api/targets', 'localhost:3000')).headers.get('content-security-policy')).toBeNull()
  })

  it('HSTS only over HTTPS', async () => {
    expect((await asked('/', 'localhost:3000')).headers.get('strict-transport-security')).toBeNull()
    const secure = await asked('/', 'localhost:3000', { 'x-forwarded-proto': 'https' })
    expect(secure.headers.get('strict-transport-security')).toMatch(/^max-age=\d+$/)
  })
})
