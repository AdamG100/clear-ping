import { lookup } from 'dns/promises'
import type { AddressFamily, ProbeIpVersion } from '@/types/probe'

/**
 * Name resolution for domain targets.
 *
 * A domain is resolved once per probe and every packet of that probe goes to
 * the one address it returned. Handing the name to `ping` instead resolves it
 * again for each packet, so a name with several records (any CDN) spreads one
 * probe across different servers and reports the difference between them as
 * jitter on a path that has none.
 *
 * Resolving here also keeps two failures apart that `ping` reports the same
 * way: "the name does not resolve" and "the address does not answer".
 */

export type ResolvedAddress = { address: string; family: AddressFamily }

export type ResolveOutcome =
  /** `addresses` is everything the name resolved to; `address` is the one to use. */
  | ({ ok: true; addresses: string[] } & ResolvedAddress)
  | { ok: false; error: string }

type LookupFn = (
  hostname: string,
  options: { all: true; family: 0 | 4 | 6; order: 'verbatim' }
) => Promise<Array<{ address: string; family: number }>>

interface ResolveOptions {
  timeoutMs?: number
  /** Injected in tests so no real resolver is consulted. */
  lookupFn?: LookupFn
}

const FAMILY_FOR: Record<ProbeIpVersion, 0 | 4 | 6> = { auto: 0, ipv4: 4, ipv6: 6 }

const RECORD_NAME: Record<AddressFamily, string> = { 4: 'IPv4 address (A record)', 6: 'IPv6 address (AAAA record)' }

/**
 * Resolve `hostname` to the single address a probe should measure.
 *
 * Uses the system resolver (`getaddrinfo`) rather than querying DNS directly,
 * so the hosts file, search domains and mDNS names behave exactly as they do
 * for every other program on the machine. With `auto` the family is the one
 * the system prefers, going by the first address it lists.
 *
 * Within that family the address is chosen the same way every time, not taken
 * from the top of the list. A name served round-robin comes back in a new
 * order from one lookup to the next, and taking the first address moved the
 * probe between servers, on other continents for some names: a chart of that
 * shows the distance between servers as latency swinging on a path that is
 * steady. Chosen this way the probe stays on one server for as long as the
 * name's records stay the same, and moves only when they change.
 */
export async function resolveHost(
  hostname: string,
  ipVersion: ProbeIpVersion = 'auto',
  { timeoutMs = 5000, lookupFn = lookup as LookupFn }: ResolveOptions = {}
): Promise<ResolveOutcome> {
  const family = FAMILY_FOR[ipVersion]
  let timer: NodeJS.Timeout | undefined

  try {
    // `lookup` has no timeout of its own, and a dead resolver can hold it for
    // far longer than the probe is allowed to take.
    const addresses = await Promise.race([
      lookupFn(hostname, { all: true, family, order: 'verbatim' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
      }),
    ])

    const usable = addresses.filter(entry => entry.family === 4 || entry.family === 6)
    if (usable.length === 0) {
      return { ok: false, error: noAddressMessage(hostname, family) }
    }
    const preferred = usable[0].family as AddressFamily
    const address = steadyChoice(usable.filter(entry => entry.family === preferred).map(entry => entry.address))
    return {
      ok: true,
      address,
      family: preferred,
      addresses: usable.map(entry => entry.address),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A name that exists but has no record of the requested family comes back
    // as ENOTFOUND or ENODATA depending on the platform; say which family was
    // missing rather than implying the whole name is gone.
    if (family !== 0 && (code === 'ENOTFOUND' || code === 'ENODATA')) {
      return { ok: false, error: noAddressMessage(hostname, family) }
    }
    const reason = code ?? (error instanceof Error ? error.message : 'unknown error')
    return { ok: false, error: `DNS resolution failed for ${hostname} (${reason})` }
  } finally {
    clearTimeout(timer)
  }
}

/** The same one of a set of addresses whatever order they arrive in. */
function steadyChoice(addresses: string[]): string {
  return addresses.reduce((chosen, address) => (address < chosen ? address : chosen))
}

function noAddressMessage(hostname: string, family: 0 | 4 | 6): string {
  return family === 0
    ? `DNS resolution failed for ${hostname} (no addresses)`
    : `DNS resolution failed: no ${RECORD_NAME[family]} for ${hostname}`
}
