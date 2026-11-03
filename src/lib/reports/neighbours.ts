import type { Target } from '@/types/probe'
import type { ProbeId } from '@/types/probe-agent'
import { primaryProbeOf, probeIdsOf } from '../targets/probes'
import { getAllTargets, getLossMoments } from '../db/database'
import { classifyHost, isLocalHost, isPrivateAddress } from '../probes/host'
import type { Neighbour } from './loss'

/**
 * The targets a target's loss is held against: every other one measured from
 * the same probe, this server or the same probe agent, and only the readings
 * that probe took. A target measured from somewhere else crosses other
 * networks, and its loss says nothing about this one's.
 */
export async function readNeighbours(
  target: Target,
  startTime: Date,
  endTime: Date,
  /** The probe the loss is being looked at from; the target's primary one when left out. */
  probe: ProbeId = primaryProbeOf(target)
): Promise<Neighbour[]> {
  const others = (await getAllTargets()).filter(other => other.id !== target.id && probeIdsOf(other).includes(probe))
  const moments = await getLossMoments(others.map(other => other.id), startTime, endTime, probe)

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
