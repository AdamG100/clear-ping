import { describe, expect, it } from 'vitest'
import { findGaps, findIncidents, gapThreshold, type ProbeReading } from './outages'

const MINUTE = 60_000
const options = { intervalMs: MINUTE }

/** A probe a minute, written as one character each: `.` healthy, `x` no reply, `l` some loss, `_` no probe taken. */
function readings(pattern: string, reason = 'Request timed out'): ProbeReading[] {
  return [...pattern].flatMap((mark, minute): ProbeReading[] => {
    if (mark === '_') return []
    const timestamp = minute * MINUTE
    if (mark === 'x') return [{ timestamp, packetLoss: 100, latency: null, success: false, errorMessage: reason }]
    if (mark === 'l') return [{ timestamp, packetLoss: 20, latency: 30, success: true }]
    return [{ timestamp, packetLoss: 0, latency: 10, success: true }]
  })
}

describe('findIncidents', () => {
  it('finds nothing where nothing went wrong', () => {
    expect(findIncidents(readings('..........'), options)).toEqual([])
    expect(findIncidents([], options)).toEqual([])
  })

  it('gives an outage its start, its end and what was said', () => {
    const [incident, ...rest] = findIncidents(readings('...xxxx....'), options)

    expect(rest).toEqual([])
    expect(incident).toEqual({
      kind: 'outage',
      start: 3 * MINUTE,
      // The first healthy probe after it, which is when it was seen to be over.
      end: 7 * MINUTE,
      lastAffected: 6 * MINUTE,
      durationMs: 4 * MINUTE,
      probes: 4,
      affectedProbes: 4,
      failedProbes: 4,
      worstLoss: 100,
      meanLoss: 100,
      reasons: ['Request timed out'],
      ongoing: false,
    })
  })

  it('calls a spell in which every probe got something back loss, not an outage', () => {
    const [incident] = findIncidents(readings('..lll...'), options)
    expect(incident).toMatchObject({ kind: 'loss', failedProbes: 0, affectedProbes: 3, worstLoss: 20, meanLoss: 20, reasons: [] })
  })

  it('keeps a path that drops, answers once and drops again as one incident', () => {
    const found = findIncidents(readings('..xx.xx....'), options)

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ start: 2 * MINUTE, end: 7 * MINUTE, probes: 5, affectedProbes: 4, failedProbes: 4 })
    // The healthy probe in the middle of it is part of it, and brings the mean down.
    expect(found[0].meanLoss).toBe(80)
  })

  it('makes two of them once it has been healthy twice in a row between', () => {
    const found = findIncidents(readings('..xx..xx...'), options)
    expect(found.map(incident => [incident.start, incident.end])).toEqual([
      [2 * MINUTE, 4 * MINUTE],
      [6 * MINUTE, 8 * MINUTE],
    ])
  })

  it('says one that is failing at the last reading is still going', () => {
    const [incident] = findIncidents(readings('....xxx'), options)
    expect(incident).toMatchObject({ start: 4 * MINUTE, end: null, ongoing: true, durationMs: 2 * MINUTE })
  })

  it('takes one healthy probe at the very end as the end of it', () => {
    const [incident] = findIncidents(readings('....xx.'), options)
    expect(incident).toMatchObject({ end: 6 * MINUTE, ongoing: false })
  })

  it('does not carry an incident across a stretch in which nobody was looking', () => {
    const found = findIncidents(readings('..xx__________xx..'), options)

    expect(found).toHaveLength(2)
    // The first was never seen to end, and is not still going either.
    expect(found[0]).toMatchObject({ start: 2 * MINUTE, end: null, ongoing: false, lastAffected: 3 * MINUTE, durationMs: MINUTE })
    expect(found[1]).toMatchObject({ start: 14 * MINUTE, end: 16 * MINUTE })
  })

  it('lists why the probes failed, most often said first', () => {
    const mixed = [
      ...readings('x', 'Connection refused'),
      ...readings('_xxx', 'Request timed out'),
      ...readings('____..'),
    ]
    expect(findIncidents(mixed, options)[0].reasons).toEqual(['Request timed out', 'Connection refused'])
  })

  it('can be told that a little loss is not an incident', () => {
    expect(findIncidents(readings('..lll..'), { ...options, minLoss: 50 })).toEqual([])
    // Nothing coming back at all always is.
    expect(findIncidents(readings('..lxl..'), { ...options, minLoss: 50 })).toHaveLength(1)
  })
})

describe('findGaps', () => {
  it('finds the stretches with no readings where there should have been some', () => {
    expect(findGaps(readings('...________...'), MINUTE)).toEqual([{ start: 2 * MINUTE, end: 11 * MINUTE, durationMs: 9 * MINUTE }])
  })

  it('does not call one late probe a gap', () => {
    expect(findGaps(readings('..__..'), MINUTE)).toEqual([])
    expect(gapThreshold(MINUTE)).toBe(3 * MINUTE)
    // Probed every ten seconds, a few missed is still not the monitor being off.
    expect(gapThreshold(10_000)).toBe(130_000)
  })
})
