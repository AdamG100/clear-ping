/**
 * Running iputils `arping` and reading what it prints.
 *
 * Kept apart from the code that runs it so it can be tested against captured
 * output (`__fixtures__/arping-output.ts`) on any machine. Only iputils'
 * `arping` is read: the unrelated `arping` package by Thomas Habets prints
 * differently and takes different flags.
 */

export interface ParsedArping {
  received: boolean
  /** Time to the reply in milliseconds, or null if none came. */
  latency: number | null
  /** The hardware address that answered, as `arping` prints it. */
  mac?: string
  /** Why it did not answer, when the output says. */
  error?: string
}

/** `Unicast reply from 192.168.1.1 [8A:5D:1B:34:5A:26]  0.533ms` */
const REPLY = /^Unicast reply from (\S+) \[([0-9A-Fa-f:]{17})\]\s+(\d+(?:\.\d+)?)\s*ms/m

/**
 * The argv for one ARP request. One request per run, because `-i` only takes
 * whole seconds: a run of twenty would take twenty seconds, where twenty runs
 * of one take about as long as the replies do. A run of one ends as soon as
 * it is answered, or after `-w` when it is not.
 *
 * `-I` names the interface the address was found on, rather than leaving
 * `arping` to pick one by route, so the request goes out where the address
 * was judged to be local.
 */
export function arpingArgs(address: string, device: string, timeoutMs: number): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return ['-c', '1', '-w', String(timeoutSeconds), '-I', device, address]
}

/**
 * Read one run of `arping`. It exits 1 when nothing answered, which is a lost
 * request and not a failure of the probe, so the caller passes on what was
 * printed either way. A reply is only counted from the address asked about.
 */
export function parseArpingOutput(stdout: string, address: string, fallbackError?: string): ParsedArping {
  const match = REPLY.exec(stdout ?? '')
  if (match && match[1] === address) {
    const latency = parseFloat(match[3])
    if (Number.isFinite(latency)) return { received: true, latency, mac: match[2].toUpperCase() }
  }
  return { received: false, latency: null, error: fallbackError }
}

/**
 * Why `arping` could not run at all, in words for the reading, or null when it
 * ran and nothing answered. Exit 1 is no reply; anything else, or something
 * on stderr, means it never asked.
 */
export function arpingFailure(exitCode: number | string | undefined, stderr: string): string | null {
  if (exitCode === 'ENOENT') return 'arping is not installed on this machine. Install iputils-arping.'
  if (exitCode === 'EPERM' || exitCode === 'EACCES' || /operation not permitted|permission denied/i.test(stderr ?? '')) {
    return 'arping is not allowed to send ARP here: it needs the CAP_NET_RAW capability.'
  }
  if (exitCode === undefined || exitCode === 0 || exitCode === 1) return null
  const said = (stderr ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return said ? said.replace(/^arping:\s*/, '') : `arping failed (${exitCode})`
}
