import { describe, expect, it } from 'vitest'
import { buildOverview, LISTED_LOSS_MS, SLICE_MS, type OverviewInput } from './overview'

const MINUTE = 60_000
const START = Date.UTC(2026, 9, 27, 0, 0)
const END = START + 2 * 60 * MINUTE

type Target = OverviewInput['targets'][number]

const target = (id: string, host: string, extra: Partial<Target> = {}): Target => ({
  id,
  name: id,
  host,
  interval: 60,
  ipVersion: 'auto',
  probeAgentId: null,
  ...extra,
})

/** A reading a minute over the period, failing or losing where `bad` says. */
function minutely(bad: (minute: number) => 'down' | number | null = () => null) {
  return Array.from({ length: 120 }, (_, minute) => {
    const state = bad(minute)
    return {
      timestamp: START + minute * MINUTE,
      success: state !== 'down',
      packetLoss: state === 'down' ? 100 : state ?? 0,
      latency: state === 'down' ? null : 5,
      ...(state === 'down' ? { errorMessage: 'No answer within 5000ms' } : {}),
    }
  })
}

const between = (from: number, to: number) => (minute: number) => (minute >= from && minute < to ? ('down' as const) : null)

function overview(targets: Target[], readings: Record<string, ReturnType<typeof minutely>>) {
  return buildOverview({ start: START, end: END, targets, readings: new Map(Object.entries(readings)), probeAgentOutages: {} })
}

describe('buildOverview', () => {
  it('puts targets that fail together into one event', () => {
    const report = overview(
      [target('router', '192.168.1.1'), target('a', '8.8.8.8'), target('b', '1.0.0.1')],
      { router: minutely(), a: minutely(between(30, 35)), b: minutely(between(31, 36)) }
    )

    expect(report.events).toHaveLength(1)
    expect(report.events[0]).toMatchObject({
      kind: 'outage',
      start: START + 30 * MINUTE,
      end: START + 36 * MINUTE,
      ongoing: false,
      watched: 3,
      // The router kept answering, so the fault was out past it.
      scope: 'beyond',
    })
    expect(report.events[0].targets.map(each => each.targetId)).toEqual(['a', 'b'])
    expect(report.events[0].targets[0].reasons).toEqual(['No answer within 5000ms'])
  })

  it('keeps faults that start apart as separate events', () => {
    const report = overview(
      [target('a', '8.8.8.8'), target('b', '1.0.0.1')],
      { a: minutely(between(10, 20)), b: minutely(between(40, 50)) }
    )
    expect(report.events.map(event => event.targets.map(each => each.targetId))).toEqual([['a'], ['b']])
    // Each failed alone while the other answered.
    expect(report.events.map(event => event.scope)).toEqual(['single', 'single'])
  })

  it('says the local network failed when something inside it did', () => {
    const report = overview(
      [target('router', '192.168.1.1'), target('a', '8.8.8.8')],
      { router: minutely(between(50, 52)), a: minutely(between(50, 52)) }
    )
    expect(report.events).toHaveLength(1)
    expect(report.events[0].scope).toBe('local')
  })

  it('keeps what is seen from a probe agent apart from what is seen from here', () => {
    const report = overview(
      [target('here', '8.8.8.8'), target('there', '8.8.4.4', { probeAgentId: 'agent-1' })],
      { here: minutely(between(30, 33)), there: minutely(between(30, 33)) }
    )
    expect(report.events.map(event => event.probeAgentId)).toEqual([null, 'agent-1'])
  })

  it('leaves an outage that has not ended open', () => {
    const report = overview([target('a', '8.8.8.8')], { a: minutely(minute => (minute >= 100 ? 'down' : null)) })
    expect(report.events[0]).toMatchObject({ ongoing: true, end: null })
  })

  it('counts brief loss rather than listing it, and lists loss that goes on', () => {
    const lossy = Math.ceil(LISTED_LOSS_MS / MINUTE) + 2
    const report = overview(
      [target('brief', '8.8.8.8'), target('long', '1.0.0.1')],
      {
        brief: minutely(minute => (minute === 5 || minute === 60 ? 10 : null)),
        long: minutely(minute => (minute >= 20 && minute < 20 + lossy ? 10 : null)),
      }
    )
    expect(report.briefLossSpells).toBe(2)
    expect(report.events).toHaveLength(1)
    expect(report.events[0]).toMatchObject({ kind: 'loss', targets: [{ targetId: 'long', kind: 'loss' }] })
  })

  it('names one family of a dual-stack target when only it failed', () => {
    const readings = minutely().flatMap(reading => [
      { ...reading, family: 4 as const },
      { ...reading, family: 6 as const, success: reading.timestamp < START + 30 * MINUTE || reading.timestamp >= START + 33 * MINUTE },
    ])
    const report = buildOverview({
      start: START,
      end: END,
      targets: [target('site', 'example.com', { ipVersion: 'both' })],
      readings: new Map([['site', readings]]),
      probeAgentOutages: {},
    })
    expect(report.events[0].targets[0].label).toBe('site (IPv6)')
  })

  it('counts the targets down and losing in each slice', () => {
    const report = overview(
      [target('a', '8.8.8.8'), target('b', '1.0.0.1'), target('c', '9.9.9.9')],
      {
        a: minutely(between(0, 1)),
        b: minutely(minute => (minute === 2 ? 10 : null)),
        c: minutely(),
      }
    )
    expect(report.sliceMs).toBe(SLICE_MS)
    expect(report.slices).toHaveLength(8)
    expect(report.slices[0]).toEqual({ start: START, watched: 3, down: 1, lossy: 1 })
    expect(report.slices[1]).toEqual({ start: START + SLICE_MS, watched: 3, down: 0, lossy: 0 })
  })

  it('sums up each target over the period', () => {
    const report = overview([target('a', '8.8.8.8')], { a: minutely(between(0, 12)) })
    expect(report.targets[0]).toMatchObject({ targetId: 'a', probes: 120, failedProbes: 12, uptimePercent: 90 })
  })
})
