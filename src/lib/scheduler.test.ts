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

vi.mock('./database', () => ({
  getAllTargets: vi.fn(async () => [target]),
  storeMeasurement: vi.fn(async () => {}),
  saveDatabaseToDisk: vi.fn(),
  cleanOldMeasurements: vi.fn(async () => 0),
  getDatabase: vi.fn(async () => ({
    all: (_sql: string, _params: unknown[], callback: (err: null, rows: unknown[]) => void) =>
      callback(null, [{ id: target.id, last_probe_at: 0 }]),
    run: (_sql: string, _params: unknown[], callback: (err: null) => void) => callback(null),
  })),
}))

let finishProbe: (results: ProbeResult[]) => void = () => {}
vi.mock('./probe', () => ({
  executeProbes: vi.fn(() => new Promise<ProbeResult[]>(resolve => { finishProbe = resolve })),
}))
vi.mock('./alerts', () => ({ evaluateAlerts: vi.fn(async () => []), dispatchAlert: vi.fn() }))
vi.mock('./traceroute', () => ({ ensureTracerouteSchema: vi.fn(), cleanOldTraceroutes: vi.fn(), traceAndStore: vi.fn() }))

const { getScheduler } = await import('./scheduler')

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
})
