import { describe, expect, it } from 'vitest'
import { isBreaching, nextRuleState, observedValue, shouldTraceOnAlert } from './store'
import type { AlertRule, ProbeResult } from '@/types/probe'

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: 'r1',
  targetId: 't1',
  metric: 'packetLoss',
  threshold: 5,
  consecutiveProbes: 3,
  notifyUrls: [],
  traceOnFire: true,
  traceCooldownMinutes: 15,
  enabled: true,
  state: 'ok',
  streak: 0,
  createdAt: new Date(),
  ...over,
})

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  targetId: 't1',
  timestamp: new Date(),
  latency: 10,
  packetLoss: 0,
  jitter: 1,
  success: true,
  ...over,
})

/** Feed a sequence of breach/clear probes through the state machine. */
function run(start: AlertRule, breaches: boolean[]) {
  let current = { state: start.state, streak: start.streak, consecutiveProbes: start.consecutiveProbes }
  const transitions: (string | null)[] = []

  for (const breaching of breaches) {
    const next = nextRuleState(current, breaching)
    transitions.push(next.transition)
    current = { ...current, state: next.state, streak: next.streak }
  }

  return { state: current.state, transitions: transitions.filter(Boolean) }
}

describe('nextRuleState', () => {
  it('does not fire on a single breach', () => {
    const { state, transitions } = run(rule(), [true])
    expect(state).toBe('ok')
    expect(transitions).toEqual([])
  })

  it('fires once the breach has held for the required number of probes', () => {
    const { state, transitions } = run(rule(), [true, true, true])
    expect(state).toBe('firing')
    expect(transitions).toEqual(['firing'])
  })

  it('resets the streak when a clean probe interrupts the breach', () => {
    // Two breaches, a recovery, then two more: never three in a row.
    const { state, transitions } = run(rule(), [true, true, false, true, true])
    expect(state).toBe('ok')
    expect(transitions).toEqual([])
  })

  it('requires the same number of clean probes before resolving', () => {
    const { state, transitions } = run(rule(), [true, true, true, false, false])
    expect(state).toBe('firing')
    expect(transitions).toEqual(['firing'])
  })

  it('resolves after a sustained recovery', () => {
    const { state, transitions } = run(rule(), [true, true, true, false, false, false])
    expect(state).toBe('ok')
    expect(transitions).toEqual(['firing', 'resolved'])
  })

  it('does not re-fire while already firing', () => {
    const { transitions } = run(rule(), [true, true, true, true, true, true, true])
    expect(transitions).toEqual(['firing'])
  })

  it('fires immediately when configured for a single probe', () => {
    const { state, transitions } = run(rule({ consecutiveProbes: 1 }), [true])
    expect(state).toBe('firing')
    expect(transitions).toEqual(['firing'])
  })
})

describe('isBreaching', () => {
  it('compares strictly against the threshold', () => {
    expect(isBreaching(rule({ threshold: 5 }), probe({ packetLoss: 5 }))).toBe(false)
    expect(isBreaching(rule({ threshold: 5 }), probe({ packetLoss: 5.1 }))).toBe(true)
  })

  it('treats an unreachable host as a breach for the unreachable metric', () => {
    const r = rule({ metric: 'unreachable' })
    expect(isBreaching(r, probe({ success: false, latency: null }))).toBe(true)
    expect(isBreaching(r, probe({ success: true }))).toBe(false)
  })

  it('holds state when the metric has no reading, rather than guessing', () => {
    // A down host produces no latency. Reading that as "0ms, all good" would
    // silently resolve a firing latency alert.
    const down = probe({ success: false, latency: null, jitter: null })
    expect(isBreaching(rule({ metric: 'latency', state: 'firing' }), down)).toBe(true)
    expect(isBreaching(rule({ metric: 'latency', state: 'ok' }), down)).toBe(false)
  })

  it('does not confuse a jitter of zero with a missing reading', () => {
    expect(isBreaching(rule({ metric: 'jitter', threshold: 0 }), probe({ jitter: 0 }))).toBe(false)
    expect(isBreaching(rule({ metric: 'jitter', threshold: 0 }), probe({ jitter: 1 }))).toBe(true)
  })
})

describe('observedValue', () => {
  it('reads the metric the rule watches', () => {
    const p = probe({ latency: 42, packetLoss: 7, jitter: 3 })
    expect(observedValue({ metric: 'latency' }, p)).toBe(42)
    expect(observedValue({ metric: 'packetLoss' }, p)).toBe(7)
    expect(observedValue({ metric: 'jitter' }, p)).toBe(3)
  })
})

describe('certificate expiry', () => {
  const DAY = 24 * 60 * 60 * 1000
  const at = new Date('2026-10-05T12:00:00.000Z')
  const certRule = rule({ metric: 'certExpiry', threshold: 14 })
  const expiringIn = (days: number) =>
    probe({ timestamp: at, details: { certExpiresAt: at.getTime() + days * DAY } })

  it('reports the days of validity left as of the probe', () => {
    expect(observedValue(certRule, expiringIn(30))).toBe(30)
    expect(observedValue(certRule, expiringIn(2.5))).toBe(2.5)
  })

  it('breaches when fewer days remain than the threshold, the reverse of every other metric', () => {
    expect(isBreaching(certRule, expiringIn(30))).toBe(false)
    expect(isBreaching(certRule, expiringIn(14))).toBe(false)
    expect(isBreaching(certRule, expiringIn(13))).toBe(true)
  })

  it('breaches for a certificate that has already expired', () => {
    expect(isBreaching(certRule, expiringIn(-1))).toBe(true)
  })

  it('holds its state when a probe saw no certificate at all', () => {
    // A target that is down, or one that is not HTTPS, says nothing about its
    // certificate. That must neither raise the alert nor quietly clear it.
    const blind = probe({ timestamp: at, success: false })

    expect(observedValue(certRule, blind)).toBeNull()
    expect(isBreaching(certRule, blind)).toBe(false)
    expect(isBreaching({ ...certRule, state: 'firing' }, blind)).toBe(true)
  })
})

describe('shouldTraceOnAlert', () => {
  const now = new Date('2026-10-20T12:00:00.000Z').getTime()
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000)
  const fired = (over: Partial<AlertRule> = {}, transition: 'firing' | 'resolved' = 'firing') => {
    const firing = rule(over)
    return { transition, metric: firing.metric, rule: firing }
  }

  it('traces the first time an alert set to trace fires', () => {
    expect(shouldTraceOnAlert([fired()], null, now)).toBe(true)
  })

  it('does not trace for an alert not set to, or one that is resolving', () => {
    expect(shouldTraceOnAlert([fired({ traceOnFire: false })], null, now)).toBe(false)
    expect(shouldTraceOnAlert([fired({}, 'resolved')], null, now)).toBe(false)
    expect(shouldTraceOnAlert([], null, now)).toBe(false)
  })

  it('never traces for a certificate running out, which is not on the path', () => {
    expect(shouldTraceOnAlert([fired({ metric: 'certExpiry' })], null, now)).toBe(false)
  })

  it('waits out the pause after the last trace taken on an alert', () => {
    expect(shouldTraceOnAlert([fired()], minutesAgo(5), now)).toBe(false)
    expect(shouldTraceOnAlert([fired()], minutesAgo(14.9), now)).toBe(false)
    expect(shouldTraceOnAlert([fired()], minutesAgo(15), now)).toBe(true)
  })

  it('takes one trace for alerts firing together, after the shortest pause any of them asks for', () => {
    const together = [fired({ traceCooldownMinutes: 60 }), fired({ id: 'r2', metric: 'unreachable', traceCooldownMinutes: 5 })]
    expect(shouldTraceOnAlert(together, minutesAgo(10), now)).toBe(true)
    expect(shouldTraceOnAlert(together, minutesAgo(3), now)).toBe(false)
  })
})
