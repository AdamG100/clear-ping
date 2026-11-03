import { describe, expect, it } from 'vitest'
import type { ProbePolicy } from '@/types/alert-rules'
import type { ProbeResult } from '@/types/probe'
import { combined, describePolicy, FRESH_PROBE_STATE, judgeMonitor, policyHolds, stepProbe, type ProbeRules, type ProbeRuleState, type ProbeStanding } from './rules'

const MINUTE = 60_000
const reading = (fields: Partial<ProbeResult> = {}): ProbeResult => ({
  targetId: 't',
  timestamp: new Date(0),
  latency: 20,
  packetLoss: 0,
  jitter: 1,
  success: true,
  ...fields,
})

const loss5: ProbeRules = { conditions: [{ metric: 'packetLoss', threshold: 5 }], combine: 'any', readings: 1 }

/** Run readings one interval apart, returning every state and transition. */
function run(rules: ProbeRules, readings: ProbeResult[], start: ProbeRuleState = FRESH_PROBE_STATE, intervalMs = MINUTE) {
  let state = start
  return readings.map((result, index) => {
    const step = stepProbe(rules, state, result, index * intervalMs, intervalMs)
    state = step.state
    return { inBreach: step.state.inBreach, transition: step.transition }
  })
}

describe('adding conditions up', () => {
  it.each([
    ['any', [true, false], true],
    ['any', [false, false], false],
    ['all', [true, false], false],
    ['all', [true, true], true],
    [{ atLeast: 2 }, [true, true, false], true],
    [{ atLeast: 2 }, [true, false, false], false],
  ] as const)('%j of %j is %s', (combine, held, expected) => {
    expect(combined(combine, [...held])).toBe(expected)
  })

  it('judges all of the conditions together', () => {
    const rules: ProbeRules = {
      conditions: [{ metric: 'packetLoss', threshold: 5 }, { metric: 'latency', threshold: 200 }],
      combine: 'all',
      readings: 1,
    }
    const steps = run(rules, [
      reading({ packetLoss: 10, latency: 50 }),
      reading({ packetLoss: 10, latency: 300 }),
    ])
    expect(steps.map(step => step.inBreach)).toEqual([false, true])
  })

  it('holds the current state for a condition that has no value in a reading', () => {
    const rules: ProbeRules = { conditions: [{ metric: 'latency', threshold: 200 }], combine: 'any', readings: 2 }
    const none = reading({ latency: null, success: false })
    // Not in breach: a reading with no latency does not carry a run towards firing.
    expect(run(rules, [reading({ latency: 300 }), none, reading({ latency: 300 })]).map(step => step.transition)).toEqual([null, null, null])
    // In breach: it does not clear it either.
    expect(run(rules, [reading({ latency: 300 }), reading({ latency: 300 }), none, none, none]).map(step => step.transition)).toEqual([null, 'firing', null, null, null])
  })
})

describe('how long they hold', () => {
  it('fires after the readings in a row, and clears after the same', () => {
    const rules: ProbeRules = { ...loss5, readings: 3 }
    const steps = run(rules, [10, 10, 10, 0, 0, 0].map(loss => reading({ packetLoss: loss })))
    expect(steps.map(step => step.transition)).toEqual([null, null, 'firing', null, null, 'resolved'])
  })

  it('can clear after a different number', () => {
    const rules: ProbeRules = { ...loss5, readings: 1, clearAfter: 3 }
    const steps = run(rules, [10, 0, 0, 0].map(loss => reading({ packetLoss: loss })))
    expect(steps.map(step => step.transition)).toEqual(['firing', null, null, 'resolved'])
  })

  it('holds for minutes rather than readings', () => {
    const rules: ProbeRules = { ...loss5, readings: 1, minutes: 3 }
    // A reading a minute: the third minute is the first that has held for 3.
    const steps = run(rules, [10, 10, 10, 10].map(loss => reading({ packetLoss: loss })))
    expect(steps.map(step => step.transition)).toEqual([null, null, null, 'firing'])
  })

  it('does not carry a run in minutes across a gap in the readings', () => {
    const rules: ProbeRules = { ...loss5, readings: 1, minutes: 3 }
    let state = FRESH_PROBE_STATE
    // Three minutes of breaching, then the probe goes quiet for seventeen and returns.
    const at = [0, 1, 2, 20, 21, 22, 23].map(minute => minute * MINUTE)
    const transitions = at.map(moment => {
      const step = stepProbe(rules, state, reading({ packetLoss: 10 }), moment, MINUTE)
      state = step.state
      return step.transition
    })
    // Not fired on its return, though the run before the gap was almost long enough: it counts
    // three minutes from the first reading back.
    expect(transitions).toEqual([null, null, null, null, null, null, 'firing'])
  })
})

describe('clearing', () => {
  it('stays in breach until it is under the clear threshold', () => {
    const rules: ProbeRules = { conditions: [{ metric: 'packetLoss', threshold: 5, clearThreshold: 2 }], combine: 'any', readings: 1 }
    const steps = run(rules, [10, 4, 3, 1].map(loss => reading({ packetLoss: loss })))
    expect(steps.map(step => step.inBreach)).toEqual([true, true, true, false])
  })

  it('judges the mean of a window rather than the newest reading', () => {
    const rules: ProbeRules = { conditions: [{ metric: 'latency', threshold: 100, window: 3 }], combine: 'any', readings: 1 }
    // One slow reading among fast ones does not move the mean of three past the threshold.
    const steps = run(rules, [50, 50, 200, 200, 200].map(latency => reading({ latency })))
    expect(steps.map(step => step.inBreach)).toEqual([false, false, false, true, true])
  })
})

describe('the probes of a monitor', () => {
  const policies: Array<[ProbePolicy, number, number, boolean]> = [
    [{ kind: 'any' }, 1, 7, true],
    [{ kind: 'any' }, 0, 7, false],
    [{ kind: 'all' }, 7, 7, true],
    [{ kind: 'all' }, 6, 7, false],
    [{ kind: 'atLeast', count: 4 }, 4, 7, true],
    [{ kind: 'atLeast', count: 4 }, 3, 7, false],
    // 60% of 5 rounds up to 3.
    [{ kind: 'share', percent: 60 }, 3, 5, true],
    [{ kind: 'share', percent: 60 }, 2, 5, false],
    [{ kind: 'share', percent: 60 }, 0, 0, false],
  ]
  it.each(policies)('%j with %i of %i in breach is %s', (policy, breaching, total, expected) => {
    expect(policyHolds(policy, breaching, total)).toBe(expected)
  })

  const probes = (...states: Array<[boolean, boolean?]>): ProbeStanding[] =>
    states.map(([inBreach, silent], index) => ({ probe: `p${index}`, inBreach, silent: !!silent }))

  it('fires when enough probes agree, and clears when too few can', () => {
    const policy: ProbePolicy = { kind: 'atLeast', count: 2 }
    expect(judgeMonitor(policy, 'ok', probes([true], [true], [false])).transition).toBe('firing')
    expect(judgeMonitor(policy, 'ok', probes([true], [false], [false])).transition).toBeNull()
    expect(judgeMonitor(policy, 'firing', probes([true], [false], [false])).transition).toBe('resolved')
  })

  it('does not fire and clear in turn when one probe is silent ("all" with one away)', () => {
    const policy: ProbePolicy = { kind: 'all' }
    // A and B in breach, C silent: not every probe agrees, so it does not fire...
    expect(judgeMonitor(policy, 'ok', probes([true], [true], [false, true])).transition).toBeNull()
    // ...and once firing it does not clear on the next reading, because C may well be in breach too.
    expect(judgeMonitor(policy, 'firing', probes([true], [true], [false, true])).transition).toBeNull()
  })

  it('does not fire for a share when too few probes are reporting ("60%" with 2 of 5)', () => {
    const policy: ProbePolicy = { kind: 'share', percent: 60 }
    const standing = probes([true], [true], [false, true], [false, true], [false, true])
    expect(judgeMonitor(policy, 'ok', standing).transition).toBeNull()
  })

  it('does not storm when every probe agent goes quiet and the local probe alone is in breach', () => {
    const policy: ProbePolicy = { kind: 'all' }
    expect(judgeMonitor(policy, 'ok', probes([true], [false, true], [false, true])).transition).toBeNull()
  })

  it('never fires with nothing reporting, and never resolves just because a probe went quiet', () => {
    expect(judgeMonitor({ kind: 'any' }, 'ok', probes([true, true], [true, true])).transition).toBeNull()
    expect(judgeMonitor({ kind: 'any' }, 'firing', probes([true, true], [false, true])).transition).toBeNull()
  })

  it('says what the policy is', () => {
    expect(describePolicy({ kind: 'atLeast', count: 4 }, 7)).toBe('at least 4 of 7 probes')
    expect(describePolicy({ kind: 'any' }, 7)).toBe('any probe')
  })
})
