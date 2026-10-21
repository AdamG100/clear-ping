import type { TracerouteHop } from '@/types/probe'
import { classifyHost, type AddressFamily } from '../probes/host'
import type { PingPlatform } from '../probes/ping-parse'

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
 * What the probes are. `icmp` is ping's echo request, which is what Windows'
 * tracert always sends; `udp` is the classic traceroute packet to a high port.
 */
export type TraceMethod = 'icmp' | 'udp'

/**
 * The command for one trace. Addresses are always numeric here, and names are
 * never looked up for the hops: reverse lookups are what make a traceroute
 * take minutes, and a hop's name is not needed to see where loss begins.
 *
 * ICMP echo, not traceroute's usual UDP. The routers along the way answer
 * either alike, but the destination only answers UDP to a closed port if
 * nothing in front of it drops such packets, and most servers and the
 * firewalls before them do. Traced with UDP, a host that answers every ping
 * looks unreachable at the last hop. Echo is what the ping probes send, so a
 * trace arrives wherever they do. `udp` is the fallback for where ICMP cannot
 * be sent without privileges.
 */
export function tracerouteCommand(
  address: string,
  family: AddressFamily,
  platform: PingPlatform = process.platform as PingPlatform,
  method: TraceMethod = 'icmp'
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: 'tracert',
      args: ['-d', '-w', String(HOP_TIMEOUT_MS), '-h', String(MAX_HOPS), `-${family}`, address],
    }
  }

  const args = ['-n', '-w', '1', '-q', String(PROBES_PER_HOP), '-m', String(MAX_HOPS)]
  if (method === 'icmp') args.push('-I')

  // macOS keeps IPv6 in a separate binary, as it does for ping.
  if (platform === 'darwin') {
    return { command: family === 6 ? 'traceroute6' : 'traceroute', args: [...args, address] }
  }
  // One hop's probes at a time, as tracert and macOS send them. Linux sends
  // sixteen at once by default, and near the end of the path they all reach
  // the destination together, where a host that limits how fast it answers
  // pings (many do) drops some, and the last hop shows loss it does not have.
  return { command: 'traceroute', args: [...args, '-N', String(PROBES_PER_HOP), `-${family}`, address] }
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

/**
 * The traces worth keeping when the old ones are cleared out: the newest to
 * each address family. `newestFirst` is in the order they are listed.
 *
 * One per family, not just the newest of all, because a target probed over
 * both is traced over each, a moment apart. Keeping only the very newest
 * would throw away half of the latest look at it.
 */
export function newestPerFamily<T extends { address: string }>(newestFirst: T[]): T[] {
  const seen = new Set<string>()
  return newestFirst.filter(trace => {
    // A trace that never resolved its name has no family; those count as one kind.
    const host = classifyHost(trace.address)
    const kind = host === 'ipv4' || host === 'ipv6' ? host : 'unresolved'
    if (seen.has(kind)) return false
    seen.add(kind)
    return true
  })
}

/** Share of a hop's packets that got no reply, 0-100. */
export function hopLoss(hop: TracerouteHop): number {
  return hop.sent === 0 ? 0 : ((hop.sent - hop.rtts.length) / hop.sent) * 100
}

/**
 * The loss at each hop that is a loss of traffic, as against a router being
 * slow to answer.
 *
 * A router answers a traceroute probe from its control plane, which most limit
 * to a few a second, so one reply in three goes missing at a hop that forwards
 * everything it is sent. The tell is that the loss stops there: packets lost
 * on the way are lost for every hop beyond, so a hop's loss counts only as far
 * as the replies from the hops after it show it. With three probes a hop, a
 * single dropped reply is also 33%, which a tool that sends hundreds, as WinMTR
 * does, would show as the 1% or 2% it is.
 *
 * Hops that never answer say nothing either way and are passed over.
 */
export function pathLoss(hops: TracerouteHop[]): number[] {
  const counted = new Array<number>(hops.length)
  let beyond = Infinity
  for (let index = hops.length - 1; index >= 0; index--) {
    const own = hopLoss(hops[index])
    if (hops[index].rtts.length === 0) {
      counted[index] = own
      continue
    }
    counted[index] = Math.min(own, beyond)
    beyond = Math.min(beyond, own)
  }
  return counted
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
