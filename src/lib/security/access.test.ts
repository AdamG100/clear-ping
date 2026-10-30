import { describe, expect, it } from 'vitest'
import { crossSite, decide, hostAllowed, presentedKey, readCookie, routeKind, type Identity } from './access'

const nobody: Identity = { actor: null, invalidKey: false }
const user: Identity = { actor: { kind: 'user', id: 'u1', name: 'adam', role: 'admin' }, invalidKey: false }
const editor: Identity = { actor: { kind: 'user', id: 'u2', name: 'jo', role: 'editor' }, invalidKey: false }
const viewer: Identity = { actor: { kind: 'user', id: 'u3', name: 'sam', role: 'viewer' }, invalidKey: false }
const reader: Identity = { actor: { kind: 'key', id: 'k1', name: 'Claude', access: 'read' }, invalidKey: false }
const writer: Identity = { actor: { kind: 'key', id: 'k2', name: 'GPT', access: 'write' }, invalidKey: false }
const badKey: Identity = { actor: null, invalidKey: true }

const on = { loginRequired: true }
const off = { loginRequired: false }
const site = { origin: 'https://ping.example', host: 'ping.example' }

function ask(pathname: string, method: string, policy: { loginRequired: boolean }, identity: Identity, from = site) {
  return decide({ pathname, method, policy, identity, ...from })
}

describe('routeKind', () => {
  it.each([
    ['/login', 'open'],
    ['/api/auth/login', 'open'],
    ['/api/health', 'open'],
    ['/api/mcp', 'open'],
    ['/api/mcp/info', 'open'],
    ['/api/targets', 'api'],
    ['/api/security/keys', 'api'],
    ['/', 'page'],
  ])('%s is %s', (path, kind) => {
    expect(routeKind(path)).toBe(kind)
  })
})

describe('decide, with sign-in off', () => {
  it('lets everyone in, as before', () => {
    expect(ask('/', 'GET', off, nobody)).toEqual({ allow: true })
    expect(ask('/api/targets', 'POST', off, nobody)).toEqual({ allow: true })
  })

  it('still turns away a key that is wrong, rather than carrying on as nobody', () => {
    expect(ask('/api/targets', 'GET', off, badKey)).toMatchObject({ allow: false, status: 401 })
  })

  it('still holds a read-only key to reading', () => {
    expect(ask('/api/targets', 'POST', off, reader)).toMatchObject({ allow: false, status: 403 })
    expect(ask('/api/targets', 'GET', off, reader)).toEqual({ allow: true })
  })
})

describe('decide, with sign-in on', () => {
  it('sends someone not signed in to sign in', () => {
    expect(ask('/', 'GET', on, nobody)).toEqual({ allow: false, signIn: true })
  })

  it('does not take a key in place of signing in to the dashboard pages', () => {
    expect(ask('/', 'GET', on, writer)).toEqual({ allow: false, signIn: true })
  })

  it('refuses the API to nobody', () => {
    expect(ask('/api/targets', 'GET', on, nobody)).toMatchObject({ allow: false, status: 401 })
  })

  it('opens the API to a signed-in user and to keys, each as far as it may go', () => {
    expect(ask('/api/targets', 'DELETE', on, user)).toEqual({ allow: true })
    expect(ask('/api/targets', 'GET', on, reader)).toEqual({ allow: true })
    expect(ask('/api/targets', 'PATCH', on, reader)).toMatchObject({ allow: false, status: 403 })
    expect(ask('/api/targets', 'POST', on, writer)).toEqual({ allow: true })
  })

  it('refuses a change made with the cookie from another site', () => {
    const elsewhere = { origin: 'https://evil.example', host: 'ping.example' }
    expect(ask('/api/targets', 'POST', on, user, elsewhere)).toMatchObject({ allow: false, status: 403 })
    expect(ask('/api/targets', 'GET', on, user, elsewhere)).toEqual({ allow: true })
  })

  it('lets an editor change what is monitored, and a viewer only look', () => {
    expect(ask('/api/targets', 'POST', on, editor)).toEqual({ allow: true })
    expect(ask('/api/alerts', 'POST', on, editor)).toEqual({ allow: true })
    expect(ask('/api/targets', 'GET', on, viewer)).toEqual({ allow: true })
    for (const [path, method] of [['/api/targets', 'POST'], ['/api/targets/t1', 'DELETE'], ['/api/alerts/a1', 'PATCH'], ['/api/targets/t1/probe', 'POST']]) {
      expect(ask(path, method, on, viewer)).toMatchObject({ allow: false, status: 403 })
    }
  })

  it('leaves Settings to its own routes, which know what each role may do there', () => {
    // A viewer may still change their own password and make keys of their own.
    expect(ask('/api/security/password', 'PUT', on, viewer)).toEqual({ allow: true })
    expect(ask('/api/security/keys', 'POST', on, viewer)).toEqual({ allow: true })
    // And the switches themselves, whose route answers that only an admin may.
    expect(ask('/api/security', 'PUT', on, viewer)).toEqual({ allow: true })
    expect(ask('/api/securityx', 'POST', on, viewer)).toMatchObject({ allow: false, status: 403 })
  })

  it('leaves the sign-in page, its API and the MCP address to look after themselves', () => {
    expect(ask('/login', 'GET', on, nobody)).toEqual({ allow: true })
    expect(ask('/api/auth/login', 'POST', on, nobody)).toEqual({ allow: true })
    expect(ask('/api/mcp', 'POST', on, nobody)).toEqual({ allow: true })
  })
})

describe('decide, with sign-in needed only to change things', () => {
  const looking = { loginRequired: false, changesNeedSignIn: true }
  const askHere = (pathname: string, method: string, identity: Identity) => decide({ pathname, method, policy: looking, identity, ...site })

  it('lets anyone look, at the pages and the API', () => {
    expect(askHere('/', 'GET', nobody)).toEqual({ allow: true })
    expect(askHere('/api/targets', 'GET', nobody)).toEqual({ allow: true })
  })

  it('turns away a change from nobody', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(askHere('/api/targets', method, nobody)).toMatchObject({ allow: false, status: 401 })
    }
  })

  it('takes a change from an account that may make it, or a key that may write', () => {
    expect(askHere('/api/targets', 'POST', user)).toEqual({ allow: true })
    expect(askHere('/api/targets', 'POST', editor)).toEqual({ allow: true })
    expect(askHere('/api/targets', 'POST', writer)).toEqual({ allow: true })
  })

  it('still holds a viewer and a read-only key to looking', () => {
    expect(askHere('/api/targets', 'POST', viewer)).toMatchObject({ allow: false, status: 403 })
    expect(askHere('/api/targets', 'POST', reader)).toMatchObject({ allow: false, status: 403 })
  })

  it('leaves sign-in itself and the MCP address to look after themselves', () => {
    expect(askHere('/api/auth/login', 'POST', nobody)).toEqual({ allow: true })
    expect(askHere('/api/mcp', 'POST', nobody)).toEqual({ allow: true })
  })
})

describe('decide, for a website an admin listed', () => {
  const listed = { origin: 'https://home.example', host: 'ping.example' }
  const withCors = (policy: { loginRequired: boolean; changesNeedSignIn?: boolean }, identity: Identity) =>
    decide({ pathname: '/api/targets', method: 'POST', policy, identity, ...listed, fetchSite: 'cross-site', trustedOrigin: true })

  it('may change things with a key', () => {
    expect(withCors(on, writer)).toEqual({ allow: true })
    expect(withCors(on, reader)).toMatchObject({ allow: false, status: 403 })
  })

  it('is nobody without one, so asked for a key where sign-in is on', () => {
    expect(withCors(on, nobody)).toMatchObject({ allow: false, status: 401 })
    expect(withCors({ loginRequired: false, changesNeedSignIn: true }, nobody)).toMatchObject({ allow: false, status: 401 })
  })

  it('is not held to the same-site rule, which is for cookies', () => {
    expect(withCors(off, nobody)).toEqual({ allow: true })
    expect(decide({ pathname: '/api/targets', method: 'POST', policy: off, identity: nobody, ...listed, fetchSite: 'cross-site' })).toMatchObject({ allow: false, status: 403 })
  })
})

describe('reading credentials', () => {
  it('finds the session cookie among others', () => {
    expect(readCookie('theme=dark; clearping_session=abc%3D; x=1', 'clearping_session')).toBe('abc=')
    expect(readCookie(null, 'clearping_session')).toBeNull()
  })

  it('takes a key as a bearer token or an X-API-Key header', () => {
    expect(presentedKey(new Headers({ Authorization: 'Bearer cp_abc' }))).toBe('cp_abc')
    expect(presentedKey(new Headers({ 'X-API-Key': 'cp_def' }))).toBe('cp_def')
    expect(presentedKey(new Headers())).toBeNull()
  })
})

describe('changes from another site', () => {
  const evil = { origin: 'https://evil.example', host: 'ping.example' }

  it('are refused with sign-in off too, where there is no cookie to wait for', () => {
    expect(ask('/api/alerts', 'POST', off, nobody, evil)).toMatchObject({ allow: false, status: 403 })
  })

  it('are refused by Sec-Fetch-Site even when no Origin is sent', () => {
    for (const fetchSite of ['cross-site', 'same-site']) {
      expect(decide({ pathname: '/api/targets', method: 'POST', policy: off, identity: nobody, origin: null, host: 'ping.example', fetchSite })).toMatchObject({ allow: false, status: 403 })
    }
    expect(decide({ pathname: '/api/targets', method: 'POST', policy: off, identity: nobody, origin: null, host: 'ping.example', fetchSite: 'same-origin' })).toEqual({ allow: true })
  })

  it('are refused on the sign-in API, which would otherwise make the first account', () => {
    expect(ask('/api/auth/register', 'POST', off, nobody, evil)).toMatchObject({ allow: false, status: 403 })
    expect(ask('/api/auth/register', 'POST', off, nobody)).toEqual({ allow: true })
  })

  it('do not stop keys, which a browser does not send on its own', () => {
    expect(ask('/api/targets', 'POST', on, writer, evil)).toEqual({ allow: true })
  })

  it('do not stop reading', () => {
    expect(ask('/api/targets', 'GET', off, nobody, evil)).toEqual({ allow: true })
  })
})

describe('crossSite', () => {
  it('trusts a script that sends neither header', () => {
    expect(crossSite(null, 'ping.example', null)).toBe(false)
  })
})

describe('hostAllowed', () => {
  it('accepts anything when no list is set', () => {
    expect(hostAllowed('anything.example', undefined)).toBe(true)
    expect(hostAllowed(null, '')).toBe(true)
  })

  it('accepts a listed name with or without its port, in any case', () => {
    expect(hostAllowed('Ping.Example', 'ping.example')).toBe(true)
    expect(hostAllowed('ping.example:8443', 'ping.example')).toBe(true)
    expect(hostAllowed('192.168.1.5:3000', 'ping.example, 192.168.1.5:3000')).toBe(true)
  })

  it('refuses another name, a missing one, and a listed name on a port that is not', () => {
    expect(hostAllowed('evil.example', 'ping.example')).toBe(false)
    expect(hostAllowed(null, 'ping.example')).toBe(false)
    expect(hostAllowed('192.168.1.5:9999', '192.168.1.5:3000')).toBe(false)
  })
})
