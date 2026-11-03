/**
 * Parsing of the system `ping` command's output.
 *
 * Kept separate from the code that spawns the process so it can be tested
 * against captured output from every platform without needing that platform —
 * the format differs enough between Windows, Linux and macOS that a regex
 * written against one silently mis-reads the others.
 */

import { isValidHost, type AddressFamily } from './host'

export type PingPlatform = 'win32' | 'darwin' | 'linux'

/** Matches "time=12ms", "time<1ms" (Windows) and "time=12.3 ms" (Linux/macOS). */
const RTT_PATTERN = /time\s*[=<]\s*(\d+(?:\.\d+)?)\s*ms/i

/**
 * Lines that mean "this packet did not come back", even though some of them
 * appear in output that exits zero. A reply from an intermediate router
 * reporting "Destination host unreachable" is a lost packet, not a 0ms round
 * trip.
 */
const FAILURE_PATTERN =
  /unreachable|timed out|100% packet loss|could not find host|unknown host|name or service not known|expired in transit|request timeout|general failure|transmit failed/i

export interface ParsedPing {
  received: boolean
  /** Round-trip time in milliseconds, or null if the packet was lost. */
  latency: number | null
  /** A human-readable reason, when the output offers one. */
  error?: string
}

/**
 * Parse the output of a single-packet `ping` invocation.
 *
 * `ping` exits non-zero on loss, so callers pass the stdout captured from the
 * error path too; a non-zero exit is ordinary packet loss, not a probe failure.
 */
export function parsePingOutput(stdout: string, fallbackError?: string): ParsedPing {
  const match = RTT_PATTERN.exec(stdout ?? '')

  if (match) {
    const latency = parseFloat(match[1])
    if (Number.isFinite(latency)) {
      return { received: true, latency }
    }
  }

  return {
    received: false,
    latency: null,
    error: firstFailureLine(stdout ?? '') ?? fallbackError,
  }
}

/** Pull the first line that explains a failure, for the measurement's error column. */
export function firstFailureLine(stdout: string): string | undefined {
  return (stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0 && FAILURE_PATTERN.test(line))
}

/**
 * Build the argv for one echo request.
 *
 * The timeout flag is not portable and the units differ: Windows `-w` takes
 * milliseconds, Linux `-W` takes seconds. Passing a millisecond value to Linux
 * turns a 1s timeout into a ~17 minute one, so every packet appears to arrive
 * and the probe reports a flawless path.
 *
 * `family` pins the address family. It is passed even though the address is a
 * literal that implies it, because older Linux `ping` builds refuse an IPv6
 * literal without `-6`.
 */
export function pingArgs(
  host: string,
  timeoutMs: number,
  platform: PingPlatform = process.platform as PingPlatform,
  family?: AddressFamily
): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const familyFlag = family ? [`-${family}`] : []

  switch (platform) {
    case 'win32':
      return ['-n', '1', '-w', String(timeoutMs), ...familyFlag, host]
    case 'darwin':
      // macOS splits the two families across binaries (see pingCommand), and
      // `ping6` has no per-packet timeout flag: the caller's process timeout
      // is what bounds a lost IPv6 packet there.
      return family === 6
        ? ['-c', '1', host]
        : ['-c', '1', '-W', String(timeoutMs), '-t', String(timeoutSeconds), host]
    default:
      return ['-c', '1', '-W', String(timeoutSeconds), '-w', String(timeoutSeconds), ...familyFlag, host]
  }
}

/**
 * The argv for a whole round from one `ping`, on Linux. `-W` waits for an answer
 * after the last packet has gone. Never `-w`: with a deadline, `-c` means that
 * many replies rather than that many packets, and a lossy path would be sent
 * more than it was meant to get. `-n` so a reply is never looked up by name.
 */
export function pingRoundArgs(host: string, count: number, spacingMs: number, timeoutMs: number, family?: AddressFamily): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return ['-n', '-c', String(count), '-i', String(spacingMs / 1000), '-W', String(timeoutSeconds), ...(family ? [`-${family}`] : []), host]
}

export interface ParsedPingRound {
  /** Packets that went out, or null when `ping` never got as far as saying. */
  sent: number | null
  /** The time of each packet answered, in the order they were sent. */
  latencies: number[]
  /** A human-readable reason, when the output offers one. */
  error?: string
}

const ROUND_REPLY = /icmp_seq=(\d+).*?\btime=(\d+(?:\.\d+)?)\s*ms/i
const ROUND_SUMMARY = /(\d+)\s+packets transmitted/i

/**
 * Parse what one `ping` printed for a whole round. A duplicate of a reply is one
 * packet answered, not two, and an answer later than the timeout is a lost
 * packet, as it is when each packet is sent on its own.
 */
export function parsePingRound(stdout: string, timeoutMs: number, fallbackError?: string): ParsedPingRound {
  const answered = new Map<number, number>()
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const match = ROUND_REPLY.exec(line)
    if (!match) continue
    const sequence = Number(match[1])
    const latency = parseFloat(match[2])
    if (!answered.has(sequence) && Number.isFinite(latency) && latency <= timeoutMs) answered.set(sequence, latency)
  }
  const summary = ROUND_SUMMARY.exec(stdout ?? '')
  return {
    sent: summary ? Number(summary[1]) : null,
    latencies: [...answered].sort((a, b) => a[0] - b[0]).map(([, latency]) => latency),
    error: firstFailureLine(stdout ?? '') ?? fallbackError,
  }
}

/**
 * Whether this `ping` turned the round's flags down: an older one will not send
 * this fast without root, and BusyBox's does not know them all. Not the same as
 * failing to reach anything, which says nothing about the program.
 */
export function pingRefusedRound(stderr: string): boolean {
  return /minimal interval|cannot flood|too small|invalid (?:option|argument|-)|unrecognized option|usage:/i.test(stderr ?? '')
}

/** The binary to run. Only macOS still ships IPv6 ping as a separate program. */
export function pingCommand(
  platform: PingPlatform = process.platform as PingPlatform,
  family?: AddressFamily
): string {
  return platform === 'darwin' && family === 6 ? 'ping6' : 'ping'
}

/**
 * Hosts we are willing to hand to `ping`: an IPv4 or IPv6 literal, or a
 * hostname. See ./host for the rules, which are deliberately strict.
 */
export function isValidPingHost(host: string): boolean {
  return isValidHost(host ?? '')
}
