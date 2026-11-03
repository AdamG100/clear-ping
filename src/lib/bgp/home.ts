import { BGP_DIRECT, type BgpCrossingRun, type BgpHome, type BgpHomeTrace, type BgpPeerRoute, type BgpRoute, type BgpVantage } from '@/types/bgp'
import { countryRegion } from './countries'
import type { Target } from '@/types/probe'
import { getAllTargets } from '../db/database'
import { runTrace } from '../probe-agents/client'
import { localProbeName } from '../probe-agents/probes'
import { listProbeAgents } from '../probe-agents/store'
import { DEFAULT_LOCAL_PROBE_NAME } from '@/types/probe-agent'
import { collectorInfo } from './collectors'
import { crossingOf, exchangeData, exchangeOf, likelyCrossing, memberOf, type ExchangeData } from './exchanges'
import { upstreamOf } from './path'
import { addressIn, firstHost, isAddress, isPublicAddress } from './prefix'
import { addressAsn } from './ripestat'
import { getExcludedAgents, listBgpTraces, recordBgpTrace, type BgpTraceRow } from './store'

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
const TRACE_GAP_MS = 15 * 60 * 1000
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
  const [agents, excluded, localName] = await Promise.all([
    listProbeAgents().catch(() => []),
    getExcludedAgents().catch((): string[] => []),
    localProbeName().catch(() => DEFAULT_LOCAL_PROBE_NAME),
  ])
  return [
    { id: SERVER, name: localName, probeAgentId: null, unavailable: null },
    ...agents.filter(agent => !excluded.includes(agent.id)).map(agent => ({
      id: agent.id,
      name: agent.name,
      probeAgentId: agent.id,
      unavailable:
        agent.state !== 'online' ? 'It cannot be reached now' : agent.tools?.traceroute === false ? 'It has no traceroute installed' : null,
    })),
  ]
}

/** Every probe agent, and whether Routing uses it. */
export async function agentChoices(): Promise<BgpHome['agents']> {
  const [agents, excluded] = await Promise.all([listProbeAgents().catch(() => []), getExcludedAgents().catch((): string[] => [])])
  return agents.map(agent => ({ id: agent.id, name: agent.name, included: !excluded.includes(agent.id) }))
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

/** Networks found for addresses, those being looked up, and those waiting to be. */
const asnOfAddress = new Map<string, number | null>()
const looking = new Set<string>()
const queued: string[] = []
/** Looked up a few at a time: a page of traces holds dozens of hops, and RIPEstat turns away a crowd. */
const MOST_LOOKING = 4

function lookUpNext(): void {
  while (looking.size < MOST_LOOKING && queued.length > 0) {
    const address = queued.shift()!
    if (asnOfAddress.has(address) || looking.has(address)) continue
    looking.add(address)
    void addressAsn(address)
      .then(asn => asnOfAddress.set(address, asn))
      // A failed lookup is not remembered: RIPEstat being busy once must not leave the network unknown until a restart.
      .catch(() => {})
      .finally(() => {
        looking.delete(address)
        lookUpNext()
      })
  }
}

/**
 * The network an address on the internet belongs to, if known yet. Looked up
 * once, in the background, and known from then on; until then null.
 */
function asnOf(address: string | null): number | null {
  if (!address || !isPublicAddress(address)) return null
  const known = asnOfAddress.get(address)
  if (known !== undefined) return known
  if (!looking.has(address) && !queued.includes(address)) {
    queued.push(address)
    lookUpNext()
  }
  return null
}

/**
 * The network a hop's address belongs to: on an exchange's LAN, the member
 * IXPDB says it is (RIPEstat would name the exchange's own network, or
 * nothing); elsewhere as asnOf finds it.
 */
function hopAsn(address: string | null, data: ExchangeData | null): number | null {
  return memberOf(address, data?.ports ?? {}) ?? asnOf(address)
}

/** The network of the first hop on the internet in a trace: the one that vantage point reaches the internet through. */
function networkOf(trace: Pick<BgpTraceRow, 'hops'> | undefined): number | null {
  const hop = trace?.hops.find(each => each.address && isPublicAddress(each.address))
  return asnOf(hop?.address ?? null)
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

/**
 * The networks a trace passed through, from each hop's network in turn: the
 * same one twice in a row once, those not known left out. Pure.
 */
export function asPathOf(asns: readonly (number | null)[]): number[] {
  const path: number[] = []
  for (const asn of asns) if (asn !== null && asn > 0 && path[path.length - 1] !== asn) path.push(asn)
  return path
}

/** Where a trace crossed, by hop on a LAN or else by the members either side of a hop. */
function crossedBy(hops: BgpTraceRow['hops'], data: ExchangeData | null): Pick<BgpCrossingRun, 'crossing' | 'likely'> {
  const crossing = crossingOf(hops, data?.lans ?? [])
  if (crossing) return { crossing: crossing.name, likely: null }
  const likely = data ? likelyCrossing(hops.map(hop => ({ hop: hop.hop, asn: hopAsn(hop.address, data) })), data) : null
  return { crossing: null, likely: likely ? likely.exchanges.map(exchange => exchange.name) : null }
}

/** The traces that got somewhere, newest first, gathered into runs that crossed the same way. */
export function crossingRuns(traces: readonly { at: number; crossed: Pick<BgpCrossingRun, 'crossing' | 'likely'> }[]): BgpCrossingRun[] {
  const runs: BgpCrossingRun[] = []
  for (const { at, crossed } of traces) {
    const last = runs[runs.length - 1]
    if (last && last.crossing === crossed.crossing && (last.likely ?? []).join() === (crossed.likely ?? []).join()) {
      last.from = at
      last.traces++
    } else {
      runs.push({ from: at, to: at, traces: 1, ...crossed })
    }
  }
  return runs
}

function homeTrace(traces: BgpTraceRow[], targetName: string | null, data: ExchangeData | null): BgpHomeTrace | null {
  // A trace that failed outright says nothing about where it crossed: the
  // newest one that got somewhere is shown, with the failure if it is newer.
  const [latest] = traces
  if (!latest) return null
  const lans = data?.lans ?? []
  const ports = data?.ports ?? {}
  const usable = traces.filter(trace => trace.hops.length > 0)
  const shown = usable[0] ?? latest
  const crossing = crossingOf(shown.hops, lans, ports)
  const history = crossingRuns(usable.map(trace => ({ at: trace.at, crossed: crossedBy(trace.hops, data) })))
  // No hop on an exchange's LAN: where it passes between two members of one, it probably crossed there.
  const likely = !crossing && data ? likelyCrossing(shown.hops.map(hop => ({ hop: hop.hop, asn: hopAsn(hop.address, data) })), data) : null
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
      member: memberOf(hop.address, ports),
    })),
    crossing,
    likely: likely ? { names: likely.exchanges.map(exchange => exchange.name), from: likely.from, to: likely.to, hop: likely.hop } : null,
    history,
  }
}

/** Every vantage point's view of the prefix: its network, its routes and its traces. */
export async function homeView(
  prefixId: string,
  prefix: string,
  watchedFor: string | null,
  homeAsns: readonly number[],
  peers: readonly BgpPeerRoute[],
  /** The country a network is registered in, where it has been looked up. */
  countryOf: (asn: number) => string | undefined = () => undefined
): Promise<BgpHome> {
  const [points, toward, traces, exchanges, agents] = await Promise.all([
    vantages(),
    destinations(prefix, watchedFor),
    listBgpTraces(prefixId),
    exchangeData(),
    agentChoices(),
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
      .map(each => homeTrace(own.filter(trace => trace.address === each.address), names.get(each.address) ?? null, exchanges))
      .filter((trace): trace is BgpHomeTrace => trace !== null)
    // The way its traffic went, by the newest trace to any of them that got somewhere, starting from its own network.
    const newest = own.find(trace => trace.hops.length > 0 && toward.some(each => each.address === trace.address))
    const traced = newest ? asPathOf(newest.hops.map(hop => hopAsn(hop.address, exchanges))) : []
    const tracedPath = asns[0] !== undefined && traced.length > 0 && traced[0] !== asns[0] ? [asns[0], ...traced] : traced
    const country = asns[0] !== undefined ? countryOf(asns[0]) : undefined
    return {
      id: point.id,
      name: point.name,
      kind: point.id === SERVER ? 'server' : 'probe-agent',
      asns,
      found,
      routes: peers.filter(peer => asns.includes(peer.peerAsn)),
      traces: shown,
      tracedPath,
      place: country ? { country, region: countryRegion(country) } : null,
      unavailable: point.unavailable,
    }
  })
  return {
    asns: [...homeAsns],
    vantages: views,
    mine: Object.fromEntries(mine),
    agents,
    exchangesKnown: (exchanges?.lans.length ?? 0) > 0,
  }
}
