import { describe, expect, it } from 'vitest'
import { decide, type Identity } from './access'
import { describeOwed, factorsOwed, isFactorPolicy, removalProblem, type FactorPolicy } from './factors'

const none = { totp: false, passkeys: 0 }
const app = { totp: true, passkeys: 0 }
const key = { totp: false, passkeys: 1 }
const both = { totp: true, passkeys: 2 }
const byPassword = { viaSso: false }

const policy = (require: FactorPolicy['require'], appliesTo: FactorPolicy['appliesTo'] = 'everyone'): FactorPolicy => ({ require, appliesTo })

describe('what an account owes', () => {
  it('owes nothing when nothing is required', () => {
    expect(factorsOwed(policy('none'), { role: 'viewer', ...none }, byPassword)).toBeNull()
  })

  it('takes either factor for "either"', () => {
    expect(factorsOwed(policy('either'), { role: 'viewer', ...none }, byPassword)).toEqual({ either: true, missing: ['totp', 'passkey'] })
    expect(factorsOwed(policy('either'), { role: 'viewer', ...app }, byPassword)).toBeNull()
    expect(factorsOwed(policy('either'), { role: 'viewer', ...key }, byPassword)).toBeNull()
  })

  it('wants the one asked for', () => {
    expect(factorsOwed(policy('totp'), { role: 'viewer', ...key }, byPassword)).toEqual({ either: false, missing: ['totp'] })
    expect(factorsOwed(policy('passkey'), { role: 'viewer', ...app }, byPassword)).toEqual({ either: false, missing: ['passkey'] })
  })

  it('wants every one missing for "both"', () => {
    expect(factorsOwed(policy('both'), { role: 'editor', ...app }, byPassword)).toEqual({ either: false, missing: ['passkey'] })
    expect(factorsOwed(policy('both'), { role: 'editor', ...none }, byPassword)).toEqual({ either: false, missing: ['totp', 'passkey'] })
    expect(factorsOwed(policy('both'), { role: 'editor', ...both }, byPassword)).toBeNull()
  })

  it('leaves admins out when it is for the others', () => {
    expect(factorsOwed(policy('both', 'others'), { role: 'admin', ...none }, byPassword)).toBeNull()
    expect(factorsOwed(policy('both', 'others'), { role: 'editor', ...none }, byPassword)).not.toBeNull()
  })

  it('asks nothing of a session made through single sign-on', () => {
    expect(factorsOwed(policy('both'), { role: 'viewer', ...none }, { viaSso: true })).toBeNull()
  })

  it('says what to add', () => {
    expect(describeOwed({ either: true, missing: ['totp', 'passkey'] })).toBe('Add an authenticator app or a passkey to your account')
    expect(describeOwed({ either: false, missing: ['totp', 'passkey'] })).toBe('Add an authenticator app and a passkey to your account')
  })
})

describe('taking a factor away', () => {
  it('is refused when it would leave the account short', () => {
    expect(removalProblem(policy('totp'), { role: 'viewer', ...both }, { factor: 'totp' })).toMatch(/requires an authenticator app/)
    expect(removalProblem(policy('either'), { role: 'viewer', ...key }, { factor: 'passkey' })).not.toBeNull()
  })

  it('is allowed when another factor still covers it', () => {
    expect(removalProblem(policy('either'), { role: 'viewer', ...both }, { factor: 'totp' })).toBeNull()
    expect(removalProblem(policy('passkey'), { role: 'viewer', ...both }, { factor: 'passkey' })).toBeNull()
    expect(removalProblem(policy('none'), { role: 'viewer', ...app }, { factor: 'totp' })).toBeNull()
  })
})

describe('the stored rule', () => {
  it('is checked before it is believed', () => {
    expect(isFactorPolicy({ require: 'both', appliesTo: 'others' })).toBe(true)
    expect(isFactorPolicy({ require: 'sms', appliesTo: 'others' })).toBe(false)
    expect(isFactorPolicy({ require: 'both' })).toBe(false)
    expect(isFactorPolicy(null)).toBe(false)
  })
})

describe('an account that owes a factor', () => {
  const owing: Identity = {
    actor: { kind: 'user', id: 'u1', name: 'jo', role: 'editor', owes: { either: true, missing: ['totp', 'passkey'] } },
    invalidKey: false,
  }
  const ask = (pathname: string, method = 'GET') =>
    decide({ pathname, method, policy: { loginRequired: true }, identity: owing, origin: 'https://ping.example', host: 'ping.example' })

  it('is sent from any page to add it', () => {
    expect(ask('/')).toEqual({ allow: false, setup: true })
    expect(ask('/settings/keys')).toEqual({ allow: false, setup: true })
  })

  it('is turned away by the API, saying why', () => {
    expect(ask('/api/targets')).toMatchObject({ allow: false, status: 403 })
    expect(ask('/api/security/keys', 'POST')).toMatchObject({ allow: false, status: 403 })
  })

  it('can reach the page that adds it, and what that page calls', () => {
    expect(ask('/security-setup')).toEqual({ allow: true })
    expect(ask('/api/security/me')).toEqual({ allow: true })
    expect(ask('/api/security/me/two-factor', 'POST')).toEqual({ allow: true })
    expect(ask('/api/security/me/passkeys', 'POST')).toEqual({ allow: true })
    expect(ask('/api/auth/logout', 'POST')).toEqual({ allow: true })
  })
})
