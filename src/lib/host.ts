import type { AddressFamily, IpVersion, ProbeIpVersion, ProbeType, TargetType } from '@/types/probe'

/**
 * What a target's address actually is.
 *
 * Everything that treats targets differently — which probe runs, which address
 * family it uses, which badge the sidebar shows — derives from this one
 * classification, so the server and the browser can never disagree about
 * whether "2606:4700:4700::1111" is an address or a name.
 *
 * Pure string work with no Node imports: the add-target dialog runs it on
 * every keystroke.
 */

export type HostKind = 'ipv4' | 'ipv6' | 'hostname' | 'invalid'

export type { AddressFamily }

const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/

/** A scope such as "%eth0" or "%12", needed to reach link-local addresses. */
const ZONE_PATTERN = /^[A-Za-z0-9._-]{1,32}$/

/**
 * Names we are willing to hand to a resolver or to `ping`: no whitespace, no
 * shell metacharacters, and nothing starting with `-`, which `ping` would read
 * as an option rather than a destination.
 */
const HOSTNAME_PATTERN = /^(?!-)[A-Za-z0-9._-]{1,253}$/

export function isIpv4(host: string): boolean {
  return IPV4_SHAPE.test(host) && host.split('.').every(part => Number(part) <= 255)
}

export function isIpv6(host: string): boolean {
  const [address, zone, ...extra] = host.split('%')
  if (extra.length > 0) return false
  if (zone !== undefined && !ZONE_PATTERN.test(zone)) return false
  if (!address.includes(':')) return false

  const halves = address.split('::')
  if (halves.length > 2) return false
  const compressed = halves.length === 2

  const groups = [
    ...(halves[0] ? halves[0].split(':') : []),
    ...(compressed && halves[1] ? halves[1].split(':') : []),
  ]
  let groupCount = groups.length

  // An embedded IPv4 tail ("::ffff:192.0.2.1") stands in for the last two groups.
  const last = groups[groups.length - 1]
  if (last !== undefined && last.includes('.')) {
    if (!isIpv4(last)) return false
    groups.pop()
    groupCount += 1
  }

  if (!groups.every(group => HEX_GROUP.test(group))) return false

  // "::" replaces at least one group, so a compressed address has at most seven.
  return compressed ? groupCount <= 7 : groupCount === 8
}

/**
 * Trim, and unwrap the URL-style brackets people paste IPv6 addresses in:
 * "[2001:db8::1]" is how a browser writes it, but `ping` wants it bare.
 */
export function normalizeHost(host: string): string {
  const trimmed = (host ?? '').trim()
  const bracketed = /^\[(.+)\]$/.exec(trimmed)
  return bracketed && isIpv6(bracketed[1]) ? bracketed[1] : trimmed
}

export function classifyHost(host: string): HostKind {
  const value = normalizeHost(host)

  if (isIpv4(value)) return 'ipv4'
  if (value.includes(':')) return isIpv6(value) ? 'ipv6' : 'invalid'
  // All digits and dots but not a valid IPv4 address ("999.1.1.1", "10.0.1"):
  // `ping` would reinterpret it as some other address rather than reject it.
  if (/^[\d.]+$/.test(value)) return 'invalid'

  return HOSTNAME_PATTERN.test(value) ? 'hostname' : 'invalid'
}

export function isValidHost(host: string): boolean {
  return classifyHost(host) !== 'invalid'
}

/**
 * The kinds of target the UI distinguishes. A target probed with anything but
 * a ping is named for its probe; for a ping, the address decides between `ip`
 * and `domain`.
 */
export function targetTypeFor(host: string, probeType: ProbeType): TargetType {
  if (probeType !== 'ping') return probeType
  return classifyHost(host) === 'hostname' ? 'domain' : 'ip'
}

/**
 * The address family a probe of this target is pinned to, or null when the
 * resolver chooses. A literal always wins over the setting: asking for IPv6 on
 * "8.8.8.8" cannot mean anything.
 */
export function addressFamilyFor(host: string, ipVersion: IpVersion = 'auto'): AddressFamily | null {
  const kind = classifyHost(host)
  if (kind === 'ipv4') return 4
  if (kind === 'ipv6') return 6
  if (ipVersion === 'ipv4') return 4
  if (ipVersion === 'ipv6') return 6
  return null
}

/**
 * Whether a target is probed over IPv4 and IPv6 side by side. Only a name can
 * be: an address belongs to one family, whatever the setting says.
 */
export function isDualStack(host: string, ipVersion: IpVersion = 'auto'): boolean {
  return ipVersion === 'both' && classifyHost(host) === 'hostname'
}

/**
 * The probes one round of measuring a target is made of: one, or one per
 * family for a dual-stack target. `family` is what the probe is pinned to, or
 * null where the resolver is left to choose.
 */
export function probeRuns(
  host: string,
  ipVersion: IpVersion = 'auto'
): Array<{ ipVersion: ProbeIpVersion; family: AddressFamily | null }> {
  if (isDualStack(host, ipVersion)) {
    return [
      { ipVersion: 'ipv4', family: 4 },
      { ipVersion: 'ipv6', family: 6 },
    ]
  }

  // `both` on an address means nothing more than the address already does.
  const single: ProbeIpVersion = ipVersion === 'both' ? 'auto' : ipVersion
  return [{ ipVersion: single, family: addressFamilyFor(host, single) }]
}

export const FAMILY_LABEL: Record<AddressFamily, string> = { 4: 'IPv4', 6: 'IPv6' }

export const IP_VERSIONS: readonly IpVersion[] = ['auto', 'ipv4', 'ipv6', 'both']

export function isIpVersion(value: unknown): value is IpVersion {
  return IP_VERSIONS.includes(value as IpVersion)
}

/**
 * Public recursive resolvers. Typing one of these into the add-target dialog
 * almost always means "watch this DNS service", so the dialog suggests a DNS
 * probe for them instead of a ping.
 */
const WELL_KNOWN_RESOLVERS = new Set([
  '1.1.1.1', '1.0.0.1', '2606:4700:4700::1111', '2606:4700:4700::1001',
  '8.8.8.8', '8.8.4.4', '2001:4860:4860::8888', '2001:4860:4860::8844',
  '9.9.9.9', '149.112.112.112', '2620:fe::fe', '2620:fe::9',
  '208.67.222.222', '208.67.220.220', '2620:119:35::35', '2620:119:53::53',
])

export function isWellKnownResolver(host: string): boolean {
  return WELL_KNOWN_RESOLVERS.has(normalizeHost(host).toLowerCase())
}

/**
 * Whether an address is inside a private network: the router, a switch, a
 * server down the hall. A report that has one of these in it can tell a fault
 * in the building from a fault beyond it, and one that has none cannot.
 */
export function isPrivateAddress(address: string): boolean {
  const kind = classifyHost(address)
  if (kind === 'ipv4') {
    const [a, b] = address.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (kind === 'ipv6') {
    const lower = address.toLowerCase()
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
  }
  return false
}

/** Names that only mean anything on the network they are used on. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.internal', '.home.arpa', '.test']

/**
 * Whether what a client connected to, as it wrote it (`host`, `host:port`,
 * `[v6]:port`), is somewhere on its own network and not out across the
 * internet: this machine, a private address, a name with no dots in it or one
 * that ends the way only local names do.
 *
 * Carrier-grade addresses (100.64.0.0/10) count as well. They are not
 * reachable from the internet either, and are what an overlay network such as
 * Tailscale hands out, which encrypts what crosses it.
 */
export function isLocalHost(hostWithPort: string): boolean {
  const written = hostWithPort.trim().toLowerCase()
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(written)
  // Colons more than once and no brackets is a bare IPv6 address, which has no port on it.
  const host = bracketed ? bracketed[1] : written.split(':').length > 2 ? written : written.replace(/:\d+$/, '')

  const kind = classifyHost(host)
  if (kind === 'invalid') return false
  if (kind === 'hostname') {
    return host === 'localhost' || !host.includes('.') || LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix))
  }
  if (isPrivateAddress(host)) return true

  if (kind === 'ipv4') {
    const [a, b] = host.split('.').map(Number)
    return a === 100 && b >= 64 && b <= 127
  }
  return false
}
