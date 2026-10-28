import { BGP_DIRECT, BGP_REGION_LABEL, BGP_REGIONS, type BgpBaseline, type BgpPrefix, type BgpRegion, type BgpRoute, type BgpShare, type BgpState, type BgpStatus } from '@/types/bgp'
import { collectorInfo, peerPlace } from './collectors'
import { isDirect, originOf, upstreamOf } from './path'
import { addressIn, prefixLength, prefixWithin } from './prefix'

/**
 * Judging a prefix: what normal is, taken from the routes the collectors had
 * when it was added, and how the routes they have now compare. Pure.
 */

/** More than this share of the peers reaching it through a network it was not reached through before is a diversion. */
const DIVERTED_SHARE = 0.2
/** Below this share of the peers that saw it, it is partly withdrawn; below the next, withdrawn. */
const PARTIAL_VISIBILITY = 0.8
const WITHDRAWN_VISIBILITY = 0.1
/** This many peers seeing another network announce it is a suspected hijack, not one confused peer. */
const HIJACK_PEERS = 2
/**
 * At one collector, this share or more of the peers that reached it directly
 * now reaching it through an upstream is it gone off the exchange there: what
 * pulling a prefix from the exchanges onto transit looks like. Counted where
 * at least OFF_EXCHANGE_PEERS reached it directly.
 */
const OFF_EXCHANGE_SHARE = 0.5
const OFF_EXCHANGE_PEERS = 2

export function peerKey(route: Pick<BgpRoute, 'collector' | 'peer'>): string {
  return `${route.collector}|${route.peer}`
}

/**
 * The one route of each peer that counts: for an address, the most specific
 * route that holds it, which is the one its traffic follows; otherwise the
 * route for the prefix itself, or failing that the most specific one.
 */
export function effectiveRoutes(routes: readonly BgpRoute[], prefix: string, address: string | null): Map<string, BgpRoute> {
  const rank = (route: BgpRoute) =>
    address ? prefixLength(route.prefix) : route.prefix === prefix ? Infinity : prefixLength(route.prefix)
  const byPeer = new Map<string, BgpRoute>()
  for (const route of routes) {
    if (!prefixWithin(route.prefix, prefix)) continue
    if (address && !addressIn(address, route.prefix)) continue
    const held = byPeer.get(peerKey(route))
    if (!held || rank(route) > rank(held)) byPeer.set(peerKey(route), route)
  }
  return byPeer
}

/** What normal is: the networks seen announcing it and carrying it to the peers, now. */
export function takeBaseline(routes: readonly BgpRoute[], prefix: string, address: string | null, at: number): BgpBaseline {
  const counted = [...effectiveRoutes(routes, prefix, address).values()]
  const upstreamPeers = new Map<number, number>()
  const origins = new Set<number>()
  for (const route of counted) {
    const origin = originOf(route.path)
    const upstream = upstreamOf(route.path)
    if (origin !== null) origins.add(origin)
    if (upstream !== null) upstreamPeers.set(upstream, (upstreamPeers.get(upstream) ?? 0) + 1)
  }
  // Every one seen is usual, however few peers it carried: a single peer's
  // way in is no news. It is a large share moving to new ones that is.
  const usual = [...upstreamPeers].sort((a, b) => b[1] - a[1]).map(([asn]) => asn)
  return {
    at,
    origins: [...origins].sort((a, b) => a - b),
    upstreams: usual,
    peers: [...new Set(routes.filter(route => prefixWithin(route.prefix, prefix)).map(peerKey))].sort(),
    prefixes: [...new Set(routes.map(route => route.prefix).filter(each => prefixWithin(each, prefix)))].sort(),
    directPeers: counted.filter(route => isDirect(route.path)).map(peerKey).sort(),
  }
}

function emptyRegions(): Record<BgpRegion, BgpShare> {
  return Object.fromEntries(BGP_REGIONS.map(region => [region, { seen: 0, total: 0 }])) as Record<BgpRegion, BgpShare>
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** The region a peer (collector|peer) sees from, when nothing more is known of it than its collector. */
function byCollector(key: string): BgpRegion {
  return peerPlace(key.split('|')[0], 0, () => undefined).region
}

/**
 * How the prefix stands now, against what was normal. `regionOf` places a
 * peer, given as collector|peer; the monitor knows more about some than their
 * collector says (see collectors.ts). `offExchanges` are the exchanges'
 * own collectors' reasons it has gone off them (see looking-glass.ts), each a
 * diversion.
 */
export function assess(
  prefix: Pick<BgpPrefix, 'prefix' | 'address' | 'baseline'>,
  routes: readonly BgpRoute[],
  regionOf: (key: string) => BgpRegion = byCollector,
  offExchanges: readonly string[] = []
): BgpStatus {
  const baseline = prefix.baseline
  const within = routes.filter(route => prefixWithin(route.prefix, prefix.prefix))
  const counted = effectiveRoutes(within, prefix.prefix, prefix.address)

  // Seen by a peer is having any route into it. Out of every peer that saw it
  // when normal was taken, and any that has started to since.
  const seenPeers = new Set(within.map(peerKey))
  const allPeers = new Set([...(baseline?.peers ?? []), ...seenPeers])
  const byRegion = emptyRegions()
  for (const key of allPeers) {
    const share = byRegion[regionOf(key)]
    share.total++
    if (seenPeers.has(key)) share.seen++
  }
  const visibility = { seen: seenPeers.size, total: allPeers.size }

  const upstreamPeers = new Map<number, number>()
  const originPeers = new Map<number, number>()
  for (const route of counted.values()) {
    const upstream = upstreamOf(route.path)
    const origin = originOf(route.path)
    if (upstream !== null) upstreamPeers.set(upstream, (upstreamPeers.get(upstream) ?? 0) + 1)
    if (origin !== null) originPeers.set(origin, (originPeers.get(origin) ?? 0) + 1)
  }
  const usual = new Set(baseline?.upstreams ?? [])
  const upstreams = [...upstreamPeers]
    .map(([asn, peers]) => ({ asn, peers, expected: !baseline || asn === BGP_DIRECT || usual.has(asn) }))
    .sort((a, b) => b.peers - a.peers)

  const newPrefixes = baseline
    ? [...new Set(within.map(route => route.prefix))].filter(each => !baseline.prefixes.includes(each)).sort()
    : []
  const lastChange = within.length > 0 ? Math.max(...within.map(route => route.since)) : null

  const status = (state: BgpState, reasons: string[]): BgpStatus => ({
    state,
    reasons,
    visibility,
    byRegion,
    upstreams,
    origins: [...originPeers.keys()].sort((a, b) => a - b),
    newPrefixes,
    lastChange,
  })

  if (!baseline) return status('learning', ['No picture of normal yet: it is taken from the first routes seen'])

  const reasons: string[] = []
  let state: BgpState = 'normal'
  const worse = (next: BgpState) => {
    const order: BgpState[] = ['normal', 'diverted', 'partial', 'withdrawn', 'hijack']
    if (order.indexOf(next) > order.indexOf(state)) state = next
  }

  const foreign = [...originPeers].filter(([asn, peers]) => !baseline.origins.includes(asn) && peers >= HIJACK_PEERS)
  for (const [asn, peers] of foreign) {
    reasons.push(`AS${asn} is announcing it, seen by ${peers} peers`)
    worse('hijack')
  }

  const seenShare = visibility.total > 0 ? visibility.seen / visibility.total : 0
  if (seenShare < WITHDRAWN_VISIBILITY) {
    reasons.push(`Withdrawn: seen by ${visibility.seen} of ${visibility.total} peers`)
    worse('withdrawn')
  } else if (seenShare < PARTIAL_VISIBILITY) {
    const gone = Object.entries(byRegion)
      .filter(([, share]) => share.total > 0 && share.seen / share.total < PARTIAL_VISIBILITY)
      .map(([region]) => BGP_REGION_LABEL[region as BgpRegion])
    reasons.push(`Seen by ${percent(seenShare)} of peers${gone.length > 0 ? `, lowest in ${gone.join(', ')}` : ''}`)
    worse('partial')
  }

  const unusual = upstreams.filter(upstream => !upstream.expected)
  const unusualPeers = unusual.reduce((sum, upstream) => sum + upstream.peers, 0)
  if (counted.size > 0 && unusualPeers / counted.size >= DIVERTED_SHARE) {
    const names = unusual.slice(0, 3).map(upstream => `AS${upstream.asn}`).join(', ')
    reasons.push(`${percent(unusualPeers / counted.size)} of peers now reach it through ${names}`)
    worse('diverted')
  }
  for (const reason of [...offExchange(baseline, counted), ...offExchanges]) {
    reasons.push(reason)
    worse('diverted')
  }
  if (newPrefixes.length > 0) {
    reasons.push(`${newPrefixes.join(', ')} announced, which was not before`)
    worse('diverted')
  }

  if (state === 'normal') reasons.push('Carried as it was when normal was taken')
  return status(state, reasons)
}

/**
 * Where the peers that reached it directly when normal was taken have, for
 * the most part, gone over to an upstream, one reason per collector: the
 * prefix taken off the exchange there. A peer that no longer sees it at all
 * is a withdrawal, counted as one, not here.
 */
export function offExchange(baseline: BgpBaseline, counted: ReadonlyMap<string, BgpRoute>): string[] {
  const byCollector = new Map<string, { still: number; moved: number; through: Map<number, number> }>()
  for (const key of baseline.directPeers ?? []) {
    const route = counted.get(key)
    if (!route) continue
    const collector = key.split('|')[0]
    const tally = byCollector.get(collector) ?? { still: 0, moved: 0, through: new Map() }
    if (isDirect(route.path)) {
      tally.still++
    } else {
      tally.moved++
      const upstream = upstreamOf(route.path)
      if (upstream !== null) tally.through.set(upstream, (tally.through.get(upstream) ?? 0) + 1)
    }
    byCollector.set(collector, tally)
  }
  const reasons: string[] = []
  for (const [collector, tally] of byCollector) {
    const was = tally.still + tally.moved
    if (was < OFF_EXCHANGE_PEERS || tally.moved / was < OFF_EXCHANGE_SHARE) continue
    const through = [...tally.through].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([asn]) => `AS${asn}`).join(', ')
    reasons.push(
      `Off the exchange at ${collectorInfo(collector).location}: ${tally.moved} of the ${was} peers there that reached it directly now go through ${through}`
    )
  }
  return reasons
}
