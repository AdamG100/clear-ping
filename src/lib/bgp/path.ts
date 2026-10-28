import { BGP_DIRECT } from '@/types/bgp'

/**
 * AS paths: the networks a route passes through, from the collector's peer to
 * the network that announces the prefix. Pure: the routing pages use it too.
 */

/**
 * The path as numbers. RIS Live sends an AS_SET (an aggregate's mix of
 * origins) as an array within the path, and RIPEstat writes it as {1,2}: both
 * are flattened into the path in the order given.
 */
export function flattenPath(path: ReadonlyArray<number | readonly number[]> | string): number[] {
  if (typeof path === 'string') {
    return path
      .replace(/[{}]/g, ' ')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite)
  }
  return path.flatMap(hop => (Array.isArray(hop) ? hop : [hop as number]))
}

/** The path with prepending taken out: each network once, where it first appears. */
export function hops(path: readonly number[]): number[] {
  return path.filter((asn, index) => index === 0 || asn !== path[index - 1])
}

/** The network that announces the prefix: the end of the path. */
export function originOf(path: readonly number[]): number | null {
  return path.length > 0 ? path[path.length - 1] : null
}

/**
 * The network the origin is reached through: the one before it in the path,
 * when it is a network between the peer and the origin. A peer that peers
 * with the origin directly (at an exchange, or privately), or is the origin,
 * reaches it through nothing: BGP_DIRECT.
 */
export function upstreamOf(path: readonly number[]): number | null {
  const each = hops(path)
  if (each.length === 0) return null
  return each.length <= 2 ? BGP_DIRECT : each[each.length - 2]
}

/** Whether the peer reaches the origin with no network in between. */
export function isDirect(path: readonly number[]): boolean {
  const each = hops(path)
  return each.length > 0 && each.length <= 2
}
