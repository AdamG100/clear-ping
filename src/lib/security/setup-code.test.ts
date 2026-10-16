import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCode, setupCodeMatches } from './setup-code'

afterEach(() => vi.unstubAllEnvs())

describe('setup code', () => {
  it('is made once and stays the same', () => {
    vi.stubEnv('CLEARPING_SETUP_CODE', '')
    expect(setupCode()).toBe(setupCode())
    expect(setupCode().length).toBeGreaterThanOrEqual(12)
  })

  it('is CLEARPING_SETUP_CODE when that is set', () => {
    vi.stubEnv('CLEARPING_SETUP_CODE', 'open-sesame')
    expect(setupCodeMatches('open-sesame')).toBe(true)
  })

  it('is not matched by a wrong, empty or missing one', () => {
    vi.stubEnv('CLEARPING_SETUP_CODE', 'open-sesame')
    expect(setupCodeMatches('nope')).toBe(false)
    expect(setupCodeMatches('')).toBe(false)
    expect(setupCodeMatches(undefined)).toBe(false)
  })
})
