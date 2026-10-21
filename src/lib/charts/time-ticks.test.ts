import { describe, expect, it } from 'vitest'
import { timeTicks } from './time-ticks'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Local time, as a chart shows it: 14:07:30 on the 12th.
const start = new Date(2026, 9, 12, 14, 7, 30).getTime()

const gaps = (times: number[]) => times.slice(1).map((time, i) => time - times[i])

describe('timeTicks', () => {
  it('marks an hour every five minutes, on the five minutes', () => {
    const ticks = timeTicks(start, start + HOUR, 800)

    expect(ticks).toHaveLength(12)
    expect(ticks[0].time).toBe(new Date(2026, 9, 12, 14, 10).getTime())
    expect(new Set(gaps(ticks.map(tick => tick.time)))).toEqual(new Set([5 * MINUTE]))
    expect(ticks.map(tick => tick.label).slice(0, 3)).toEqual(['02:10 PM', '02:15 PM', '02:20 PM'])
  })

  it('keeps every mark inside the period', () => {
    for (const span of [90_000, 10 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY]) {
      const ticks = timeTicks(start, start + span, 800)
      expect(ticks.length).toBeGreaterThanOrEqual(3)
      for (const tick of ticks) {
        expect(tick.time).toBeGreaterThanOrEqual(start)
        expect(tick.time).toBeLessThanOrEqual(start + span)
      }
    }
  })

  it('puts fewer marks on a narrower chart, and never so many that the labels touch', () => {
    const wide = timeTicks(start, start + HOUR, 800)
    const narrow = timeTicks(start, start + HOUR, 280)

    expect(narrow.length).toBeLessThan(wide.length)
    expect(narrow.length).toBeGreaterThanOrEqual(2)
    // Eight characters at six pixels each, and a gap.
    for (const [ticks, width] of [[wide, 800], [narrow, 280]] as const) {
      expect((ticks.length - 1) * (8 * 6 + 12)).toBeLessThanOrEqual(width)
    }
  })

  it('marks a day on round hours, and gives midnight the date it begins', () => {
    const ticks = timeTicks(start, start + DAY, 800)

    for (const tick of ticks) {
      const date = new Date(tick.time)
      expect([date.getMinutes(), date.getSeconds()]).toEqual([0, 0])
    }
    const midnight = ticks.find(tick => new Date(tick.time).getHours() === 0)
    expect(midnight?.label).toBe('Oct 13')
    expect(ticks.filter(tick => /^\d\d:00 [AP]M$/.test(tick.label))).toHaveLength(ticks.length - 1)
  })

  it('marks a month by the date, at midnight', () => {
    const ticks = timeTicks(start, start + 30 * DAY, 800)

    expect(ticks.length).toBeGreaterThanOrEqual(8)
    for (const tick of ticks) {
      expect(new Date(tick.time).getHours()).toBe(0)
      expect(tick.label).toMatch(/^(Oct|Nov) \d{1,2}$/)
    }
  })

  it('marks ninety days by the week, on Mondays', () => {
    const ticks = timeTicks(start, start + 90 * DAY, 800)

    expect(ticks.length).toBeGreaterThanOrEqual(12)
    for (const tick of ticks) expect(new Date(tick.time).getDay()).toBe(1)
  })

  it('keeps its marks on the same times as the period slides forward', () => {
    const before = timeTicks(start, start + 30 * DAY, 800).map(tick => tick.time)
    const after = timeTicks(start + HOUR, start + 30 * DAY + HOUR, 800).map(tick => tick.time)
    expect(after.filter(time => before.includes(time)).length).toBeGreaterThanOrEqual(before.length - 1)
  })

  it('shows seconds once zoomed in far enough to need them', () => {
    const ticks = timeTicks(start, start + 90_000, 800)
    expect(ticks[0].label).toMatch(/^\d\d:\d\d:\d\d [AP]M$/)
  })

  it('marks the clock of the zone it is given, not the machine’s', () => {
    // 09:07:30 UTC is 14:37:30 in Kolkata, half an hour off the hours of UTC.
    const utc = Date.UTC(2026, 9, 12, 9, 7, 30)
    // A day at this width is marked every two hours.
    const hourly = timeTicks(utc, utc + DAY, 800, 'Asia/Kolkata')
    expect(hourly[0].time).toBe(Date.UTC(2026, 9, 12, 10, 30))
    expect(hourly[0].label).toBe('04:00 PM')
    expect(hourly.find(tick => tick.label === 'Oct 13')?.time).toBe(Date.UTC(2026, 9, 12, 18, 30))

    const fiveMinutes = timeTicks(utc, utc + HOUR, 800, 'Asia/Kolkata')
    expect(fiveMinutes[0].label).toBe('02:40 PM')
  })

  it('stays on the hour across a change of the clocks', () => {
    // New York moves its clocks back an hour early on 1 November 2026.
    const from = Date.UTC(2026, 9, 31, 12)
    const ticks = timeTicks(from, from + 2 * DAY, 800, 'America/New_York')
    for (const tick of ticks) expect(tick.label).toMatch(/^(\d\d:00 [AP]M|Nov \d)$/)
    expect(ticks.filter(tick => tick.label === 'Nov 1')).toHaveLength(1)
  })

  it('has nothing to mark in a period with no length', () => {
    expect(timeTicks(start, start, 800)).toEqual([])
    expect(timeTicks(start, start - 1, 800)).toEqual([])
    expect(timeTicks(start, start + HOUR, 0)).toEqual([])
  })
})
