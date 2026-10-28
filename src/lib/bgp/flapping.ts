import type { BgpUpdate } from '@/types/bgp'
import { upstreamOf } from './path'

/**
 * Flapping: a route whose way in keeps changing. Each update that changed
 * which upstream a session reaches the prefix through (or withdrew its route,
 * or gave it one) is a change; FLAP_CHANGES of them within FLAP_WINDOW_MS and
 * the route is flapping. Updates on the same path, which change nothing about
 * the way in, do not count.
 */

export const FLAP_CHANGES = 3
export const FLAP_WINDOW_MS = 24 * 60 * 60 * 1000

export interface WayChange {
  update: BgpUpdate
  /** The upstream it reaches it through after the update and before; null for no route. */
  now: number | null
  was: number | null
}

/**
 * The updates that changed a session's way in, newest first, by
 * `collector|peer`, for the sessions asked about. Updates whose path before
 * is not known are left out: whether they changed anything is not known.
 */
export function wayChanges(updates: readonly BgpUpdate[], sessions: ReadonlySet<string>): Map<string, WayChange[]> {
  const changes = new Map<string, WayChange[]>()
  for (const update of [...updates].sort((a, b) => b.at - a.at)) {
    const key = `${update.collector}|${update.peer}`
    if (!sessions.has(key) || update.previousPath === undefined) continue
    const now = update.path ? upstreamOf(update.path) : null
    const was = update.previousPath ? upstreamOf(update.previousPath) : null
    if (update.kind === 'announce' && now === was) continue
    changes.set(key, [...(changes.get(key) ?? []), { update, now, was }])
  }
  return changes
}

/** How many of a session's changes fall within the window back from `at`, when that is enough to be flapping; else 0. */
export function flapCount(changes: readonly WayChange[], at: number): number {
  const recent = changes.filter(({ update }) => update.at <= at && at - update.at < FLAP_WINDOW_MS).length
  return recent >= FLAP_CHANGES ? recent : 0
}
