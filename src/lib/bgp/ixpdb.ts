import { addressKey } from './prefix'
import { IXPDB_KEY, readExchangeCopy, saveExchangeCopy } from './store'

/**
 * IXPDB (ixpdb.euro-ix.net), Euro-IX's database of internet exchanges, built
 * from the exchanges' own member lists (their IX-F exports) rather than from
 * what each network says of itself, as PeeringDB is. One of its lists, read
 * without a key: every member network, with each address it has on an
 * exchange.
 *
 * Those addresses say which network a traceroute hop on an exchange's LAN
 * belongs to: the member whose router answered, where the traffic went next.
 * Matched to PeeringDB's LANs, they also say which exchanges a network is on
 * where PeeringDB does not, for the "probably crosses" guesses.
 *
 * Read once a day, three or four megabytes, with a copy kept in the database
 * as PeeringDB's is.
 */

export interface IxpdbData {
  /** Each address a member has on an exchange, by addressKey, and the member's AS number. */
  ports: Record<string, number>
}

const IXPDB = 'https://api.ixpdb.net/v1'
const REFRESH_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 60 * 60 * 1000
const TIMEOUT_MS = 60_000

let held: { at: number; data: IxpdbData | null } | null = null
let reading: Promise<IxpdbData | null> | null = null

async function ask<T>(path: string): Promise<T[]> {
  const response = await fetch(`${IXPDB}/${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'ClearPing (BGP monitoring)' },
  })
  if (!response.ok) throw new Error(`IXPDB answered ${response.status} for ${path}`)
  const body: unknown = await response.json()
  return Array.isArray(body) ? (body as T[]) : []
}

/** IXPDB's members as ClearPing keeps them. Pure, for the tests. */
export function readIxpdb(
  participants: readonly { asn?: number; ip_addresses?: (string | null)[] | null }[]
): IxpdbData {
  const ports: Record<string, number> = {}
  for (const { asn, ip_addresses } of participants) {
    if (!Number.isInteger(asn) || !asn || asn <= 0) continue
    for (const address of ip_addresses ?? []) {
      const key = address ? addressKey(address) : null
      if (key) ports[key] = asn
    }
  }
  return { ports }
}

/** IXPDB's members' addresses on the exchanges, or null when it could not be read and no copy is kept. */
export async function ixpdbData(now = Date.now()): Promise<IxpdbData | null> {
  if (held && now - held.at < (held.data ? REFRESH_MS : RETRY_MS)) return held.data
  reading ??= (async () => {
    const kept = held?.data ? null : await readExchangeCopy<IxpdbData>(IXPDB_KEY).catch(() => null)
    const copy = kept?.lans && typeof kept.lans.ports === 'object' ? { at: kept.at, data: kept.lans } : null
    if (copy && now - copy.at < REFRESH_MS) {
      held = copy
      return copy.data
    }
    try {
      const data = readIxpdb(await ask<{ asn?: number; ip_addresses?: (string | null)[] | null }>('participant/list'))
      held = { at: Date.now(), data }
      await saveExchangeCopy(held.at, data, IXPDB_KEY).catch(() => {})
      return data
    } catch (error) {
      console.warn('[BGP] Could not read IXPDB:', error instanceof Error ? error.message : error)
      held = { at: Date.now(), data: held?.data ?? copy?.data ?? null }
      if (held.data) held.at = now - REFRESH_MS + RETRY_MS
      return held.data
    }
  })().finally(() => {
    reading = null
  })
  return reading
}
