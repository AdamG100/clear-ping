import type { Target } from '@/types/probe'

/**
 * How a group of targets is doing, as one state.
 *
 * For where a group is shown without its targets, and has to answer the one
 * question worth asking of it there: is anything in here wrong.
 */

export interface GroupHealth {
  online: number
  offline: number
  /** Not measured yet. */
  pending: number
  paused: number
  /** The worst packet loss among the targets that are answering. */
  worstLoss: number
}

type HealthInput = Pick<Target, 'status' | 'isOnline' | 'packetLoss'>

export function summarizeGroupHealth(targets: HealthInput[]): GroupHealth {
  const health: GroupHealth = { online: 0, offline: 0, pending: 0, paused: 0, worstLoss: 0 }

  for (const target of targets) {
    // A paused target's last reading is from before it was paused. It counts
    // as neither up nor down, and its loss says nothing about now.
    if (target.status === 'paused') health.paused++
    else if (target.isOnline === undefined) health.pending++
    else if (target.isOnline) {
      health.online++
      health.worstLoss = Math.max(health.worstLoss, target.packetLoss ?? 0)
    } else health.offline++
  }

  return health
}

/**
 * The group's state as a single light: down if anything in it is down, up if
 * something is answering, and undecided if nothing has been asked.
 *
 * One target down out of twenty makes the group red. That is the point: the
 * light is there to say whether the group needs opening.
 */
export function groupIsOnline(health: GroupHealth): boolean | undefined {
  if (health.offline > 0) return false
  return health.online > 0 ? true : undefined
}

/** Nothing in the group is being probed, so it has no state to show. */
export function groupIsPaused(health: GroupHealth): boolean {
  return health.paused > 0 && health.online + health.offline + health.pending === 0
}

/** "2 online, 1 offline": the counts that are not zero, the bad news first. */
export function describeGroupHealth(health: GroupHealth): string {
  const parts = [
    health.offline > 0 && `${health.offline} offline`,
    health.online > 0 && `${health.online} online`,
    health.pending > 0 && `${health.pending} pending`,
    health.paused > 0 && `${health.paused} paused`,
  ].filter((part): part is string => !!part)

  return parts.length > 0 ? parts.join(', ') : 'no targets'
}
