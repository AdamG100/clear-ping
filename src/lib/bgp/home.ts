import { BGP_DIRECT, type BgpCrossing, type BgpHome, type BgpHomeTrace, type BgpPeerRoute, type BgpRoute, type BgpVantage } from '@/types/bgp'
import type { Target } from '@/types/probe'
import { getAllTargets } from '../db/database'
import { runTrace } from '../probe-agents/client'
import { listProbeAgents } from '../probe-agents/store'
import { collectorInfo } from './collectors'
import { crossingOf, exchangeLans, exchangeOf, type ExchangeLan } from './exchanges'
import { upstreamOf } from './path'
import { addressIn, firstHost, isAddress, isPublicAddress } from './prefix'
import { addressAsn } from './ripestat'
import { listBgpTraces, recordBgpTrace, type BgpTraceRow } from './store'

/**
 * "From your networks": how the prefix is reached from where you are. Each
 * vantage point (this server, and each probe agent) is on a network of its
 * own, and has two views of the prefix:
 * - its network's routes, where that network shares them with RIS's
 *   collectors, picked out from every other peer's;
 * - the path its traffic takes, by traceroute into the prefix, and the
 *   exchange it crosses, which BGP cannot show.
 *
 * This server's network is the one you set; a probe agent's is found from its
 * traces, as the network of the first hop on the internet.
 *
 * The traces are Routing's own, kept with the prefix rather than in a
 * target's history. They are taken when how the prefix stands changes, when a
 * route of yours changes, when asked, and when the newest is older than
 * STALE_MS.
 */

/** Traces older than this are taken again, at the half-hourly re-read. */
export const STALE_MS = 6 * 60 * 60 * 1000
/** However often the routes change, a prefix is traced at most this often unasked. */
const TRACE_GAP_MS = 5 * 60 * 1000
/** The addresses in a prefix traced to: its targets, up to this many. */
const MOST_DESTINATIONS = 4

const SERVER = 'server'

interface Vantage {
  id: string
  name: string
  probeAgentId: string | null
  unavailable: string | null
}

async function vantages(): Promise<Vantage[]> {
  const agents = await listProbeAgents().catch(() => [])
  return [
    { id: SERVER, name: 'This server', probeAgentId: null, unavailable: null },
    ...agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      probeAgentId: agent.id,
      unavailable:
        agent.state !== 'online' ? 'It cannot be reached now' : agent.tools?.traceroute === false ? 'It has no traceroute installed' : null,
    })),
  ]
}

/** Your targets whose address is inside the prefix, paused ones aside. */
export async function targetsInside(prefix: string): Promise<Target[]> {
  const targets = await getAllTargets()
  return targets.filter(target => {
    if (target.status === 'paused') return false
    return addressIn(target.host, prefix) || (!!target.resolvedAddress && addressIn(target.resolvedAddress, prefix))
  })
}

/**
 * Where in the prefix to trace to: the addresses of your targets in it, or
 * else the address it is watched for, or else its first address. A trace
 * shows the way in whether or not the far end answers.
 */
async function destinations(prefix: string, watchedFor: string | null): Promise<{ address: string; targetName: string | null }[]> {
  const chosen = new Map<string, string | null>()
  for (const target of await targetsInside(prefix)) {
    const address = isAddress(target.host) ? target.host : target.resolvedAddress
    if (address && addressIn(address, prefix) && !chosen.has(address)) chosen.set(address, target.name)
    if (chosen.size >= MOST_DESTINATIONS) break
  }
  if (chosen.size === 0) {
    const fallback = watchedFor ?? firstHost(prefix)
    if (fallback) chosen.set(fallback, null)
  }
  return [...chosen].map(([address, targetName]) => ({ address, targetName }))
}

// ─── Your routes ────────────────────────────────────────────────────────────

/** What each of your networks' sessions with RIS reaches it through, by collector|peer. */
export function homeCarriers(routes: Iterable<BgpRoute>, mine: ReadonlyMap<number, string>): Map<string, number | null> {
  const carriers = new Map<string, number | null>()
  for (const route of routes) {
    if (mine.has(route.peerAsn)) carriers.set(`${route.collector}|${route.peer}|${route.peerAsn}`, upstreamOf(route.path))
  }
  return carriers
}

function through(carrier: number | null | undefined): string {
  if (carrier === undefined || carrier === null) return 'with no route'
  return carrier === BGP_DIRECT ? 'directly' : `through AS${carrier}`
}

/** In words, each of your networks' sessions whose way to the prefix changed, saying whose network it is. */
export function homeChanges(
  before: ReadonlyMap<string, number | null>,
  after: ReadonlyMap<string, number | null>,
  mine: ReadonlyMap<number, string>
): string[] {
  const reasons: string[] = []
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key)
    const now = after.get(key)
    if (was === now) continue
    const [collector, , asn] = key.split('|')
    const whose = mine.get(Number(asn))
    const network = whose === 'This server' ? `Your network (AS${asn})` : `${whose ?? 'Your network'}'s network (AS${asn})`
    reasons.push(`${network} at ${collectorInfo(collector).location} now reaches it ${through(now)}, was ${through(was)}`)
  }
  return reasons
}

// ─── Your networks ──────────────────────────────────────────────────────────

/** Networks found for addresses, and those being looked up. */
const asnOfAddress = new Map<string, number | null>()
const looking = new Set<string>()

/**
 * The network of the first hop on the internet in a trace, if known: the
 * network that vantage point reaches the internet through. Looked up once,
 * in the background, and known from then on.
 */
function networkOf(trace: Pick<BgpTraceRow, 'hops'> | undefined): number | null {
  const hop = trace?.hops.find(each => each.address && isPublicAddress(each.address))
  if (!hop?.address) return null
  const known = asnOfAddress.get(hop.address)
  if (known !== undefined) return known
  if (!looking.has(hop.address)) {
    looking.add(hop.address)
    void addressAsn(hop.address)
      .then(asn => asnOfAddress.set(hop.address!, asn))
      .catch(() => asnOfAddress.set(hop.address!, null))
      .finally(() => looking.delete(hop.address!))
  }
  return null
}

// ─── Your traffic ───────────────────────────────────────────────────────────

const lastTraced = new Map<string, number>()

/**
 * Trace into the prefix from every vantage point that can, each to every
 * destination, the vantage points at once and each one's traces in turn.
 * `force` traces however recently it was traced; otherwise not more than
 * once in TRACE_GAP_MS, and with `staleOnly` only where the newest trace is
 * older than STALE_MS. Returns how many traces were taken.
 */
export async function traceInto(
  prefixId: string,
  prefix: string,
  watchedFor: string | null,
  options: { force?: boolean; staleOnly?: boolean } = {}
): Promise<number> {
  const now = Date.now()
  if (!options.force && now - (lastTraced.get(prefixId) ?? 0) < TRACE_GAP_MS) return 0
  lastTraced.set(prefixId, now)
  const [points, toward, kept] = await Promise.all([
    vantages(),
    destinations(prefix, watchedFor),
    options.staleOnly ? listBgpTraces(prefixId, 1) : Promise.resolve([]),
  ])
  const counts = await Promise.all(
    points
      .filter(point => !point.unavailable)
      .map(async point => {
        let taken = 0
        for (const { address } of toward) {
          const newest = kept.find(trace => trace.vantage === point.id && trace.address === address)
          if (options.staleOnly && newest && now - newest.at < STALE_MS) continue
          const at = Date.now()
          try {
            const trace = await runTrace(
              { id: `bgp:${prefixId}`, host: address, probeAgentId: point.probeAgentId },
              'manual',
              address.includes(':') ? 'ipv6' : 'ipv4'
            )
            await recordBgpTrace({ prefixId, vantage: point.id, at, address, reached: trace.reached, error: trace.errorMessage ?? null, hops: trace.hops })
            taken++
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await recordBgpTrace({ prefixId, vantage: point.id, at, address, reached: false, error: message, hops: [] }).catch(() => {})
          }
        }
        return taken
      })
  )
  return counts.reduce((sum, count) => sum + count, 0)
}

function sameCrossing(a: BgpCrossing | null, b: BgpCrossing | null): boolean {
  return (a?.name ?? null) === (b?.name ?? null)
}

function homeTrace(traces: BgpTraceRow[], targetName: string | null, lans: readonly ExchangeLan[]): BgpHomeTrace | null {
  // A trace that failed outright says nothing about where it crossed: the
  // newest one that got somewhere is shown, with the failure if it is newer.
  const [latest] = traces
  if (!latest) return null
  const usable = traces.filter(trace => trace.hops.length > 0)
  const shown = usable[0] ?? latest
  const crossing = crossingOf(shown.hops, lans)
  const changed = usable.slice(1).find(trace => !sameCrossing(crossingOf(trace.hops, lans), crossing))
  return {
    address: shown.address,
    targetName,
    at: shown.at,
    reached: shown.reached,
    error: latest.hops.length === 0 ? latest.error : null,
    hops: shown.hops.map(hop => ({
      hop: hop.hop,
      address: hop.address,
      hostname: hop.hostname ?? null,
      rtt: hop.rtts.length > 0 ? Math.min(...hop.rtts) : null,
      exchange: hop.address ? (exchangeOf(hop.address, lans)?.exchange.name ?? null) : null,
    })),
    crossing,
    before: changed ? { at: changed.at, crossing: crossingOf(changed.hops, lans) } : null,
  }
}

/** Every vantage point's view of the prefix: its network, its routes and its traces. */
export async function homeView(
  prefixId: string,
  prefix: string,
  watchedFor: string | null,
  homeAsns: readonly number[],
  peers: readonly BgpPeerRoute[]
): Promise<BgpHome> {
  const [points, toward, traces, lans] = await Promise.all([
    vantages(),
    destinations(prefix, watchedFor),
    listBgpTraces(prefixId),
    exchangeLans(),
  ])
  const mine = new Map<number, string>()
  const views: BgpVantage[] = points.map(point => {
    const own = traces.filter(trace => trace.vantage === point.id)
    const found = !(point.id === SERVER && homeAsns.length > 0)
    const asns = found ? [networkOf(own.find(trace => trace.hops.length > 0))].filter((asn): asn is number => asn !== null) : [...homeAsns]
    for (const asn of asns) if (!mine.has(asn)) mine.set(asn, point.name)
    const names = new Map(toward.map(each => [each.address, each.targetName]))
    // Every address it was traced to that is still traced to, in the order chosen.
    const shown = toward
      .map(each => homeTrace(own.filter(trace => trace.address === each.address), names.get(each.address) ?? null, lans ?? []))
      .filter((trace): trace is BgpHomeTrace => trace !== null)
    return {
      id: point.id,
      name: point.name,
      kind: point.id === SERVER ? 'server' : 'probe-agent',
      asns,
      found,
      routes: peers.filter(peer => asns.includes(peer.peerAsn)),
      traces: shown,
      unavailable: point.unavailable,
    }
  })
  return { asns: [...homeAsns], vantages: views, mine: Object.fromEntries(mine), exchangesKnown: lans !== null }
}
