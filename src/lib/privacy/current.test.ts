import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PRIVACY, holdPrivacy, signInDetail } from './current'
import { parsePrivacySettings } from './settings'

afterEach(() => holdPrivacy(DEFAULT_PRIVACY))

describe('a sign-in in Activity', () => {
  it('keeps the address it came from by default', () => {
    expect(signInDetail('With a passkey, from 203.0.113.7')).toBe('With a passkey, from 203.0.113.7')
  })

  it('leaves the address out when Privacy says so', () => {
    holdPrivacy({ ...DEFAULT_PRIVACY, recordSignInAddresses: false })
    expect(signInDetail('With a passkey, from 203.0.113.7')).toBe('With a passkey')
    expect(signInDetail('With Authentik, from 2001:db8::7')).toBe('With Authentik')
    expect(signInDetail('From 203.0.113.7')).toBe('')
  })
})

describe('the privacy settings', () => {
  it('take the defaults as they are', () => {
    expect(parsePrivacySettings(DEFAULT_PRIVACY)).toEqual({ ok: true, settings: DEFAULT_PRIVACY })
  })

  it.each([
    [{ ...DEFAULT_PRIVACY, hideAddresses: 'sometimes' }],
    [{ ...DEFAULT_PRIVACY, hideFromAssistants: 'yes' }],
    [{ ...DEFAULT_PRIVACY, keepActivityDays: 7 }],
    [null],
  ])('refuse %j', input => {
    expect(parsePrivacySettings(input).ok).toBe(false)
  })
})
