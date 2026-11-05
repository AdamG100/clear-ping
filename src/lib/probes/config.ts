import type { DnsRecordType, IpVersion, ProbeConfig, ProbeType, Target, GameQuery } from '@/types/probe'
import { validateResolvers } from './dns/resolvers'
import { classifyHost, isIpv6, normalizeHost, resolverDomain } from './host'

/**
 * Per-probe settings: reading them out of what the user typed, checking them,
 * and turning them back into something to display.
 *
 * A target's `host` is always a bare address or name, whatever the probe.
 * Everything else a probe needs — the port to connect to, the path to request,
 * the name to ask a DNS server for — lives in its `ProbeConfig`. Keeping the
 * host bare is what lets address-family selection, name resolution and the
 * IP/domain distinction work identically for every probe.
 *
 * Pure, with no Node imports: the add-target dialog runs this as you type.
 */

export const PROBE_TYPES: readonly ProbeType[] = ['ping', 'arp', 'tcp', 'game', 'http', 'dns']

/**
 * Whether a probe counts packets of its own, so a target can ask for how many:
 * ping's echo requests and ARP's requests. Loss reads in steps of one packet.
 */
export function countsPackets(probeType: ProbeType): boolean {
  return probeType === 'ping' || probeType === 'arp'
}

/** Why a probe cannot run over an IP version, or null if it can. ARP has no IPv6: that is Neighbor Discovery. */
export function ipVersionProblem(probeType: ProbeType, ipVersion: IpVersion | undefined): string | null {
  return probeType === 'arp' && (ipVersion === 'ipv6' || ipVersion === 'both')
    ? 'ARP works over IPv4 only: leave the IP version automatic, or set it to IPv4'
    : null
}

export const GAME_QUERIES: readonly GameQuery[] = ['source', 'minecraft', 'bedrock', 'quake', 'unreachable']

/**
 * Each game query as the form offers it: what it is called, which servers
 * answer it, the port they usually answer on, what a probe sends and over
 * what.
 */
export const GAME_QUERY_INFO: Record<
  GameQuery,
  { label: string; answers: string; port: string; sends: string; transport: 'UDP' | 'TCP'; queryPort: boolean }
> = {
  source: {
    label: 'Steam (A2S)',
    answers: 'Counter-Strike 2, Rust, ARK, Garry\'s Mod, Valheim, DayZ, Team Fortress 2 and most other Steam game servers.',
    port: 'e.g., 27015',
    sends: 'a Steam server query (A2S_INFO)',
    transport: 'UDP',
    queryPort: true,
  },
  minecraft: {
    label: 'Minecraft Java',
    answers: 'Minecraft Java servers, and proxies such as BungeeCord and Velocity. The ping is the one the game\'s server list shows.',
    port: '25565',
    sends: 'a server list ping',
    transport: 'TCP',
    queryPort: false,
  },
  bedrock: {
    label: 'Minecraft Bedrock',
    answers: 'Minecraft Bedrock and Education servers, and proxies such as Geyser.',
    port: '19132',
    sends: 'a Minecraft Bedrock ping',
    transport: 'UDP',
    queryPort: false,
  },
  quake: {
    label: 'Quake 3 / FiveM',
    answers: 'FiveM, RedM, Quake 3, Wolfenstein: Enemy Territory and the older Call of Duty games.',
    port: 'e.g., 30120, 27960',
    sends: 'an id Tech getinfo query',
    transport: 'UDP',
    queryPort: false,
  },
  unreachable: {
    label: 'Any other game (Call of Duty…)',
    answers:
      'For games whose servers answer no query: Call of Duty, Valorant, League of Legends, Fortnite and the like. ' +
      'Sends UDP packets to ports on the server that nothing listens on, and times the "port unreachable" reply, which many servers that block ping still send. ' +
      'It shows that the server and the way to it are up, and how fast, not that the game on it is running. ' +
      'Servers behind a firewall that drops unknown packets, such as Google Cloud\'s, send nothing back and cannot be measured this way.',
    port: 'the game port, e.g., 44998',
    sends: 'UDP packets to ports nothing listens on',
    transport: 'UDP',
    queryPort: false,
  },
}

export function isGameQuery(value: unknown): value is GameQuery {
  return GAME_QUERIES.includes(value as GameQuery)
}

/**
 * Whether a target is timed by its server's "port unreachable" for closed
 * ports. A server behind a firewall that drops those packets never answers
 * it at all, which is a server this check cannot measure, not one that is
 * down: such a target is shown grey and raises no alerts until it answers.
 */
export function isClosedPortCheck(target: { probeType: ProbeType; probeConfig?: ProbeConfig }): boolean {
  return target.probeType === 'game' && target.probeConfig?.gameQuery === 'unreachable'
}

export const DNS_RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT']

export function isProbeType(value: unknown): value is ProbeType {
  return PROBE_TYPES.includes(value as ProbeType)
}

/**
 * Echo requests in a ping probe. Loss is counted in whole packets, so the
 * count is how finely it is read: 20 reads it in steps of 5%. More read it
 * more finely and take longer, a second for each one a dead path never
 * answers, so a target can ask for up to 100 (steps of 1%). Fewer than 5
 * would read loss in steps too coarse to say anything.
 */
export const DEFAULT_PING_PACKETS = 20
export const MIN_PING_PACKETS = 5
export const MAX_PING_PACKETS = 100

/**
 * What a DNS server is asked for when it is not a resolver ClearPing knows
 * and its target names nothing: a name so widely looked up that any resolver
 * has it to hand, so the time is the server's own and not a lookup it had to
 * make elsewhere first.
 */
export const DEFAULT_DNS_QUERY_NAME = 'google.com'

/**
 * The name a DNS server is asked for when its target names none: a
 * well-known resolver its own operator's domain (1.1.1.1 `cloudflare.com`,
 * 8.8.8.8 `google.com`), anything else DEFAULT_DNS_QUERY_NAME.
 *
 * Every server was asked for `example.com` once. A name that has nothing to
 * do with the server can fail for reasons that are not the server's, and the
 * failure is put down to the server; its own name is the one thing it can be
 * relied on to answer for.
 */
export function dnsQueryNameFor(server: string): string {
  return resolverDomain(server) ?? DEFAULT_DNS_QUERY_NAME
}

/** How many times a DNS probe puts its question, to each resolver it asks. */
export const DNS_QUERIES_PER_PROBE = 5

/** Whether a record is an address, the kind a name has one of for each IP version. */
export function isAddressRecord(recordType: DnsRecordType): boolean {
  return recordType === 'A' || recordType === 'AAAA'
}

/**
 * The record a name target's own resolvers are asked for on one probe.
 *
 * Between the two kinds of address the target's IP version decides, as it does
 * for every other probe: a target on IPv6 asks for AAAA, and one on both asks
 * for each in turn. The record type only chooses between them where the
 * version has been left to choose itself.
 */
export function nameRecordType(recordType: DnsRecordType | undefined, ipVersion: IpVersion = 'auto'): DnsRecordType {
  if (recordType && !isAddressRecord(recordType)) return recordType
  if (ipVersion === 'ipv6') return 'AAAA'
  if (ipVersion === 'ipv4') return 'A'
  return recordType ?? 'A'
}

const DEFAULT_PORT = { http: 80, https: 443 } as const

export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

export interface ParsedAddress {
  /** The bare host, ready to store. */
  host: string
  /** The probe the input's shape implies, if it implies one. */
  probeType?: ProbeType
  /** Settings carried by the input itself: a port, a scheme, a path. */
  config: ProbeConfig
}

/**
 * Split what was typed into the address box into a host and whatever else it
 * carried. People paste `https://example.com/health` and `db.internal:5432`,
 * and both say unambiguously which probe is wanted.
 */
export function parseAddressInput(input: string): ParsedAddress {
  const trimmed = (input ?? '').trim()

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const scheme = url.protocol === 'http:' ? 'http' : 'https'
      const config: ProbeConfig = { scheme, path: `${url.pathname || '/'}${url.search}` }
      if (url.port) config.port = Number(url.port)
      // URL keeps the brackets on an IPv6 host; normalizeHost takes them off.
      return { host: normalizeHost(url.hostname), probeType: 'http', config }
    } catch {
      return { host: trimmed, config: {} }
    }
  }

  // "udp://203.0.113.5:27015": a port that is asked over UDP, which is a game
  // server's as a rule. Without the scheme a port is taken to be TCP's.
  const udp = /^udp:\/\//i.test(trimmed)
  const rest = udp ? trimmed.slice('udp://'.length) : trimmed
  const portProbe: ProbeType = udp ? 'game' : 'tcp'

  // "[2001:db8::1]:443" — the only way to attach a port to an IPv6 literal.
  const bracketed = /^\[(.+)\]:(\d{1,5})$/.exec(rest)
  if (bracketed && isIpv6(bracketed[1]) && isPort(Number(bracketed[2]))) {
    return { host: bracketed[1], probeType: portProbe, config: { port: Number(bracketed[2]) } }
  }

  // "host:443". A bare IPv6 literal has colons too, but never exactly one.
  const withPort = /^([^:\s]+):(\d{1,5})$/.exec(rest)
  if (withPort && isPort(Number(withPort[2])) && classifyHost(withPort[1]) !== 'invalid') {
    return { host: withPort[1], probeType: portProbe, config: { port: Number(withPort[2]) } }
  }

  return { host: normalizeHost(rest), ...(udp ? { probeType: 'game' as const } : {}), config: {} }
}

export type ConfigValidation =
  | { ok: true; config: ProbeConfig }
  | { ok: false; error: string }

/**
 * Check a config against the probe it is for, and reduce it to the fields that
 * probe uses. Returning a fresh object rather than the input is deliberate: a
 * target switched from HTTP to TCP must not keep a path nobody can see or edit.
 */
export function validateProbeConfig(probeType: ProbeType, host: string, raw: unknown): ConfigValidation {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const config: ProbeConfig = {}

  switch (probeType) {
    case 'arp':
    case 'ping': {
      // ARP has no IPv6 (that is Neighbor Discovery): refused here rather than
      // stored as a target that can only ever fail.
      if (probeType === 'arp' && classifyHost(host) === 'ipv6') {
        return { ok: false, error: 'ARP works over IPv4 only: use an IPv4 address, or a name with one' }
      }
      if (input.packets === undefined || input.packets === null) return { ok: true, config }
      const packets = input.packets
      if (typeof packets !== 'number' || !Number.isInteger(packets) || packets < MIN_PING_PACKETS || packets > MAX_PING_PACKETS) {
        return { ok: false, error: `Packets per probe must be a whole number from ${MIN_PING_PACKETS} to ${MAX_PING_PACKETS}` }
      }
      // The usual count is left unsaid, so a target keeps up with it.
      if (packets !== DEFAULT_PING_PACKETS) config.packets = packets
      return { ok: true, config }
    }

    case 'tcp': {
      if (!isPort(input.port)) {
        return { ok: false, error: 'A TCP monitor needs a port between 1 and 65535' }
      }
      return { ok: true, config: { port: input.port } }
    }

    case 'game': {
      if (!isPort(input.port)) {
        return { ok: false, error: 'A game server needs a port between 1 and 65535' }
      }
      const query = input.gameQuery ?? 'source'
      if (!isGameQuery(query)) {
        return { ok: false, error: `Query must be one of: ${GAME_QUERIES.join(', ')}` }
      }
      return { ok: true, config: { port: input.port, gameQuery: query } }
    }

    case 'http': {
      const scheme = input.scheme ?? 'https'
      if (scheme !== 'http' && scheme !== 'https') {
        return { ok: false, error: 'Scheme must be http or https' }
      }
      config.scheme = scheme

      if (input.port !== undefined && input.port !== null) {
        if (!isPort(input.port)) return { ok: false, error: 'Port must be between 1 and 65535' }
        if (input.port !== DEFAULT_PORT[scheme]) config.port = input.port
      }

      const path = text(input.path) || '/'
      if (!path.startsWith('/') || /\s/.test(path)) {
        return { ok: false, error: 'Path must start with / and contain no spaces' }
      }
      config.path = path

      if (input.expectedStatus !== undefined && input.expectedStatus !== null) {
        const status = input.expectedStatus
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
          return { ok: false, error: 'Expected status must be an HTTP status code (100-599)' }
        }
        config.expectedStatus = status
      }

      const keyword = text(input.keyword)
      if (keyword.length > 200) return { ok: false, error: 'Keyword must be 200 characters or fewer' }
      if (keyword) config.keyword = keyword

      return { ok: true, config }
    }

    case 'dns': {
      const isServer = classifyHost(host) !== 'hostname'

      // Only a server target has a choice of what to ask: a name target is the
      // question, and it is looked up as an address through the system resolver.
      if (isServer) {
        const queryName = text(input.queryName)
        if (queryName) {
          if (classifyHost(queryName) !== 'hostname') {
            return { ok: false, error: 'Query name must be a hostname' }
          }
          config.queryName = queryName
        }

        if (input.recordType !== undefined && input.recordType !== null) {
          if (!DNS_RECORD_TYPES.includes(input.recordType as DnsRecordType)) {
            return { ok: false, error: `Record type must be one of: ${DNS_RECORD_TYPES.join(', ')}` }
          }
          config.recordType = input.recordType as DnsRecordType
        }
      }

      // A name can be asked of resolvers of its own choosing instead of the
      // system's, and then for any kind of record: those are queried directly,
      // where the system resolver only ever hands back addresses.
      if (!isServer) {
        const resolvers = validateResolvers(input.resolvers)
        if (!resolvers.ok) return resolvers

        if (resolvers.resolvers.length > 0) {
          config.resolvers = resolvers.resolvers
          if (input.recordType !== undefined && input.recordType !== null) {
            if (!DNS_RECORD_TYPES.includes(input.recordType as DnsRecordType)) {
              return { ok: false, error: `Record type must be one of: ${DNS_RECORD_TYPES.join(', ')}` }
            }
            config.recordType = input.recordType as DnsRecordType
          }

          const asksForAddress = !config.recordType || isAddressRecord(config.recordType)
          if (!asksForAddress && config.resolvers.some(resolver => resolver.protocol === 'system')) {
            return {
              ok: false,
              error: `The system resolver only looks up addresses. Ask for an A or AAAA record, or take it off the list to ask for ${config.recordType}`,
            }
          }
        }
      }

      const expectedAnswer = text(input.expectedAnswer)
      if (expectedAnswer.length > 255) {
        return { ok: false, error: 'Expected answer must be 255 characters or fewer' }
      }
      if (expectedAnswer) config.expectedAnswer = expectedAnswer

      return { ok: true, config }
    }
  }
}

/** A host as it has to be written inside a URL or before a port. */
function bracketIfIpv6(host: string): string {
  return isIpv6(host) ? `[${host}]` : host
}

/** The URL an HTTP target requests. */
export function httpUrlFor(host: string, config: ProbeConfig = {}): string {
  const scheme = config.scheme ?? 'https'
  const port = config.port && config.port !== DEFAULT_PORT[scheme] ? `:${config.port}` : ''
  return `${scheme}://${bracketIfIpv6(host)}${port}${config.path ?? '/'}`
}

/**
 * The address to show for a target: what a person would type to reach the
 * thing being probed, port or URL included.
 */
export function targetAddressLabel(target: Pick<Target, 'host' | 'probeType' | 'probeConfig'>): string {
  const config = target.probeConfig ?? {}

  if (target.probeType === 'http') return httpUrlFor(target.host, config)
  if ((target.probeType === 'tcp' || target.probeType === 'game') && config.port) return `${bracketIfIpv6(target.host)}:${config.port}`
  return target.host
}
