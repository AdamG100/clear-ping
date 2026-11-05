import type { IpVersion, ProbeConfig, ProbeType } from '@/types/probe'
import { resolverLabel } from './dns/resolvers'
import { classifyHost } from './host'
import { DEFAULT_PING_PACKETS, dnsQueryNameFor, GAME_QUERY_INFO, httpUrlFor, isAddressRecord, nameRecordType } from './config'

/**
 * The words used for a target's readings, by probe type.
 *
 * Every probe fills the same three columns, but they are not measuring the
 * same thing: one times ICMP echoes, another DNS answers, another whole HTTP
 * requests. Calling a slow web server's reading "RTT" or its failed requests
 * "packet loss" describes a network path the probe never tested.
 */
export interface ProbeVocabulary {
  /** Short badge text for the method. */
  method: string
  latencyTitle: string
  latencyLabel: string
  lossTitle: string
  lossLabel: string
  jitterLabel: string
  chartTitle: string
  /** Shown in the loss lane when nothing was lost. */
  noLoss: string
  /** What one request in a probe is called, plural. */
  unit: string
  /** One-line result for the "Probe now" toast. */
  summarize: (latencyMs: number, lossPercent: number) => string
}

const VOCABULARY: Record<ProbeType, ProbeVocabulary> = {
  ping: {
    method: 'ICMP',
    latencyTitle: 'Median RTT',
    latencyLabel: 'Median Round Trip Time',
    lossTitle: 'Packet Loss',
    lossLabel: 'Average Packet Loss',
    jitterLabel: 'Variation between consecutive packets',
    chartTitle: 'Latency & packet loss',
    noLoss: 'No packet loss in this window',
    unit: 'packets',
    summarize: (latency, loss) => `${latency}ms, ${loss}% loss`,
  },
  arp: {
    method: 'ARP',
    latencyTitle: 'Median Reply Time',
    latencyLabel: 'Median time for the device to answer an ARP request',
    lossTitle: 'Unanswered Requests',
    lossLabel: 'Average share of ARP requests left unanswered',
    jitterLabel: 'Variation between consecutive replies',
    chartTitle: 'Reply time & unanswered requests',
    noLoss: 'No unanswered requests in this window',
    unit: 'requests',
    summarize: (latency, loss) => `${latency}ms to reply, ${loss}% of requests unanswered`,
  },
  tcp: {
    method: 'TCP',
    latencyTitle: 'Median Connect Time',
    latencyLabel: 'Median time to open a TCP connection',
    lossTitle: 'Failed Connections',
    lossLabel: 'Average share of connection attempts that failed',
    jitterLabel: 'Variation between consecutive connections',
    chartTitle: 'Connect time & failed connections',
    noLoss: 'No failed connections in this window',
    unit: 'connections',
    summarize: (latency, loss) => `${latency}ms to connect, ${loss}% of attempts failed`,
  },
  game: {
    method: 'Game',
    latencyTitle: 'Median Reply Time',
    latencyLabel: 'Median time for the server to answer a query',
    lossTitle: 'Unanswered Queries',
    lossLabel: 'Average share of queries that got no reply',
    jitterLabel: 'Variation between consecutive replies',
    chartTitle: 'Reply time & unanswered queries',
    noLoss: 'No unanswered queries in this window',
    unit: 'queries',
    summarize: (latency, loss) => `${latency}ms to reply, ${loss}% of queries unanswered`,
  },
  http: {
    method: 'HTTP',
    latencyTitle: 'Median Response Time',
    latencyLabel: 'Median time to the first byte of the response',
    lossTitle: 'Failed Requests',
    lossLabel: 'Average share of requests that failed or got the wrong answer',
    jitterLabel: 'Variation between consecutive requests',
    chartTitle: 'Response time & failed requests',
    noLoss: 'No failed requests in this window',
    unit: 'requests',
    summarize: (latency, loss) => `${latency}ms to first byte, ${loss}% of requests failed`,
  },
  dns: {
    method: 'DNS',
    latencyTitle: 'Median Query Time',
    latencyLabel: 'Median time for a DNS query to be answered',
    lossTitle: 'Failed Queries',
    lossLabel: 'Average share of queries left unanswered',
    jitterLabel: 'Variation between consecutive queries',
    chartTitle: 'Query time & failed queries',
    noLoss: 'No failed queries in this window',
    unit: 'queries',
    summarize: (latency, loss) => `${latency}ms query time, ${loss}% of queries unanswered`,
  },
}

export function probeVocabulary(probeType: ProbeType): ProbeVocabulary {
  return VOCABULARY[probeType]
}

const FAMILY_NAME: Record<'ipv4' | 'ipv6', string> = {
  ipv4: 'IPv4 address (A record)',
  ipv6: 'IPv6 address (AAAA record)',
}

/** What pinning a named target to a family, or to both, adds to its probe. */
function familyNote(ipVersion: IpVersion): string {
  switch (ipVersion) {
    case 'ipv4':
      return ' Over IPv4 only.'
    case 'ipv6':
      return ' Over IPv6 only.'
    case 'both':
      return ' Run over IPv4 and over IPv6 each time, and charted as two lines.'
    default:
      return ''
  }
}

/**
 * A sentence saying what will actually be measured for this address, probe and
 * settings — the difference between the target kinds, spelled out where the
 * choice is made. Empty until the address is something probeable.
 */
export function describeProbe(
  host: string,
  probeType: ProbeType,
  ipVersion: IpVersion = 'auto',
  config: ProbeConfig = {}
): string {
  const kind = classifyHost(host)
  if (kind === 'invalid') return ''

  const isName = kind === 'hostname'
  // An address is its own family; only a name leaves the choice open.
  const family = isName ? familyNote(ipVersion) : ''

  switch (probeType) {
    case 'ping': {
      // Said every time: it is why loss moves in the steps it does.
      const packets = config.packets ?? DEFAULT_PING_PACKETS
      const step = 100 / packets
      const counted = ` ${packets} packets a probe, so loss is read in steps of ${Number.isInteger(step) ? step : step.toFixed(1)}%.`
      if (!isName) return `Pings this ${kind === 'ipv6' ? 'IPv6' : 'IPv4'} address directly.${counted}`
      if (ipVersion === 'both') {
        return `Resolves the name before every probe, then pings its IPv4 and its IPv6 address separately. Charted as two lines, so one family failing shows beside the other.${counted}`
      }
      return ipVersion === 'auto'
        ? `Resolves the name before every probe, then pings the address the system prefers.${counted}`
        : `Resolves the name's ${FAMILY_NAME[ipVersion]} before every probe, then pings it.${counted}`
    }

    case 'arp': {
      const packets = config.packets ?? DEFAULT_PING_PACKETS
      const step = 100 / packets
      const counted = ` ${packets} requests a probe, so loss is read in steps of ${Number.isInteger(step) ? step : step.toFixed(1)}%.`
      const asks = isName ? 'Resolves the name to its IPv4 address before every probe, then asks' : 'Asks'
      return `${asks} who has it over ARP and times the reply, which a device on the network sends even when it ignores ping. ` +
        `Only works from a machine on the same network, so usually from a probe agent there, and on Linux.${counted}`
    }

    case 'tcp': {
      const port = config.port ? `port ${config.port}` : 'the port below'
      return `Opens a connection to ${port} and times the handshake, then closes it. Works where ping is blocked, and fails if nothing is listening.${family}`
    }

    case 'game': {
      const query = config.gameQuery ?? 'source'
      const port = config.port ? `port ${config.port}` : 'the port below'
      if (query === 'unreachable') {
        return `Sends UDP packets to ports on the server that nothing listens on and times the "port unreachable" reply, 10 a probe, a second apart. Shows the server and the way to it are up, not the game on it. A server behind a firewall that drops these packets, such as Google Cloud's, sends no reply and cannot be measured this way.${family}`
      }
      const { sends, transport } = GAME_QUERY_INFO[query]
      const timed = query === 'minecraft'
        ? 'times its ping, as the game\'s server list does'
        : 'times the reply'
      return `Sends ${sends} to ${port} over ${transport} and ${timed}, 10 times a probe. Also reads the server's name and player count where it says them.${family}`
    }

    case 'http': {
      const wanted = config.expectedStatus ? `HTTP ${config.expectedStatus}` : 'a 2xx or 3xx response'
      const keyword = config.keyword ? ` containing "${config.keyword}"` : ''
      const certificate = (config.scheme ?? 'https') === 'https' ? ' Also tracks when the certificate expires.' : ''
      return `Requests ${httpUrlFor(host, config)} and expects ${wanted}${keyword}.${certificate}${family}`
    }

    case 'dns': {
      const expected = config.expectedAnswer
        ? ` Fails unless the answer includes ${config.expectedAnswer}.`
        : ''
      if (isName && config.resolvers && config.resolvers.length > 0) {
        const through = config.resolvers.map(resolverLabel).join(', ')
        const each = config.resolvers.length > 1 ? ' Each is asked on every probe and timed by itself, so they can be told apart.' : ''
        // Which kind of address is the IP version's to say, and both of them
        // is two lookups a probe.
        const record = nameRecordType(config.recordType, ipVersion)
        const records = ipVersion === 'both' && isAddressRecord(record)
          ? 'A and the AAAA record of this name, charted as two lines'
          : `${record} record of this name`
        return `Asks ${through} for the ${records}.${each}${expected} No ping is sent.`
      }
      if (isName) {
        return `Looks this name up through the system resolver and times the answer.${expected} No ping is sent.${family}`
      }
      const record = config.recordType ?? 'A'
      const name = config.queryName || dnsQueryNameFor(host)
      return `Asks this server for the ${record} record of ${name} and times its answer.${expected} No ping is sent.`
    }
  }
}
