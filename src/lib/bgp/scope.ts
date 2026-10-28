import { BGP_REGION_LABEL, BGP_REGIONS, type BgpPeerRoute, type BgpRegion, type BgpUpstreamShare } from '@/types/bgp'
import { countryName } from './countries'
import { upstreamOf } from './path'

/**
 * What a prefix's page is narrowed to: a region, then a country in it, and
 * an upstream. Every panel below the cards shows the peers in that scope, so
 * a region chosen shows who carries it there, and an upstream chosen shows
 * where it is carried by it. Pure.
 */

export interface Scope {
  region: BgpRegion | null
  country: string | null
  upstream: number | null
}

export const WORLD: Scope = { region: null, country: null, upstream: null }

export function inPlace(peer: Pick<BgpPeerRoute, 'region' | 'country'>, scope: Scope): boolean {
  return (scope.region === null || peer.region === scope.region) && (scope.country === null || peer.country === scope.country)
}

/** The upstream the peer reaches it through, by the route that counts. */
export function upstreamOfPeer(peer: BgpPeerRoute): number | null {
  return peer.route && peer.effective ? upstreamOf(peer.route.path) : null
}

export function inScope(peer: BgpPeerRoute, scope: Scope): boolean {
  return inPlace(peer, scope) && (scope.upstream === null || upstreamOfPeer(peer) === scope.upstream)
}

/** "Africa", "South Africa", or "the world", for a sentence. */
export function placeLabel(scope: Scope): string {
  if (scope.country) return countryName(scope.country)
  if (scope.region) return BGP_REGION_LABEL[scope.region]
  return 'the world'
}

/** Who carries it to these peers, biggest first, as the status counts it for all of them. */
export function upstreamShares(peers: readonly BgpPeerRoute[], usual: readonly BgpUpstreamShare[]): BgpUpstreamShare[] {
  const expected = new Map(usual.map(each => [each.asn, each.expected]))
  const counts = new Map<number, number>()
  for (const peer of peers) {
    const upstream = upstreamOfPeer(peer)
    if (upstream !== null) counts.set(upstream, (counts.get(upstream) ?? 0) + 1)
  }
  return [...counts]
    .map(([asn, count]) => ({ asn, peers: count, expected: expected.get(asn) ?? true }))
    .sort((a, b) => b.peers - a.peers)
}

/** One row of "Where it is seen": a region, a country, or an exchange. */
export interface PlaceShare {
  key: string
  label: string
  /** The ISO code, on a country's row. */
  country?: string
  seen: number
  total: number
  /** Of those that see it, how many through the upstream chosen. */
  via: number
}

/**
 * The rows for the level the scope is at: the regions for the world, the
 * countries for a region, and the exchanges for a country.
 */
export function placeShares(peers: readonly BgpPeerRoute[], scope: Scope): PlaceShare[] {
  const rows = new Map<string, PlaceShare>()
  const level = scope.country ? 'exchange' : scope.region ? 'country' : 'region'
  for (const peer of peers) {
    if (!inPlace(peer, scope)) continue
    const key = level === 'region' ? peer.region : level === 'country' ? peer.country : peer.collector
    let row = rows.get(key)
    if (!row) {
      row =
        level === 'region'
          ? { key, label: BGP_REGION_LABEL[peer.region], seen: 0, total: 0, via: 0 }
          : level === 'country'
            ? { key, label: countryName(peer.country), country: peer.country, seen: 0, total: 0, via: 0 }
            : { key, label: peer.location, seen: 0, total: 0, via: 0 }
      rows.set(key, row)
    }
    row.total++
    if (peer.route) row.seen++
    if (scope.upstream !== null && upstreamOfPeer(peer) === scope.upstream) row.via++
  }
  const list = [...rows.values()]
  if (level === 'region') {
    // Every region, in their usual order, including those without peers.
    return BGP_REGIONS.map(region => rows.get(region) ?? { key: region, label: BGP_REGION_LABEL[region], seen: 0, total: 0, via: 0 })
  }
  return list.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
}
