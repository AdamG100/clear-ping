import type { TracerouteHop } from '@/types/probe'
import { classifyHost, type AddressFamily } from './host'
import type { PingPlatform } from './ping-parse'

/**
 * Building the traceroute command and reading its output.
 *
 * Separate from the code that runs it for the same reason ping's parser is:
 * the three platforms print different things, and each can only be tested on
 * the others from captured text.
 */

/** Per-hop reply timeout. Short, because a silent hop costs this three times over. */
const HOP_TIMEOUT_MS = 700
/** Paths longer than this exist, but a trace that has not arrived by now is not going to. */
const MAX_HOPS = 24
const PROBES_PER_HOP = 3

/**
 * The command for one trace. Addresses are always numeric here, and names are
 * never looked up for the hops: reverse lookups are what make a traceroute
 * take minutes, and a hop's name is not needed to see where loss begins.
 */
export function tracerouteCommand(
  address: string,
  family: AddressFamily,
  platform: PingPlatform = process.platform as PingPlatform
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: 'tracert',
      args: ['-d', '-w', String(HOP_TIMEOUT_MS), '-h', String(MAX_HOPS), `-${family}`, address],
    }
  }

  const args = ['-n', '-w', '1', '-q', String(PROBES_PER_HOP), '-m', String(MAX_HOPS)]

  // macOS keeps IPv6 in a separate binary, as it does for ping.
  if (platform === 'darwin') {
    return { command: family === 6 ? 'traceroute6' : 'traceroute', args: [...args, address] }
  }
  return { command: 'traceroute', args: [...args, `-${family}`, address] }
}

/** "12 ms", "0.345 ms" and Windows' "<1 ms". */
const RTT_PATTERN = /<?\s*(\d+(?:\.\d+)?)\s*ms/g

/**
 * Read the hops out of `tracert` (Windows) or `traceroute` (Linux, macOS)
 * output. Both print one line per hop that starts with the hop number; they
 * differ in whether the address comes before or after the timings, which does
 * not matter here because the address is found by what it looks like rather
 * than by where it sits.
 */
export function parseTraceroute(stdout: string): TracerouteHop[] {
  const hops: TracerouteHop[] = []

  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue

    const rest = match[2]
    const rtts = [...rest.matchAll(RTT_PATTERN)].map(m => parseFloat(m[1]))
    const timeouts = (rest.match(/\*/g) ?? []).length

    const address =
      rest
        .split(/\s+/)
        .map(token => token.replace(/^[([]|[)\],]$/g, ''))
        .find(token => {
          const kind = classifyHost(token)
          return kind === 'ipv4' || kind === 'ipv6'
        }) ?? null

    // A line with neither timings nor timeouts is a header that happens to
    // begin with a digit, unless it names a router: Windows reports an
    // unreachable network as "<address> reports: Destination net unreachable."
    if (rtts.length === 0 && timeouts === 0 && address === null) continue

    hops.push({
      hop: Number(match[1]),
      address,
      rtts,
      sent: Math.max(rtts.length + timeouts, 1),
    })
  }

  return trimTrailingSilence(hops)
}

/**
 * A destination that does not answer leaves a run of silent hops out to the
 * hop limit. One of them says "nothing came back from here on"; twenty say it
 * no better, so the rest are dropped.
 */
function trimTrailingSilence(hops: TracerouteHop[]): TracerouteHop[] {
  let end = hops.length
  while (end > 1 && hops[end - 1].rtts.length === 0 && hops[end - 2].rtts.length === 0) end--
  return hops.slice(0, end)
}

/** Whether the trace arrived: the last hop that answered is the address being traced. */
export function traceReached(hops: TracerouteHop[], address: string): boolean {
  const normalize = (value: string) => value.toLowerCase().split('%')[0]
  const last = [...hops].reverse().find(hop => hop.rtts.length > 0)
  return !!last?.address && normalize(last.address) === normalize(address)
}

/** Share of a hop's packets that got no reply, 0-100. */
export function hopLoss(hop: TracerouteHop): number {
  return hop.sent === 0 ? 0 : ((hop.sent - hop.rtts.length) / hop.sent) * 100
}

/**
 * The hop where the path stops working: the first one from which nothing
 * further answers. Null when the trace arrived, or when loss is scattered.
 *
 * A single silent hop in the middle of a working path is deliberately not
 * reported. Routers commonly decline to answer traceroute probes while
 * forwarding traffic perfectly well, and calling that hop the fault is the
 * classic misreading of a traceroute.
 */
export function firstDeadHop(hops: TracerouteHop[], reached: boolean): number | null {
  if (reached || hops.length === 0) return null

  let index = hops.length
  while (index > 0 && hops[index - 1].rtts.length === 0) index--
  return index < hops.length ? hops[index].hop : null
}
