import type { BgpCrossing, BgpExchange } from '@/types/bgp'
import { addressIn, prefixLength } from './prefix'
import { readExchangeCopy, saveExchangeCopy } from './store'

/**
 * Internet exchanges and their peering LANs, from PeeringDB: a traceroute hop
 * on an exchange's LAN is where the traffic crossed that exchange. BGP cannot
 * say which exchange carries a route (the route servers stay out of the
 * path), but the traceroute can: JINX and NAPAfrica Johannesburg have LANs of
 * their own.
 *
 * Read once a day: three requests, a few hundred kilobytes. Held in memory,
 * and a copy kept in the database, so a restart uses that rather than asking
 * again (PeeringDB turns away those who ask too often), and a failed read
 * falls back on it however old it is.
 */

export interface ExchangeLan {
  prefix: string
  exchange: BgpExchange
}

const PEERINGDB = 'https://www.peeringdb.com/api'
const REFRESH_MS = 24 * 60 * 60 * 1000
/** After a failed read, how long before trying again. */
const RETRY_MS = 60 * 60 * 1000
const TIMEOUT_MS = 30_000

let held: { at: number; lans: ExchangeLan[] | null } | null = null
let reading: Promise<ExchangeLan[] | null> | null = null
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

async function read(): Promise<ExchangeLan[]> {
  const [prefixes, lans, exchanges] = await Promise.all([
    ask<{ prefix: string; ixlan_id: number }>('ixpfx?fields=prefix,ixlan_id'),
    ask<{ id: number; ix_id: number }>('ixlan?fields=id,ix_id'),
    ask<{ id: number; name: string; city: string; country: string }>('ix?fields=id,name,city,country'),
  ])
  const exchangeOfLan = new Map(lans.map(lan => [lan.id, lan.ix_id]))
  const byId = new Map(exchanges.map(ix => [ix.id, { name: ix.name, city: ix.city, country: ix.country }]))
  return prefixes.flatMap(each => {
    const exchange = byId.get(exchangeOfLan.get(each.ixlan_id) ?? -1)
    return exchange ? [{ prefix: each.prefix, exchange }] : []
  })
}

/** Every exchange's peering LANs, or null when PeeringDB could not be read and no copy is kept. */
export async function exchangeLans(now = Date.now()): Promise<ExchangeLan[] | null> {
  const newKey = failedWith !== null && failedWith !== apiKey()
  if (held && !newKey && now - held.at < (held.lans ? REFRESH_MS : RETRY_MS)) return held.lans
  reading ??= (async () => {
    const copy = held?.lans ? null : await readExchangeCopy<ExchangeLan[]>().catch(() => null)
    if (copy && !newKey && now - copy.at < REFRESH_MS) {
      held = copy
      return copy.lans
    }
    try {
      const lans = await read()
      held = { at: Date.now(), lans }
      failedWith = null
      await saveExchangeCopy(held.at, lans).catch(() => {})
      return lans
    } catch (error) {
      console.warn('[BGP] Could not read the exchanges from PeeringDB:', error instanceof Error ? error.message : error)
      // What was read before, however old, until the next try in a while.
      failedWith = apiKey()
      held = { at: Date.now(), lans: held?.lans ?? copy?.lans ?? null }
      if (held.lans) held.at = now - REFRESH_MS + RETRY_MS
      return held.lans
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

/** The first exchange a traceroute crossed, by its hops' addresses. */
export function crossingOf(hops: readonly { hop: number; address: string | null }[], lans: readonly ExchangeLan[]): BgpCrossing | null {
  for (const hop of hops) {
    if (!hop.address) continue
    const lan = exchangeOf(hop.address, lans)
    if (lan) return { ...lan.exchange, address: hop.address, hop: hop.hop }
  }
  return null
}
