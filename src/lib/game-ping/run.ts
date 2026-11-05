import type { ProbeId } from '@/types/probe-agent'
import { ProbeAgentUnavailableError, runProbes } from '../probe-agents/client'
import { probeFor, type GameRegion, type RegionReading } from './catalogue'

/**
 * Testing one region of a game from one probe, for the Game Server Ping page.
 *
 * Through `runProbes`, as a monitor would be, so a region is measured from a
 * probe agent exactly as from here, and a monitor made of it afterwards reads
 * the same. Nothing is stored: the page shows the reading and lets it go.
 */

/** Pings a region gets: enough to read loss in steps of 10%, few enough for a whole grid to finish quickly. */
const PACKETS = 10

/**
 * Tests run at once, across everyone using the page, and how many more may
 * wait. A grid is dozens of tests, each a few packets to someone else's
 * server: this keeps one person, or a script, from turning it into a flood.
 */
const MAX_RUNNING = 6
const MAX_WAITING = 120

export class GamePingBusyError extends Error {
  constructor() {
    super('Too many tests are running. Try again in a moment.')
  }
}

let running = 0
const waiting: (() => void)[] = []

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) {
    if (waiting.length >= MAX_WAITING) throw new GamePingBusyError()
    await new Promise<void>(resolve => waiting.push(resolve))
  }
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

export function testRegion(gameId: string, region: GameRegion, probe: ProbeId): Promise<RegionReading> {
  const { probeType, probeConfig } = probeFor(region.method)
  return withSlot(async () => {
    try {
      const [result] = await runProbes(
        {
          id: `game-ping:${gameId}:${region.id}`,
          host: region.host,
          probeType,
          // Game traffic is IPv4 almost everywhere, and the relays and beacons are listed by it.
          ipVersion: 'ipv4',
          probeConfig: probeType === 'ping' ? { ...probeConfig, packets: PACKETS } : probeConfig,
          probeAgentId: null,
          probes: [{ id: probe, position: 0 }],
        },
        probe
      )
      return {
        latency: result.p50Latency ?? result.latency ?? null,
        loss: result.packetLoss ?? 100,
        jitter: result.jitter ?? null,
        ...(result.resolvedAddress ? { address: result.resolvedAddress } : {}),
        ...(!result.success && result.errorMessage ? { error: result.errorMessage } : {}),
      }
    } catch (error) {
      if (error instanceof ProbeAgentUnavailableError) return { latency: null, loss: 100, jitter: null, error: `${error.agentName}: ${error.message}` }
      throw error
    }
  })
}
