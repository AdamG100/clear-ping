import { describe, expect, it } from 'vitest'
import { shouldAdviseSignIn } from './setup-advice'

describe('shouldAdviseSignIn', () => {
  const open = { loginRequired: false, recovery: false, dismissed: false }

  it('asks while sign-in is off, and again if it is turned back off', () => {
    expect(shouldAdviseSignIn(open)).toBe(true)
    expect(shouldAdviseSignIn({ ...open, loginRequired: true })).toBe(false)
    expect(shouldAdviseSignIn({ ...open, loginRequired: false })).toBe(true)
  })

  it('stays quiet while CLEARPING_AUTH=off is how you get back in', () => {
    expect(shouldAdviseSignIn({ ...open, recovery: true })).toBe(false)
  })

  it('stays quiet after an admin says this stays on the network', () => {
    expect(shouldAdviseSignIn({ ...open, dismissed: true })).toBe(false)
  })
})
