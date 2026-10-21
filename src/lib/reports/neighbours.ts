import type { Target } from '@/types/probe'
import { getAllTargets, getLossMoments } from '../db/database'
import { classifyHost, isLocalHost, isPrivateAddress } from '../probes/host'
import type { Neighbour } from './loss'

/**
 * The targets a target's loss is held against: every other one probed from
 * the same place, this server or the same probe agent. A target probed from
 * somewhere else crosses other networks, and its loss says nothing about
 * this one's.
 */
export async function readNeighbours(target: Target, startTime: Date, endTime: Date): Promise<Neighbour[]> {
  const from = target.probeAgentId ?? null
  const others = (await getAllTargets()).filter(other => other.id !== target.id && (other.probeAgentId ?? null) === from)
  const moments = await getLossMoments(others.map(other => other.id), startTime, endTime)

  return others.map(other => ({
    targetId: other.id,
    name: other.name,
    host: other.host,
    local: classifyHost(other.host) === 'hostname' ? isLocalHost(other.host) : isPrivateAddress(other.host),
    intervalMs: other.interval * 1000,
    probes: moments.get(other.id)?.probes ?? 0,
    affected: moments.get(other.id)?.affected ?? [],
  }))
}
