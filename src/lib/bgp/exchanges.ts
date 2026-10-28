import type { BgpCrossing, BgpExchange } from '@/types/bgp'
import { ixpdbData, type IxpdbData } from './ixpdb'
import { addressIn, addressKey, blockKey, prefixLength } from './prefix'
import { readExchangeCopy, saveExchangeCopy } from './store'

/**
 * Internet exchanges, their peering LANs and their members, from PeeringDB,
 * with IXPDB's members' addresses on the exchanges (see ixpdb.ts) beside them.
 *
 * A traceroute hop on an exchange's LAN is where the traffic crossed that
 * exchange. BGP cannot say which exchange carries a route (the route servers
 * stay out of the path), but the traceroute can: JINX and NAPAfrica
 * Johannesburg have LANs of their own. Many routers answer a traceroute from
 * another of their addresses, though, so a crossing can leave no hop on the
 * LAN; then the members say where it probably crossed: where the trace passes
 * from one network to the next, an exchange both are members of.
 *
 * Read once a day: four requests, a megabyte or two. Held in memory, and a
 * copy kept in the database, so a restart uses that rather than asking again
 * (PeeringDB turns away those who ask too often), and a failed read falls
 * back on it however old it is.
 */

export interface ExchangeLan {
  prefix: string
  exchange: BgpExchange
}

export interface ExchangeData {
  lans: ExchangeLan[]
  /** Every exchange, by its place in this list. */
  exchanges: BgpExchange[]
  /** Each network's exchanges, as places in `exchanges`, by its AS number. */
  members: Record<string, number[]>
  /** The member each address on an exchange belongs to, by addressKey, from IXPDB. Empty without it. */
  ports: Record<string, number>
}

const PEERINGDB = 'https://www.peeringdb.com/api'
const REFRESH_MS = 24 * 60 * 60 * 1000
/** After a failed read, how long before trying again. */
const RETRY_MS = 60 * 60 * 1000
const TIMEOUT_MS = 30_000

type PeeringDbData = Omit<ExchangeData, 'ports'>

let held: { at: number; data: PeeringDbData | null } | null = null
let reading: Promise<PeeringDbData | null> | null = null
/** The two put together, for as long as neither changes. */
let joined: { peeringDb: PeeringDbData | null; ixpdb: IxpdbData | null; data: ExchangeData | null } | null = null
/** The key a read failed with: a key set or changed since is tried at once, not after the wait. */
let failedWith: string | undefined | null = null

function apiKey(): string | undefined {
  return process.env.CLEARPING_PEERINGDB_API_KEY?.trim() || undefined
}

async function ask<T>(path: string): Promise<T[]> {
  // A key lifts PeeringDB's throttling of anonymous reads of whole tables.
  const key = apiKey()
  const response = await fetch(`${PEERINGDB}/${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: 'application/json',
      'user-agent': 'ClearPing (BGP monitoring)',
      ...(key ? { authorization: `Api-Key ${key}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`PeeringDB answered ${response.status} for ${path}`)
  const body = (await response.json()) as { data?: T[] }
  return body.data ?? []
}

async function read(): Promise<Omit<ExchangeData, 'ports'>> {
  const [prefixes, lans, exchanges, memberships] = await Promise.all([
    ask<{ prefix: string; ixlan_id: number }>('ixpfx?fields=prefix,ixlan_id'),
    ask<{ id: number; ix_id: number }>('ixlan?fields=id,ix_id'),
    ask<{ id: number; name: string; city: string; country: string }>('ix?fields=id,name,city,country'),
    ask<{ asn: number; ix_id: number }>('netixlan?fields=asn,ix_id'),
  ])
  const list = exchanges.map(ix => ({ name: ix.name, city: ix.city, country: ix.country }))
  const placeOf = new Map(exchanges.map((ix, index) => [ix.id, index]))
  const exchangeOfLan = new Map(lans.map(lan => [lan.id, lan.ix_id]))
  const members: Record<string, number[]> = {}
  for (const { asn, ix_id } of memberships) {
    const place = placeOf.get(ix_id)
    if (place === undefined) continue
    const held = (members[asn] ??= [])
    if (!held.includes(place)) held.push(place)
  }
  return {
    lans: prefixes.flatMap(each => {
      const place = placeOf.get(exchangeOfLan.get(each.ixlan_id) ?? -1)
      return place !== undefined ? [{ prefix: each.prefix, exchange: list[place] }] : []
    }),
    exchanges: list,
    members,
  }
}

/** A copy kept before the members were read: its LANs still serve, but it is read again at once. */
function fromCopy(copy: { at: number; lans: unknown }): { at: number; data: PeeringDbData } | null {
  if (Array.isArray(copy.lans)) return { at: 0, data: { lans: copy.lans as ExchangeLan[], exchanges: [], members: {} } }
  const data = copy.lans as PeeringDbData | null
  return data && Array.isArray(data.lans) ? { at: copy.at, data } : null
}

/**
 * PeeringDB's exchanges with IXPDB's members' addresses: each address put on
 * the exchange whose LAN holds it, and its member counted as on that exchange
 * where PeeringDB did not say so. With no PeeringDB, the addresses alone,
 * which still say whose a hop is. Pure, for the tests.
 */
export function joinExchanges(peeringDb: PeeringDbData | null, ixpdb: IxpdbData | null): ExchangeData | null {
  if (!peeringDb) return ixpdb ? { lans: [], exchanges: [], members: {}, ports: ixpdb.ports } : null
  if (!ixpdb) return { ...peeringDb, ports: {} }
  const placeOf = new Map(peeringDb.exchanges.map((exchange, index) => [exchange, index]))
  // The LANs by the /16 or /32 they start in, so each of tens of thousands of
  // addresses is tried against a few LANs rather than every one.
  const byBlock = new Map<string, ExchangeLan[]>()
  const wide: ExchangeLan[] = []
  for (const lan of peeringDb.lans) {
    const key = blockKey(lan.prefix)
    if (key) byBlock.set(key, [...(byBlock.get(key) ?? []), lan])
    else wide.push(lan)
  }
  const members: Record<string, number[]> = Object.fromEntries(Object.entries(peeringDb.members).map(([asn, places]) => [asn, [...places]]))
  for (const [key, asn] of Object.entries(ixpdb.ports)) {
    const address = addressFromKey(key)
    const block = address ? blockKey(address) : null
    if (!address || !block) continue
    const lan = exchangeOf(address, [...(byBlock.get(block) ?? []), ...wide])
    const place = lan ? placeOf.get(lan.exchange) : undefined
    if (place === undefined) continue
    const held = (members[asn] ??= [])
    if (!held.includes(place)) held.push(place)
  }
  return { ...peeringDb, members, ports: ixpdb.ports }
}

/** An address back from its addressKey. */
function addressFromKey(key: string): string | null {
  const [version, hex] = key.split(':')
  if (!hex) return null
  const value = BigInt(`0x${hex}`)
  if (version === '4') return [24, 16, 8, 0].map(shift => Number((value >> BigInt(shift)) & BigInt(255))).join('.')
  const groups: string[] = []
  for (let shift = 112; shift >= 0; shift -= 16) groups.push(((value >> BigInt(shift)) & BigInt(0xffff)).toString(16))
  return groups.join(':')
}

/** The exchanges, their LANs and their members, or null when neither PeeringDB nor IXPDB could be read and no copy is kept. */
export async function exchangeData(now = Date.now()): Promise<ExchangeData | null> {
  const [peeringDb, ixpdb] = await Promise.all([peeringDbData(now), ixpdbData(now).catch(() => null)])
  if (joined?.peeringDb !== peeringDb || joined.ixpdb !== ixpdb) joined = { peeringDb, ixpdb, data: joinExchanges(peeringDb, ixpdb) }
  return joined.data
}

/** PeeringDB's exchanges, their LANs and their members, or null when it could not be read and no copy is kept. */
async function peeringDbData(now: number): Promise<PeeringDbData | null> {
  const newKey = failedWith !== null && failedWith !== apiKey()
  if (held && !newKey && now - held.at < (held.data ? REFRESH_MS : RETRY_MS)) return held.data
  reading ??= (async () => {
    const kept = held?.data ? null : await readExchangeCopy<unknown>().catch(() => null)
    const copy = kept ? fromCopy(kept) : null
    if (copy && !newKey && now - copy.at < REFRESH_MS) {
      held = copy
      return copy.data
    }
    try {
      const data = await read()
      held = { at: Date.now(), data }
      failedWith = null
      await saveExchangeCopy(held.at, data).catch(() => {})
      return data
    } catch (error) {
      console.warn('[BGP] Could not read the exchanges from PeeringDB:', error instanceof Error ? error.message : error)
      // What was read before, however old, until the next try in a while.
      failedWith = apiKey()
      held = { at: Date.now(), data: held?.data ?? copy?.data ?? null }
      if (held.data) held.at = now - REFRESH_MS + RETRY_MS
      return held.data
    }
  })().finally(() => {
    reading = null
  })
  return reading
}


/** The exchange whose peering LAN holds the address, the most specific LAN if more than one does. */
export function exchangeOf(address: string, lans: readonly ExchangeLan[]): ExchangeLan | null {
  let best: ExchangeLan | null = null
  for (const lan of lans) {
    if (addressIn(address, lan.prefix) && (!best || prefixLength(lan.prefix) > prefixLength(best.prefix))) best = lan
  }
  return best
}

/** The member an address on an exchange belongs to, by IXPDB: the network whose router answered there. */
export function memberOf(address: string | null, ports: Readonly<Record<string, number>>): number | null {
  const key = address ? addressKey(address) : null
  return key ? (ports[key] ?? null) : null
}

/** The first exchange a traceroute crossed, by its hops' addresses, and whose router it reached there. */
export function crossingOf(
  hops: readonly { hop: number; address: string | null }[],
  lans: readonly ExchangeLan[],
  ports: Readonly<Record<string, number>> = {}
): BgpCrossing | null {
  for (const hop of hops) {
    if (!hop.address) continue
    const lan = exchangeOf(hop.address, lans)
    if (lan) return { ...lan.exchange, address: hop.address, hop: hop.hop, member: memberOf(hop.address, ports) }
  }
  return null
}

/** The exchanges two networks are both members of, by PeeringDB. */
export function sharedExchanges(a: number, b: number, data: Pick<ExchangeData, 'exchanges' | 'members'>): BgpExchange[] {
  const theirs = new Set(data.members[b] ?? [])
  return (data.members[a] ?? []).filter(place => theirs.has(place)).map(place => data.exchanges[place])
}

/**
 * Where a trace with no hop on an exchange's LAN probably crossed one: the
 * first place it passes from one network to the next where the two are
 * members of an exchange together. Hops whose network is not known are passed
 * over. Probably, as two members may also be joined by a private link.
 */
export function likelyCrossing(
  hops: readonly { hop: number; asn: number | null }[],
  data: Pick<ExchangeData, 'exchanges' | 'members'>
): { exchanges: BgpExchange[]; from: number; to: number; hop: number } | null {
  let previous: number | null = null
  for (const each of hops) {
    if (each.asn === null) continue
    if (previous !== null && each.asn !== previous) {
      const shared = sharedExchanges(previous, each.asn, data)
      if (shared.length > 0) return { exchanges: shared, from: previous, to: each.asn, hop: each.hop }
    }
    previous = each.asn
  }
  return null
}
