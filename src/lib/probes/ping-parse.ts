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
