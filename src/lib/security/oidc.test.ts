import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  authorizationUrl,
  decodePending,
  discover,
  encodePending,
  endSessionUrl,
  inAllowedGroup,
  newPending,
  usernameFrom,
  verifyIdToken,
  verifyLogoutToken,
  SSO_DEFAULTS,
  type Claims,
  type Discovery,
} from './oidc'

const ISSUER = 'https://auth.example/application/o/clearping/'
const discovery: Discovery = {
  issuer: ISSUER,
  authorization_endpoint: 'https://auth.example/application/o/authorize/',
  token_endpoint: 'https://auth.example/application/o/token/',
  jwks_uri: 'https://auth.example/application/o/clearping/jwks/',
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const NOW = 1_800_000_000_000

function claims(overrides: Partial<Claims> = {}): Claims {
  return {
    iss: ISSUER,
    sub: 'abc123',
    aud: 'client-1',
    exp: NOW / 1000 + 300,
    iat: NOW / 1000,
    nonce: 'n-1',
    preferred_username: 'adam',
    groups: ['clearping-users'],
    ...overrides,
  }
}

function rs256(payload: object, kid = 'k1'): string {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' })
  const body = b64(payload)
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

function hs256(payload: object, secret: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(payload)
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`
}

const keys = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }))
const options = { discovery, clientId: 'client-1', clientSecret: 'secret-1', nonce: 'n-1', now: NOW, fetchFn: keys as unknown as typeof fetch }

describe('verifyIdToken', () => {
  it('accepts a token signed with the provider\'s key, for this application and this sign-in', async () => {
    await expect(verifyIdToken(rs256(claims()), options)).resolves.toMatchObject({ sub: 'abc123' })
  })

  it('accepts one signed with the client secret, which is how Authentik signs without a key', async () => {
    await expect(verifyIdToken(hs256(claims(), 'secret-1'), options)).resolves.toMatchObject({ sub: 'abc123' })
    await expect(verifyIdToken(hs256(claims(), 'guessed'), options)).rejects.toThrow('signature')
  })

  it('refuses a token whose contents were changed after signing', async () => {
    const [head, , signature] = rs256(claims()).split('.')
    await expect(verifyIdToken(`${head}.${b64(claims({ sub: 'someone-else' }))}.${signature}`, options)).rejects.toThrow('signature')
  })

  it('refuses an unsigned token', async () => {
    await expect(verifyIdToken(`${b64({ alg: 'none' })}.${b64(claims())}.`, options)).rejects.toThrow('not accepted')
  })

  it.each([
    ['another issuer', { iss: 'https://evil.example/' }, 'another issuer'],
    ['another application', { aud: 'client-2' }, 'another application'],
    ['another sign-in', { nonce: 'n-2' }, 'not the answer'],
    ['an expired token', { exp: NOW / 1000 - 3600 }, 'expired'],
  ])('refuses %s', async (_, change, message) => {
    await expect(verifyIdToken(rs256(claims(change)), options)).rejects.toThrow(message)
  })

  it('looks again for a key it has not seen, as after the provider rotates its keys', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k2' }] })))
    const fresh = { ...discovery, jwks_uri: 'https://auth.example/rotated/jwks/' }
    await expect(verifyIdToken(rs256(claims(), 'k2'), { ...options, discovery: fresh, fetchFn })).resolves.toMatchObject({ sub: 'abc123' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('verifyLogoutToken', () => {
  const EVENT = { 'http://schemas.openid.net/event/backchannel-logout': {} }
  const logoutOptions = { discovery, clientId: 'client-1', clientSecret: 'secret-1', now: NOW, fetchFn: keys as unknown as typeof fetch }
  let n = 0
  const logout = (overrides: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: 'client-1',
    iat: NOW / 1000,
    jti: `jti-${++n}`,
    events: EVENT,
    sub: 'abc123',
    sid: 'session-1',
    ...overrides,
  })

  it('takes a signed logout token for this application, naming the person and their session', async () => {
    await expect(verifyLogoutToken(rs256(logout()), logoutOptions)).resolves.toEqual({ iss: ISSUER, sub: 'abc123', sid: 'session-1' })
    await expect(verifyLogoutToken(hs256(logout({ sid: undefined }), 'secret-1'), logoutOptions)).resolves.toEqual({
      iss: ISSUER,
      sub: 'abc123',
      sid: undefined,
    })
  })

  it.each([
    ['one signed by someone else', () => hs256(logout(), 'guessed'), 'signature'],
    ['one for another application', () => rs256(logout({ aud: 'client-2' })), 'another application'],
    ['one from another issuer', () => rs256(logout({ iss: 'https://evil.example/' })), 'another issuer'],
    ['an ID token passed off as one', () => rs256(claims()), 'not a logout token'],
    ['one carrying a nonce', () => rs256(logout({ nonce: 'n-1' })), 'no nonce'],
    ['one naming nobody', () => rs256(logout({ sub: undefined, sid: undefined })), 'whose sign-in'],
    ['an old one', () => rs256(logout({ iat: NOW / 1000 - 3600 })), 'too old'],
    ['an unsigned one', () => `${b64({ alg: 'none' })}.${b64(logout())}.`, 'not accepted'],
  ])('refuses %s', async (_, token, message) => {
    await expect(verifyLogoutToken(token(), logoutOptions)).rejects.toThrow(message)
  })

  it('refuses the same token sent twice', async () => {
    const token = rs256(logout({ jti: 'once-only' }))
    await expect(verifyLogoutToken(token, logoutOptions)).resolves.toMatchObject({ sub: 'abc123' })
    await expect(verifyLogoutToken(token, logoutOptions)).rejects.toThrow('used already')
  })
})

describe('endSessionUrl', () => {
  const config = { ...SSO_DEFAULTS, clientId: 'client-1' }

  it('asks the provider to sign out, showing the ID token and where to come back to', () => {
    const url = new URL(
      endSessionUrl({ ...discovery, end_session_endpoint: `${ISSUER}end-session/` }, config, 'the.id.token', 'https://ping.example/login')!
    )
    expect(url.origin + url.pathname).toBe(`${ISSUER}end-session/`)
    expect(url.searchParams.get('id_token_hint')).toBe('the.id.token')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://ping.example/login')
    expect(url.searchParams.get('client_id')).toBe('client-1')
  })

  it('has nowhere to send the browser when the provider has no end-session address', () => {
    expect(endSessionUrl(discovery, config, 'the.id.token', 'https://ping.example/login')).toBeNull()
  })
})

describe('discover', () => {
  it('refuses a provider that says it is some other issuer', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ...discovery, issuer: 'https://other.example/' })))
    await expect(discover('https://auth.example/application/o/elsewhere/', fetchFn as unknown as typeof fetch)).rejects.toThrow('says its issuer')
  })
})

describe('the way there and back', () => {
  it('asks with PKCE, a state and a nonce', () => {
    const pending = newPending('/', false)
    const url = new URL(authorizationUrl(discovery, { ...SSO_DEFAULTS, clientId: 'client-1', redirectUri: 'https://ping.example/api/auth/sso/callback' }, pending))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(url.searchParams.get('nonce')).toBe(pending.nonce)
    expect(url.searchParams.get('scope')).toContain('openid')
  })

  it('carries only a path on this site to come back to', () => {
    const elsewhere = encodePending({ ...newPending('/', false), next: '//evil.example' })
    expect(decodePending(elsewhere)?.next).toBe('/')
    expect(decodePending('not a cookie')).toBeNull()
  })
})

describe('who it is', () => {
  it('names an account after the provider\'s username', () => {
    expect(usernameFrom(claims())).toBe('adam')
    expect(usernameFrom(claims({ preferred_username: undefined, email: 'sam@example.com' }))).toBe('sam')
  })

  it('lets in only the group asked for, when one is', () => {
    expect(inAllowedGroup(claims(), '')).toBe(true)
    expect(inAllowedGroup(claims(), 'ClearPing-Users')).toBe(true)
    expect(inAllowedGroup(claims({ groups: ['other'] }), 'clearping-users')).toBe(false)
    expect(inAllowedGroup(claims({ groups: undefined }), 'clearping-users')).toBe(false)
  })
})
