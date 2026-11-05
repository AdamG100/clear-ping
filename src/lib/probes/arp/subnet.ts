import type { NetworkInterfaceInfo } from 'os'

/**
 * Which of this machine's networks an IPv4 address is on.
 *
 * ARP does not cross a router: a request for an address on another network is
 * broadcast where nothing can answer it, and `arping` reports it as plain loss.
 * So the address is placed on one of this machine's own networks first, and a
 * probe of one that is on none of them says so instead of reading 100% loss.
 *
 * Pure: the interfaces are passed in (`os.networkInterfaces()`).
 */

export type LocalLink =
  | { ok: true; device: string; source: string }
  | { ok: false; error: string }

export const NOT_LOCAL =
  'Not on a local network of this machine: ARP does not cross a router. Probe it from a probe agent on that network. ' +
  'In Docker, that machine needs the host\'s network (network_mode: host).'

function toNumber(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null
    value = value * 256 + Number(part)
  }
  return value
}

function prefixLength(mask: number): number {
  return mask.toString(2).replace(/0/g, '').length
}

/**
 * The interface to send ARP from for `address`: the most specific of this
 * machine's IPv4 networks that holds it. Loopback is left out, and so is the
 * machine's own address, which nothing else answers ARP for.
 */
export function localLinkFor(address: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LocalLink {
  const target = toNumber(address)
  if (target === null) return { ok: false, error: `Not an IPv4 address: ${address}` }

  let best: { device: string; source: string; prefix: number } | null = null
  for (const [device, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const own = toNumber(entry.address)
      const mask = toNumber(entry.netmask)
      if (own === null || mask === null) continue
      if (own === target) return { ok: false, error: 'That is this machine\'s own address, which nothing else answers ARP for.' }
      // A /0 would hold every address there is: not a network ARP reaches.
      const prefix = prefixLength(mask)
      if (prefix === 0) continue
      // Unsigned, since a mask with its top bit set is negative as a signed 32-bit number.
      if (((own & mask) >>> 0) !== ((target & mask) >>> 0)) continue
      if (!best || prefix > best.prefix) best = { device, source: entry.address, prefix }
    }
  }
  return best ? { ok: true, device: best.device, source: best.source } : { ok: false, error: NOT_LOCAL }
}
