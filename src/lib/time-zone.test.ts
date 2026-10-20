import { describe, expect, it } from 'vitest'
import { configuredTimeZone, formatMoment, offsetLabel, wallClock, zonedTime, zoneOffset } from './time-zone'

const HOUR = 60 * 60 * 1000

describe('configuredTimeZone', () => {
  it('takes an IANA name, as TZ is written in a compose file', () => {
    expect(configuredTimeZone('Africa/Johannesburg')).toBe('Africa/Johannesburg')
    expect(configuredTimeZone(' Europe/London ')).toBe('Europe/London')
    expect(configuredTimeZone(':America/New_York')).toBe('America/New_York')
    expect(configuredTimeZone('UTC')).toBe('UTC')
  })

  it('is none when TZ is unset or names no zone', () => {
    expect(configuredTimeZone(undefined)).toBeNull()
    expect(configuredTimeZone('')).toBeNull()
    expect(configuredTimeZone('Mars/Olympus_Mons')).toBeNull()
  })
})

describe('the calendar in a zone', () => {
  const at = Date.UTC(2026, 9, 20, 9, 5, 7)

  it('reads the wall clock in the zone asked for, whatever the machine is in', () => {
    expect(wallClock(at, 'Africa/Johannesburg')).toEqual({ year: 2026, month: 10, day: 20, hour: 11, minute: 5, second: 7 })
    expect(wallClock(at, 'Asia/Kolkata')).toMatchObject({ hour: 14, minute: 35 })
    expect(wallClock(Date.UTC(2026, 9, 20, 23, 30), 'Pacific/Auckland')).toMatchObject({ day: 21, hour: 12 })
  })

  it('knows how far ahead of UTC a zone is, by the season', () => {
    expect(zoneOffset(at, 'Asia/Kolkata')).toBe(5.5 * HOUR)
    expect(zoneOffset(Date.UTC(2026, 0, 15), 'America/New_York')).toBe(-5 * HOUR)
    expect(zoneOffset(Date.UTC(2026, 6, 15), 'America/New_York')).toBe(-4 * HOUR)
  })

  it('finds the moment a clock reads a given time, and rolls over past the end of a month', () => {
    expect(zonedTime(2026, 10, 20, 11, 5, 'Africa/Johannesburg')).toBe(Date.UTC(2026, 9, 20, 9, 5))
    expect(zonedTime(2026, 10, 32, 0, 0, 'UTC')).toBe(Date.UTC(2026, 10, 1))
  })

  it('puts an hour the clocks skipped just after the gap, and one they repeat at its first', () => {
    // New York: 02:00 became 03:00 on 8 March 2026, and 02:00 was 01:00 again on 1 November.
    expect(zonedTime(2026, 3, 8, 2, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7))
    expect(wallClock(zonedTime(2026, 3, 8, 2, 0, 'America/New_York'), 'America/New_York')).toMatchObject({ hour: 3 })
    expect(zonedTime(2026, 11, 1, 1, 30, 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30))
  })
})

describe('saying when', () => {
  const at = new Date(Date.UTC(2026, 9, 20, 9, 5, 7))

  it('gives the moment in full, with how far it is from UTC', () => {
    expect(formatMoment(at, 'Africa/Johannesburg')).toBe('2026-10-20 11:05:07 GMT+2')
    expect(formatMoment(at, 'Asia/Kolkata')).toBe('2026-10-20 14:35:07 GMT+5:30')
    expect(formatMoment(at, 'America/St_Johns')).toBe('2026-10-20 06:35:07 GMT-2:30')
    expect(formatMoment(at, 'UTC')).toBe('2026-10-20 09:05:07 UTC')
  })

  it('says UTC for a zone that is on it, and the offset otherwise', () => {
    expect(offsetLabel(at.getTime(), 'Europe/London')).toBe('GMT+1')
    expect(offsetLabel(Date.UTC(2026, 0, 1), 'Europe/London')).toBe('UTC')
  })
})
