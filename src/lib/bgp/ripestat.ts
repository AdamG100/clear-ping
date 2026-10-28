import type { BgpRoute } from '@/types/bgp'
import { collectorName } from './collectors'
import { flattenPath } from './path'
import { isAddress, isPrefix, tooWide } from './prefix'

/**
 * RIPEstat, RIPE NCC's public API over the same collectors RIS Live streams
 * from: which announced prefix holds an address, every collector peer's route
 * to a prefix right now, and the names of networks.
 */

const BASE = 'https://stat.ripe.net/data'
const TIMEOUT_MS = 20_000
/** Every collector peer's route to a prefix is a large answer, and slower to build: it is given longer. */
const LOOKING_GLASS_TIMEOUT_MS = 60_000

async function ask<T>(endpoint: string, resource: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const url = `${BASE}/${endpoint}/data.json?resource=${encodeURIComponent(resource)}&sourceapp=clearping`
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`RIPEstat answered ${response.status} for ${endpoint}`)
  const body = (await response.json()) as { data?: T; status?: string; messages?: [string, string][] }
  if (!body.data) throw new Error(body.messages?.map(([, text]) => text).join(' ') || `RIPEstat had nothing for ${resource}`)
  return body.data
}

export interface ResolvedResource {
  prefix: string
  /** What was asked for, when it was an address. */
  address: string | null
  origins: number[]
}

/**
 * The announced prefix to watch for what was given: a prefix is watched as it
 * is, and an address by the most specific announced prefix that holds it.
 */
export async function resolveResource(input: string): Promise<ResolvedResource> {
  const given = input.trim()
  if (isPrefix(given)) {
    const wide = tooWide(given)
    if (wide) throw new Error(wide)
    return { prefix: given, address: null, origins: [] }
  }
  if (!isAddress(given)) throw new Error('Give an IP address or a prefix, such as 203.0.113.10 or 203.0.113.0/24')
  const info = await ask<{ asns: string[]; prefix: string }>('network-info', given)
  if (!info.prefix) throw new Error(`No announced prefix holds ${given}: it is not reachable on the internet`)
  return { prefix: info.prefix, address: given, origins: info.asns.map(Number).filter(Number.isFinite) }
}

interface LookingGlassPeer {
  as_path: string
  prefix: string
  peer: string
  last_updated: string
}

/** RIPEstat's times are UTC without saying so. */
function utc(text: string): number {
  const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`)
  return Number.isFinite(at) ? at : Date.now()
}

/** Every collector peer's route to the prefix right now. */
export async function currentRoutes(prefix: string): Promise<BgpRoute[]> {
  const data = await ask<{ rrcs: { rrc: string; peers: LookingGlassPeer[] }[] }>('looking-glass', prefix, LOOKING_GLASS_TIMEOUT_MS)
  const routes: BgpRoute[] = []
  for (const collector of data.rrcs ?? []) {
    for (const peer of collector.peers ?? []) {
      const path = flattenPath(peer.as_path)
      if (path.length === 0) continue
      routes.push({
        collector: collectorName(collector.rrc),
        peer: peer.peer,
        peerAsn: path[0],
        prefix: peer.prefix,
        path,
        since: utc(peer.last_updated),
      })
    }
  }
  return routes
}

/** The name a network is registered under, shortened where RIPEstat repeats it. */
export async function asName(asn: number): Promise<string | null> {
  const data = await ask<{ holder?: string }>('as-overview', `AS${asn}`)
  const holder = data.holder?.trim()
  if (!holder) return null
  // "Example Networks Ltd - Example Networks Ltd" says it twice.
  const [first, second] = holder.split(' - ')
  return second && first.trim() === second.trim() ? first.trim() : holder
}

/** The country a network is registered in, by its registry's statistics: ZA. */
export async function asCountry(asn: number): Promise<string | null> {
  const data = await ask<{ located_resources?: { location?: string }[] }>('rir-stats-country', `AS${asn}`)
  const location = data.located_resources?.[0]?.location?.trim().toUpperCase()
  return location && /^[A-Z]{2}$/.test(location) ? location : null
}

/** The network that announces an address: for a traceroute's hop, whose network it is. */
export async function addressAsn(address: string): Promise<number | null> {
  const info = await ask<{ asns: string[] }>('network-info', address)
  const asn = Number(info.asns?.[0])
  return Number.isInteger(asn) && asn > 0 ? asn : null
}

export interface RelatedPrefix {
  prefix: string
  asn: number
  name: string | null
}

export interface ResourceLookup extends ResolvedResource {
  /** The networks announcing it, with their names. */
  announcedBy: { asn: number; name: string | null }[]
  /** Announced prefixes that hold it: a larger block it is part of. */
  within: RelatedPrefix[]
  /** Announced prefixes inside it. */
  inside: RelatedPrefix[]
}

/**
 * What watching an address or prefix would watch, before it is watched: the
 * announced prefix that holds it, who announces it, and the announced
 * prefixes around it, larger and smaller.
 */
export async function lookUpResource(input: string): Promise<ResourceLookup> {
  const resolved = await resolveResource(input)
  const related = await ask<{ prefixes?: { prefix: string; origin_asn: string; asn_name?: string; relationship: string }[] }>(
    'related-prefixes',
    resolved.prefix
  ).catch(() => ({ prefixes: [] }))
  const shaped = (relationship: RegExp) =>
    (related.prefixes ?? [])
      .filter(each => relationship.test(each.relationship))
      .map(each => ({ prefix: each.prefix, asn: Number(each.origin_asn), name: each.asn_name?.trim() || null }))
      .filter(each => Number.isInteger(each.asn))
  const origins = resolved.origins.length > 0 ? resolved.origins : (await resolveResource(resolved.prefix.split('/')[0]).catch(() => resolved)).origins
  const announcedBy = await Promise.all(origins.map(async asn => ({ asn, name: await asName(asn).catch(() => null) })))
  return { ...resolved, announcedBy, within: shaped(/less specific/i), inside: shaped(/more specific/i) }
}
