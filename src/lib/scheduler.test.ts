import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeResult, Target } from '@/types/probe'

const target: Target = {
  id: 't1',
  name: 'Example',
  host: '192.0.2.1',
  probeType: 'ping',
  interval: 60,
  status: 'active',
  ipVersion: 'ipv4',
} as Target

vi.mock('./db/database', () => ({
  getAllTargets: vi.fn(async () => [target]),
  storeMeasurements: vi.fn(async () => {}),
  cleanOldMeasurements: vi.fn(async () => 0),
  getDatabase: vi.fn(async () => ({
    all: (_sql: string, _params: unknown[], callback: (err: null, rows: unknown[]) => void) =>
      callback(null, [{ id: target.id, last_probe_at: 0 }]),
    run: (_sql: string, _params: unknown[], callback: (err: null) => void) => callback(null),
  })),
}))

let finishProbe: (results: ProbeResult[]) => void = () => {}
vi.mock('./probes/probe', () => ({
  executeProbes: vi.fn(() => new Promise<ProbeResult[]>(resolve => { finishProbe = resolve })),
}))
// The real dispatch between here and a probe agent, with the agent always down.
vi.mock('./probe-agents/client', async () => {
  const { executeProbes } = await import('./probes/probe')
  class ProbeAgentUnavailableError extends Error {
    agentName = 'Germany VPS'
  }
  return {
    ProbeAgentUnavailableError,
    checkProbeAgent: vi.fn(async () => 'offline'),
    runProbes: vi.fn(async (probed: Target) =>
      probed.probeAgentId ? Promise.reject(new ProbeAgentUnavailableError('No answer in time')) : executeProbes(probed)
    ),
  }
})
vi.mock('./probe-agents/store', () => ({
  pairedProbeAgentConnections: vi.fn(async () => []),
  getProbeAgentConnection: vi.fn(async () => null),
  cleanOldProbeAgentOutages: vi.fn(async () => 0),
}))
vi.mock('./alerts/store', () => ({ evaluateAlerts: vi.fn(async () => []), dispatchAlert: vi.fn(), asksForTrace: vi.fn(() => false), shouldTraceOnAlert: vi.fn(() => false) }))
vi.mock('./traceroute/store', () => ({ ensureTracerouteSchema: vi.fn(), cleanOldTraceroutes: vi.fn(), traceAndStore: vi.fn(), lastAlertTraceAt: vi.fn(async () => null) }))

const { getScheduler, isDue, Lane, nextDueAt, phaseOf } = await import('./scheduler')

describe('when a target is probed', () => {
  const MINUTE = 60_000

  it('gives each target its own moment in the interval, the same every time', () => {
    const phases = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => phaseOf(`target-${id}`, MINUTE))
    for (const phase of phases) {
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(MINUTE)
    }
    // Spread out, not stacked on one moment.
    expect(new Set(phases.map(phase => Math.floor(phase / 5000))).size).toBeGreaterThan(4)
    expect(phaseOf('target-a', MINUTE)).toBe(phases[0])
  })

  it('is due once its moment comes round in a later interval, and not before', () => {
    const phase = 20_000
    const last = 10 * MINUTE + phase
    expect(isDue(last + 30_000, last, MINUTE, phase)).toBe(false)
    expect(isDue(last + MINUTE - 1, last, MINUTE, phase)).toBe(false)
    expect(isDue(last + MINUTE, last, MINUTE, phase)).toBe(true)
  })

  it('keeps to its moment when a probe started late', () => {
    // Started 40s after its moment, it is still due at the next moment, not 60s after it started.
    const phase = 5000
    const late = 10 * MINUTE + phase + 40_000
    expect(isDue(11 * MINUTE + phase, late, MINUTE, phase)).toBe(true)
  })

  it('probes a target never probed straight away', () => {
    expect(isDue(Date.now(), 0, MINUTE, phaseOf('new', MINUTE))).toBe(true)
  })

  it('says when it is next due: its moment in the next interval', () => {
    const phase = 20_000
    const last = 10 * MINUTE + phase + 5000
    const next = nextDueAt(last, MINUTE, phase)
    expect(next).toBe(11 * MINUTE + phase)
    expect(isDue(next - 1, last, MINUTE, phase)).toBe(false)
    expect(isDue(next, last, MINUTE, phase)).toBe(true)
  })
})

describe('Lane', () => {
  it('runs a few at a time, and starts the next as one finishes', async () => {
    const lane = new Lane(2)
    const started: number[] = []
    const finishers: (() => void)[] = []
    for (const id of [1, 2, 3]) {
      lane.add(() => new Promise<void>(resolve => { started.push(id); finishers.push(resolve) }))
    }
    expect(started).toEqual([1, 2])

    finishers[0]()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(started).toEqual([1, 2, 3])
  })
})

describe('ProbeScheduler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('does not leave a target marked as probing when the targets are reloaded mid-probe', async () => {
    const scheduler = getScheduler()
    await scheduler.reloadTargets()

    const probing = scheduler.forceProbe(target.id)
    expect(scheduler.getStatus().targets[0].isProbing).toBe(true)

    // A target added or edited elsewhere, or the five-minute refresh, while
    // this one's probe is still out.
    await scheduler.reloadTargets()

    finishProbe([{ targetId: target.id, timestamp: new Date(), latency: 1, packetLoss: 0, jitter: 0, success: true }])
    await probing

    expect(scheduler.getStatus().targets[0].isProbing).toBe(false)
  })

  it('picks up changed settings on reload', async () => {
    const scheduler = getScheduler()
    target.interval = 300
    await scheduler.reloadTargets()

    expect(scheduler.getStatus().targets[0].interval).toBe(300)
  })

  it('takes a reading from Probe now as the one due, and does not take it again', async () => {
    const scheduler = getScheduler()
    target.interval = 60
    await scheduler.reloadTargets()
    const intervalMs = 60_000
    const phase = phaseOf(target.id, intervalMs)
    // Just after this target's moment in an interval to come: later than
    // anything the earlier tests probed it at.
    const moment = (Math.floor(Date.now() / intervalMs) + 10) * intervalMs + phase + 1000

    scheduler.noteProbed(target.id, moment - 500)
    scheduler.queueDueTargets(moment)
    expect(scheduler.getStatus().targets[0].isProbing).toBe(false)

    // A reload keeps it, rather than going back to what the database had.
    await scheduler.reloadTargets()
    scheduler.queueDueTargets(moment)
    expect(scheduler.getStatus().targets[0].isProbing).toBe(false)

    // The next interval's moment is due as usual.
    scheduler.queueDueTargets(moment + intervalMs)
    expect(scheduler.getStatus().targets[0].isProbing).toBe(true)
    finishProbe([{ targetId: target.id, timestamp: new Date(), latency: 1, packetLoss: 0, jitter: 0, success: true }])
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(scheduler.getStatus().targets[0].isProbing).toBe(false)
  })

  it('records nothing for a target whose probe agent cannot be reached', async () => {
    const { storeMeasurements } = await import('./db/database')
    const { evaluateAlerts } = await import('./alerts/store')
    vi.mocked(storeMeasurements).mockClear()

    const scheduler = getScheduler()
    target.probeAgentId = 'agent-1'
    await scheduler.reloadTargets()
    await scheduler.forceProbe(target.id)

    // Not a failed reading, and so no alert: the agent was down, not the target.
    expect(storeMeasurements).not.toHaveBeenCalled()
    expect(evaluateAlerts).not.toHaveBeenCalled()
    expect(scheduler.getStatus().targets[0].isProbing).toBe(false)
    target.probeAgentId = null
  })
})
