import { describe, expect, it } from 'vitest'
import type { Traceroute } from '@/types/probe'
import {
  analyzeSeries,
  describeIncident,
  describeTrace,
  hoursOfDay,
  humanDuration,
  isoIn,
  isTimeZone,
  meanwhile,
  mostSevere,
  summarizeReadings,
} from './evidence'
import type { Incident, ProbeReading } from './outages'

const MINUTE = 60_000
/** 2026-03-10 12:00 UTC: no clock anywhere changes that week. */
const NOON = Date.UTC(2026, 2, 10, 12)

const reading = (minute: number, mark: '.' | 'x' | 'l' = '.', latency = 10): ProbeReading => ({
  timestamp: NOON + minute * MINUTE,
  packetLoss: mark === 'x' ? 100 : mark === 'l' ? 20 : 0,
  latency: mark === 'x' ? null : latency,
  success: mark !== 'x',
})

const series = (label: string, pattern: string, intervalMs = MINUTE) =>
  analyzeSeries(
    { label, targetId: label, family: null, intervalMs },
    [...pattern].flatMap((mark, minute) => (mark === '_' ? [] : [reading(minute, mark as '.' | 'x' | 'l')])),
    { timeZone: 'UTC' }
  )

describe('times', () => {
  it('writes a moment as the local clock had it, with how far that is from UTC', () => {
    expect(isoIn(NOON, 'UTC')).toBe('2026-03-10T12:00:00+00:00')
    expect(isoIn(NOON, 'Africa/Johannesburg')).toBe('2026-03-10T14:00:00+02:00')
    expect(isoIn(NOON, 'America/St_Johns')).toBe('2026-03-10T09:30:00-02:30')
    // Past midnight there, and so the next day.
    expect(isoIn(NOON, 'Pacific/Auckland')).toBe('2026-03-11T01:00:00+13:00')
  })

  it('knows a time zone from something that is not one', () => {
    expect(isTimeZone('Europe/London')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('')).toBe(false)
    expect(isTimeZone(2)).toBe(false)
  })

  it('says a length of time the way it would be said', () => {
    expect(humanDuration(45_000)).toBe('45s')
    expect(humanDuration(17 * MINUTE + 5000)).toBe('17m 5s')
    expect(humanDuration(60 * MINUTE)).toBe('1h')
    expect(humanDuration(123 * MINUTE)).toBe('2h 3m')
    expect(humanDuration(76 * 60 * MINUTE)).toBe('3d 4h')
    expect(humanDuration(0)).toBe('0s')
  })
})

describe('summarizeReadings', () => {
  it('counts what answered, what did not, and how long the answers took', () => {
    const summary = summarizeReadings([reading(0, '.', 10), reading(1, '.', 20), reading(2, 'l', 30), reading(3, 'x')])

    expect(summary).toMatchObject({ probes: 4, failedProbes: 1, lossyProbes: 1, uptimePercent: 75, lossPercent: 30 })
    expect(summary.latencyMs).toEqual({ median: 20, mean: 20, p95: 29, min: 10, max: 30 })
    expect(summary.firstProbe).toBe(NOON)
    expect(summary.lastProbe).toBe(NOON + 3 * MINUTE)
  })

  it('has no latency for a target that never answered, and nothing at all for none', () => {
    expect(summarizeReadings([reading(0, 'x')])).toMatchObject({ uptimePercent: 0, lossPercent: 100, latencyMs: null })
    expect(summarizeReadings([])).toMatchObject({ probes: 0, uptimePercent: 0, latencyMs: null, firstProbe: null })
  })
})

describe('hoursOfDay', () => {
  it('folds the period into one day, on the clock of the zone asked for', () => {
    // Noon and one o'clock UTC, on two days running: the same two hours.
    const two = [reading(0, '.', 10), reading(60, 'x'), reading(24 * 60, '.', 30), reading(25 * 60, 'x')]

    expect(hoursOfDay(two, 'UTC')).toEqual([
      { hour: '12:00', probes: 2, failedProbes: 0, affectedProbes: 0, lossPercent: 0, medianLatencyMs: 20 },
      { hour: '13:00', probes: 2, failedProbes: 2, affectedProbes: 2, lossPercent: 100, medianLatencyMs: null },
    ])
    expect(hoursOfDay(two, 'Africa/Johannesburg').map(row => row.hour)).toEqual(['14:00', '15:00'])
    // A zone half an hour out: noon UTC is half past five there.
    expect(hoursOfDay([reading(0)], 'Asia/Kolkata').map(row => row.hour)).toEqual(['17:00'])
  })
})

describe('meanwhile', () => {
  const router = series('Router', '..........')
  const gateway = series('ISP gateway', '...xxxx...')
  const website = series('Website', '....xx....')
  const hourly = series('Checked hourly', '.', 60 * MINUTE)
  const startedLater = series('Added later', '_________.')

  it('says what else was failing while one thing was, and what was not', () => {
    const all = [router, gateway, website]
    expect(meanwhile(gateway.incidents[0], gateway, all)).toEqual({
      alsoAffected: ['Website'],
      unaffected: ['Router'],
      notWatched: [],
    })
  })

  it('counts a target probed less often as watched if a probe fell either side', () => {
    expect(meanwhile(gateway.incidents[0], gateway, [gateway, hourly]).unaffected).toEqual(['Checked hourly'])
  })

  it('does not vouch for a target that was not being probed at the time', () => {
    const early = series('Early', '.xx.......')
    expect(meanwhile(early.incidents[0], early, [early, startedLater])).toEqual({
      alsoAffected: [],
      unaffected: [],
      notWatched: ['Added later'],
    })
  })
})

describe('incidents, told', () => {
  it('writes one out with its times and its length', () => {
    const [incident] = series('Gateway', '...xxxx...').incidents

    expect(describeIncident(incident, 'Gateway', 'Africa/Johannesburg')).toEqual({
      target: 'Gateway',
      kind: 'outage',
      start: '2026-03-10T14:03:00+02:00',
      end: '2026-03-10T14:07:00+02:00',
      ongoing: false,
      duration: '4m',
      durationSeconds: 240,
      probes: 4,
      failedProbes: 4,
      worstLossPercent: 100,
      meanLossPercent: 100,
      reasons: [],
    })
  })

  it('says so where one was never seen to end', () => {
    const [cutOff] = series('Gateway', '..xx__________..').incidents
    expect(describeIncident(cutOff, 'Gateway', 'UTC')).toMatchObject({ end: null, ongoing: false })
    expect(describeIncident(cutOff, 'Gateway', 'UTC').endNote).toContain('Monitoring stopped')

    const [going] = series('Gateway', '....xx').incidents
    expect(describeIncident(going, 'Gateway', 'UTC')).toMatchObject({ end: null, ongoing: true })
    expect(describeIncident(going, 'Gateway', 'UTC').endNote).toBeUndefined()
  })

  it('keeps the worst when there is no room for all, and lists them oldest first', () => {
    const incident = (start: number, kind: Incident['kind'], durationMs: number) => ({ incident: { start, kind, durationMs } as Incident })
    const all = [incident(1, 'loss', 900), incident(2, 'outage', 10), incident(3, 'loss', 50), incident(4, 'outage', 500)]

    expect(mostSevere(all, 10).map(each => each.incident.start)).toEqual([1, 2, 3, 4])
    // Both outages before any loss, and the longer loss before the shorter.
    expect(mostSevere(all, 3).map(each => each.incident.start)).toEqual([1, 2, 4])
    expect(mostSevere(all, 1).map(each => each.incident.start)).toEqual([4])
  })
})

describe('describeTrace', () => {
  it('writes a route a hop to a line, and where the replies stopped', () => {
    const trace: Traceroute = {
      id: 't',
      targetId: 'x',
      timestamp: new Date(NOON),
      trigger: 'alert',
      address: '203.0.113.9',
      reached: false,
      hops: [
        { hop: 1, address: '192.168.1.1', hostname: 'router.lan', rtts: [1, 2, 3], sent: 3 },
        { hop: 2, address: '100.64.0.1', hostname: null, rtts: [12.44], sent: 3 },
        { hop: 3, address: null, rtts: [], sent: 3 },
        { hop: 4, address: null, rtts: [], sent: 3 },
      ],
    }

    expect(describeTrace(trace, 'Website', 'UTC')).toEqual({
      target: 'Website',
      takenAt: '2026-03-10T12:00:00+00:00',
      trigger: 'automatic, when an alert fired',
      address: '203.0.113.9',
      reachedTheTarget: false,
      repliesStopAtHop: 3,
      hops: [
        '1  192.168.1.1 (router.lan)  2 ms  loss 0%',
        '2  100.64.0.1  12.4 ms  loss 67%',
        '3  *  no reply  loss 100%',
        '4  *  no reply  loss 100%',
      ],
    })
  })
})
