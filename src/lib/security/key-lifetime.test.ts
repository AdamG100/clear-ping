import { describe, expect, it } from 'vitest'
import { describeTimeLeft, MAX_KEY_DAYS, parseKeyDays } from './key-lifetime'

describe('parseKeyDays', () => {
  it('takes nothing, or null, as a key that never stops', () => {
    expect(parseKeyDays(undefined)).toEqual({ days: null })
    expect(parseKeyDays(null)).toEqual({ days: null })
  })

  it('takes whole days from one to ten years', () => {
    expect(parseKeyDays(1)).toEqual({ days: 1 })
    expect(parseKeyDays(90)).toEqual({ days: 90 })
    expect(parseKeyDays(MAX_KEY_DAYS)).toEqual({ days: MAX_KEY_DAYS })
  })

  it.each([0, -3, 1.5, MAX_KEY_DAYS + 1, '7', NaN, {}])('refuses %s', value => {
    expect(parseKeyDays(value)).toHaveProperty('error')
  })
})

describe('describeTimeLeft', () => {
  const now = Date.UTC(2026, 9, 30, 12)
  const day = 24 * 60 * 60 * 1000

  it('says how long is left', () => {
    expect(describeTimeLeft(now - 1, now)).toBe('expired')
    expect(describeTimeLeft(now + 3 * 60 * 60 * 1000, now)).toBe('today')
    expect(describeTimeLeft(now + day, now)).toBe('tomorrow')
    expect(describeTimeLeft(now + 6.2 * day, now)).toBe('in 7 days')
  })
})
