import type { DnsProtocol, DnsResolver, DnsResolverReading } from '@/types/probe'
import { classifyHost, isIpv6, normalizeHost } from '../host'

/**
 * The resolvers a DNS target's name can be looked up through.
 *
 * One name looks different depending on who is asked: a record changed an hour
 * ago has reached one resolver and not another, a blocklist answers for one
 * and not the rest, a resolver that is slow tonight is slow for everything
 * behind it. A target that asks several of them on each probe shows that side
 * by side, and each can be asked over plain DNS, over TLS or over HTTPS.
 *
 * Pure, with no Node imports: the add-target dialog runs this as you type.
 */

export const DNS_PROTOCOLS: readonly DnsProtocol[] = ['system', 'udp', 'dot', 'doh']

export const DNS_PROTOCOL_LABEL: Record<DnsProtocol, string> = {
  system: 'System',
  udp: 'DNS',
  dot: 'DoT',
  doh: 'DoH',
}

/** The protocol's name in full, where there is room to say what it is. */
export const DNS_PROTOCOL_NAME: Record<DnsProtocol, string> = {
  system: 'This machine’s own resolver',
  udp: 'Plain DNS (UDP)',
  dot: 'DNS over TLS',
  doh: 'DNS over HTTPS',
}

/** A list long enough to compare anyone's choices, short enough to read as lines on one chart. */
export const MAX_DNS_RESOLVERS = 8

/** A resolver's own name goes on a chart's legend and in a table's first column. */
export const MAX_RESOLVER_NAME_LENGTH = 40

const DEFAULT_DOT_PORT = 853
const DEFAULT_DOH_PATH = '/dns-query'

/** A public resolver, and where it is reached over each protocol. */
export interface DnsProvider {
  id: string
  name: string
  udp: string
  dot: string
  doh: string
}

export const DNS_PROVIDERS: readonly DnsProvider[] = [
  { id: 'cloudflare', name: 'Cloudflare', udp: '1.1.1.1', dot: 'one.one.one.one', doh: 'https://cloudflare-dns.com/dns-query' },
  { id: 'google', name: 'Google', udp: '8.8.8.8', dot: 'dns.google', doh: 'https://dns.google/dns-query' },
  { id: 'quad9', name: 'Quad9', udp: '9.9.9.9', dot: 'dns.quad9.net', doh: 'https://dns.quad9.net/dns-query' },
  { id: 'opendns', name: 'OpenDNS', udp: '208.67.222.222', dot: 'dns.opendns.com', doh: 'https://doh.opendns.com/dns-query' },
  { id: 'adguard', name: 'AdGuard', udp: '94.140.14.14', dot: 'dns.adguard-dns.com', doh: 'https://dns.adguard-dns.com/dns-query' },
]

/** The provider a resolver is one of, if it is at an address the list knows. */
export function providerOf(resolver: DnsResolver): DnsProvider | null {
  if (resolver.protocol === 'system' || !resolver.server) return null
  const { protocol, server } = resolver
  return DNS_PROVIDERS.find(provider => provider[protocol] === server) ?? null
}

/** A provider's resolver over one protocol. */
export function providerResolver(provider: DnsProvider, protocol: Exclude<DnsProtocol, 'system'>): DnsResolver {
  return { protocol, server: provider[protocol] }
}

/** A host and port as they are written together. */
function hostWithPort(host: string, port: number, defaultPort: number): string {
  if (port === defaultPort) return host
  return `${isIpv6(host) ? `[${host}]` : host}:${port}`
}

/** Where a DNS-over-TLS resolver is: its host, and the port if it is not the usual one. */
export function parseDotServer(server: string): { host: string; port: number } | null {
  const trimmed = server.trim().replace(/^tls:\/\//i, '')

  const bracketed = /^\[(.+)\]:(\d{1,5})$/.exec(trimmed)
  const plain = /^([^:\s]+):(\d{1,5})$/.exec(trimmed)
  const match = bracketed ?? plain

  const host = normalizeHost(match ? match[1] : trimmed)
  const port = match ? Number(match[2]) : DEFAULT_DOT_PORT

  if (classifyHost(host) === 'invalid' || port < 1 || port > 65535) return null
  return { host, port }
}

/** The address a DNS-over-HTTPS resolver is queried at, from what was typed for it. */
export function parseDohServer(server: string): URL | null {
  const trimmed = server.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  // Some other kind of address altogether, which putting https:// in front of
  // would turn into a host called "ftp".
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null

  try {
    // A bare name is the usual way these are quoted: `dns.google`.
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (classifyHost(url.hostname) === 'invalid') return null
    // The path every one of them serves it at, when none was given.
    if (url.pathname === '/' || url.pathname === '') url.pathname = DEFAULT_DOH_PATH
    url.hash = ''
    return url
  } catch {
    return null
  }
}

export type ResolverValidation = { ok: true; resolver: DnsResolver } | { ok: false; error: string }

/** Check one resolver, and write its address the one way it is stored. */
export function validateResolver(raw: unknown): ResolverValidation {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const protocol = input.protocol
  const server = typeof input.server === 'string' ? input.server.trim() : ''

  if (!DNS_PROTOCOLS.includes(protocol as DnsProtocol)) {
    return { ok: false, error: `A resolver's protocol must be one of: ${DNS_PROTOCOLS.join(', ')}` }
  }

  // Kept only when there is one: a resolver nobody named is called by its
  // provider or by where it is.
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length > MAX_RESOLVER_NAME_LENGTH) {
    return { ok: false, error: `A resolver's name must be ${MAX_RESOLVER_NAME_LENGTH} characters or fewer` }
  }
  const named = name ? { name } : {}

  switch (protocol as DnsProtocol) {
    case 'system':
      return { ok: true, resolver: { protocol: 'system' } }

    case 'udp': {
      const host = normalizeHost(server)
      const kind = classifyHost(host)
      if (kind !== 'ipv4' && kind !== 'ipv6') {
        return { ok: false, error: server ? `${server} is not an IP address: a plain DNS resolver is given by its address` : 'Give the resolver’s IP address' }
      }
      return { ok: true, resolver: { protocol: 'udp', server: host, ...named } }
    }

    case 'dot': {
      const parsed = parseDotServer(server)
      if (!server || !parsed) {
        return { ok: false, error: server ? `${server} is not a hostname or an address for DNS over TLS` : 'Give the resolver’s hostname or address' }
      }
      return { ok: true, resolver: { protocol: 'dot', server: hostWithPort(parsed.host, parsed.port, DEFAULT_DOT_PORT), ...named } }
    }

    default: {
      const url = parseDohServer(server)
      if (!url) {
        return { ok: false, error: server ? `${server} is not a URL for DNS over HTTPS` : 'Give the resolver’s URL, such as https://dns.example.net/dns-query' }
      }
      return { ok: true, resolver: { protocol: 'doh', server: url.toString(), ...named } }
    }
  }
}

/**
 * Who a resolver is, without how it is asked: the name it was given, its
 * provider, or where it is. For beside a badge that says the protocol.
 */
export function resolverName(resolver: DnsResolver): string {
  if (resolver.protocol === 'system') return 'System resolver'

  const name = resolver.name?.trim()
  if (name) return name

  const server = resolver.server ?? ''
  const provider = providerOf(resolver)
  if (provider) return provider.name

  if (resolver.protocol === 'doh') {
    const url = parseDohServer(server)
    if (!url) return server
    const path = url.pathname === DEFAULT_DOH_PATH ? '' : url.pathname
    return url.host + path + url.search
  }
  return server
}

/**
 * What a resolver is called where there is only text to say it in: a chart's
 * legend, a sentence. Unique among the resolvers of one target, which is what
 * lets a chart keep each one's line apart by its name.
 */
export function resolverLabel(resolver: DnsResolver): string {
  if (resolver.protocol === 'system') return resolverName(resolver)

  // A name of its own always says how it is asked, plain DNS included: the
  // name says nothing about that, where a provider's is known for it. Without
  // one plain DNS needs no saying; the other two are what tells two lines to
  // the same provider apart.
  const plain = resolver.protocol === 'udp' && !resolver.name?.trim()
  return plain ? resolverName(resolver) : `${resolverName(resolver)} ${DNS_PROTOCOL_LABEL[resolver.protocol]}`
}

/** Whether two entries are the same resolver asked the same way, whatever each is called. */
export function sameResolver(a: Pick<DnsResolver, 'protocol' | 'server'>, b: Pick<DnsResolver, 'protocol' | 'server'>): boolean {
  return a.protocol === b.protocol && (a.protocol === 'system' || (a.server ?? '') === (b.server ?? ''))
}

/**
 * The resolver on a target's list that a stored reading was taken from, if it
 * is still there.
 *
 * A reading keeps the name its resolver had at the time, and a resolver can be
 * renamed a minute later. Found again by where it is, the reading can be shown
 * under the name it has now, and its history stays one line on the chart
 * rather than ending at the rename and starting again beside itself.
 */
export function resolverOfReading(reading: DnsResolverReading, resolvers: readonly DnsResolver[]): DnsResolver | undefined {
  if (reading.protocol === 'system' || reading.server !== undefined) {
    return resolvers.find(resolver => sameResolver(resolver, reading))
  }
  // Readings from before where it was got kept: by what it was called, with
  // or without a name given to it since.
  return resolvers.find(
    resolver =>
      resolver.protocol === reading.protocol &&
      (resolverLabel(resolver) === reading.label || resolverLabel({ protocol: resolver.protocol, server: resolver.server }) === reading.label)
  )
}

/** Who a stored reading's resolver is, as it is called now, without how it is asked. */
export function readingName(reading: DnsResolverReading, resolvers: readonly DnsResolver[] = []): string {
  const current = resolverOfReading(reading, resolvers)
  if (current) return resolverName(current)

  // No longer on the list: what it was called then, less the protocol that
  // the badge beside it says.
  const suffix = ` ${DNS_PROTOCOL_LABEL[reading.protocol]}`
  return reading.label.endsWith(suffix) ? reading.label.slice(0, -suffix.length) : reading.label
}

export type ResolversValidation = { ok: true; resolvers: DnsResolver[] } | { ok: false; error: string }

/**
 * Check a target's list of resolvers. An absent or empty list is the system
 * resolver alone, and comes back empty: there is nothing to store for it.
 */
export function validateResolvers(raw: unknown): ResolversValidation {
  if (raw === undefined || raw === null) return { ok: true, resolvers: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'Resolvers must be a list' }
  if (raw.length > MAX_DNS_RESOLVERS) {
    return { ok: false, error: `A target can ask at most ${MAX_DNS_RESOLVERS} resolvers` }
  }

  const resolvers: DnsResolver[] = []
  const labels = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const checked = validateResolver(entry)
    if (!checked.ok) return { ok: false, error: `Resolver ${index + 1}: ${checked.error}` }

    const label = resolverLabel(checked.resolver)
    if (labels.has(label)) return { ok: false, error: `${label} is listed twice` }
    // The same one under two names would be asked twice for one answer.
    const twin = resolvers.find(resolver => sameResolver(resolver, checked.resolver))
    if (twin) return { ok: false, error: `${label} is the same resolver as ${resolverLabel(twin)}` }
    labels.add(label)
    resolvers.push(checked.resolver)
  }

  // The system resolver by itself is what a target does with no list at all.
  if (resolvers.length === 1 && resolvers[0].protocol === 'system') return { ok: true, resolvers: [] }
  return { ok: true, resolvers }
}
