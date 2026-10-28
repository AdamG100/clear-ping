/**
 * IP prefixes: reading them, and whether one holds an address or another
 * prefix. IPv4 and IPv6 alike. Pure: the routing pages use it too.
 */

/** BigInt(0): the build targets a version of JavaScript without `0n`. */
const ZERO = BigInt(0)

interface Parsed {
  version: 4 | 6
  /** The address as a number, its host bits cleared. */
  network: bigint
  length: number
}

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = ZERO
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << BigInt(8)) | BigInt(octet)
  }
  return value
}

function parseIpv6(text: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(text)) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (half: string) => (half ? half.split(':') : [])
  let head = groups(halves[0])
  let tail = halves.length === 2 ? groups(halves[1]) : []
  // An IPv4 address at the end is the last two groups.
  const last = (tail.length ? tail : head).at(-1)
  if (last?.includes('.')) {
    const v4 = parseIpv4(last)
    if (v4 === null) return null
    const pair = [(v4 >> BigInt(16)).toString(16), (v4 & BigInt(0xffff)).toString(16)]
    if (tail.length) tail = [...tail.slice(0, -1), ...pair]
    else head = [...head.slice(0, -1), ...pair]
  }
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  let value = ZERO
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    value = (value << BigInt(16)) | BigInt(parseInt(group, 16))
  }
  return value
}

function parseAddress(text: string): { version: 4 | 6; value: bigint } | null {
  const trimmed = text.trim()
  const v4 = parseIpv4(trimmed)
  if (v4 !== null) return { version: 4, value: v4 }
  const v6 = parseIpv6(trimmed)
  if (v6 !== null) return { version: 6, value: v6 }
  return null
}

function bits(version: 4 | 6): number {
  return version === 4 ? 32 : 128
}

function parsePrefix(text: string): Parsed | null {
  const [address, length, ...rest] = text.trim().split('/')
  if (rest.length > 0 || length === undefined || !/^\d{1,3}$/.test(length)) return null
  const parsed = parseAddress(address)
  if (!parsed) return null
  const size = Number(length)
  const width = bits(parsed.version)
  if (size > width) return null
  const host = width - size
  return { version: parsed.version, network: (parsed.value >> BigInt(host)) << BigInt(host), length: size }
}

export function isAddress(text: string): boolean {
  return parseAddress(text) !== null
}

/** The same address however it is written: 2001:DB8::1 and 2001:db8:0::1 alike. Null for anything that is not an address. */
export function addressKey(text: string): string | null {
  const parsed = parseAddress(text)
  return parsed ? `${parsed.version}:${parsed.value.toString(16)}` : null
}

/**
 * The /16 (IPv4) or /32 (IPv6) an address or prefix starts with, as a key:
 * for finding which of many prefixes holds an address without trying each.
 * Null for a prefix wider than that, or anything else.
 */
export function blockKey(text: string): string | null {
  const parsed = text.includes('/') ? parsePrefix(text) : parseAddress(text)
  if (!parsed) return null
  const value = 'network' in parsed ? parsed.network : parsed.value
  const block = parsed.version === 4 ? 16 : 32
  if ('length' in parsed && parsed.length < block) return null
  return `${parsed.version}:${(value >> BigInt(bits(parsed.version) - block)).toString(16)}`
}

export function isPrefix(text: string): boolean {
  return parsePrefix(text) !== null
}

/** Whether `inner` is `outer` itself or a more-specific of it. */
export function prefixWithin(inner: string, outer: string): boolean {
  const a = parsePrefix(inner)
  const b = parsePrefix(outer)
  if (!a || !b || a.version !== b.version || a.length < b.length) return false
  const host = BigInt(bits(b.version) - b.length)
  return a.network >> host === b.network >> host
}

/** Whether an address falls inside a prefix. */
export function addressIn(address: string, prefix: string): boolean {
  const parsed = parseAddress(address)
  if (!parsed) return false
  return prefixWithin(`${address.trim()}/${bits(parsed.version)}`, prefix)
}

/** How long a prefix is: 24 for a /24. */
export function prefixLength(prefix: string): number {
  return parsePrefix(prefix)?.length ?? 0
}

/**
 * The widest prefix that can be watched, by version. Nothing wider is
 * announced, and as its more-specifics are followed too, watching 0.0.0.0/0
 * or a /4 would take in a good share of the internet's updates.
 */
export const WIDEST_PREFIX = { 4: 8, 6: 16 } as const

/** Why a prefix is too wide to watch, or null if it is not. */
export function tooWide(prefix: string): string | null {
  const parsed = parsePrefix(prefix)
  if (!parsed || parsed.length >= WIDEST_PREFIX[parsed.version]) return null
  return `${prefix} is wider than any network announces: watch a /${WIDEST_PREFIX[parsed.version]} or longer`
}

/** Addresses that are not on the internet: private, shared (CGNAT), loopback, link-local, documentation. */
const NOT_PUBLIC = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/3',
  '::/8',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
]

/** Whether an address is one on the internet, which a network announces. */
export function isPublicAddress(address: string): boolean {
  return isAddress(address) && !NOT_PUBLIC.some(range => addressIn(address, range))
}

/** The first address in a prefix after its network address: somewhere in it to trace to. */
export function firstHost(prefix: string): string | null {
  const parsed = parsePrefix(prefix)
  if (!parsed) return null
  const host = parsed.length >= bits(parsed.version) - 1 ? parsed.network : parsed.network + BigInt(1)
  if (parsed.version === 4) {
    return [24, 16, 8, 0].map(shift => Number((host >> BigInt(shift)) & BigInt(255))).join('.')
  }
  const groups: string[] = []
  for (let shift = 112; shift >= 0; shift -= 16) groups.push(((host >> BigInt(shift)) & BigInt(0xffff)).toString(16))
  return groups.join(':')
}
