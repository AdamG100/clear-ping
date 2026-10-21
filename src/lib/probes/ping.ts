import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProbeIpVersion, ProbeResult } from '@/types/probe';
import { classifyHost, normalizeHost, type AddressFamily } from './host';
import { parsePingOutput, pingArgs, pingCommand } from './ping-parse';
import { failedProbe, summarizeProbe } from './result';
import { resolveHost } from './resolve';

const execFileAsync = promisify(execFile);

export { isValidPingHost } from './ping-parse';

/**
 * ICMP ping probe.
 *
 * A probe sends `count` echo requests to a host, one at a time, spaced by
 * `interval` ms, and reports:
 *
 *   packetLoss = (sent - received) / sent * 100
 *   latency    = mean RTT of the received packets
 *   jitter     = mean absolute difference between consecutive RTTs
 *
 * An IP target is pinged as given. A domain target is resolved first, once per
 * probe, and the address that came back is what gets pinged (see ./resolve for
 * why the name itself is never handed to `ping`).
 *
 * Design notes:
 *
 * - Every packet in a probe uses the *same* timeout. A per-attempt backoff
 *   would make packets later in the run more forgiving than earlier ones, so
 *   the resulting loss percentage would depend on packet ordering rather than
 *   on the path. Retrying lost packets has the same problem — it hides exactly
 *   the loss the probe exists to measure — so neither is done here.
 * - Packets are only counted as sent once they have actually been attempted.
 *   If the probe hits its overall deadline, the remaining packets are dropped
 *   from both numerator and denominator rather than scored as loss.
 * - The host is passed to `ping` as a separate argv entry (never interpolated
 *   into a shell command line) and is validated first, so a hostname cannot
 *   inject flags or shell metacharacters.
 *
 * Output parsing and argv construction live in ./ping-parse so they can be
 * tested against captured output from all three platforms.
 */

export interface PingOptions {
  /** Echo requests to send per probe. */
  count?: number;
  /** Per-packet reply timeout, in milliseconds. */
  timeout?: number;
  /** Delay between consecutive packets, in milliseconds. */
  interval?: number;
  /** Hard ceiling on the whole probe, in milliseconds. */
  maxDuration?: number;
  /** Address family to resolve a domain target to. Ignored for IP literals. */
  ipVersion?: ProbeIpVersion;
}

const DEFAULTS = {
  count: 20,
  timeout: 1000,
  interval: 10,
} as const;

/** Send one echo request and parse the reply. */
async function sendPacket(address: string, family: AddressFamily, timeoutMs: number) {
  const args = pingArgs(address, timeoutMs, undefined, family);
  let stdout = '';
  let failure: string | undefined;

  try {
    const result = await execFileAsync(pingCommand(undefined, family), args, {
      // Give the child a little slack over the ICMP timeout before we kill it.
      timeout: timeoutMs + 1000,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (error) {
    // A non-zero exit is ordinary packet loss; the useful output is on stdout.
    const e = error as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? '';
    failure = (e.stderr || e.message || 'ping failed').trim();
  }

  return parsePingOutput(stdout, failure);
}

/**
 * Execute a ping probe against a single host.
 */
export async function executePing(
  targetId: string,
  host: string,
  options: PingOptions = {}
): Promise<ProbeResult> {
  const count = Math.max(1, Math.floor(options.count ?? DEFAULTS.count));
  const timeout = Math.max(100, Math.floor(options.timeout ?? DEFAULTS.timeout));
  const interval = Math.max(0, Math.floor(options.interval ?? DEFAULTS.interval));
  const maxDuration = options.maxDuration ?? count * (timeout + interval) + 2000;

  const timestamp = new Date();
  const failed = (errorMessage: string) => failedProbe(targetId, timestamp, errorMessage);

  const trimmedHost = normalizeHost(host);
  const kind = classifyHost(trimmedHost);

  if (kind === 'invalid') {
    return failed(`Invalid host: ${host}`);
  }

  const deadline = Date.now() + maxDuration;

  let address = trimmedHost;
  let family: AddressFamily = kind === 'ipv6' ? 6 : 4;

  if (kind === 'hostname') {
    const resolved = await resolveHost(trimmedHost, options.ipVersion);
    if (!resolved.ok) {
      console.log(`[Ping] ${trimmedHost}: ${resolved.error}`);
      return failed(resolved.error);
    }
    address = resolved.address;
    family = resolved.family;
  }

  // What the log lines call this target: the name, and where it pointed.
  const label = kind === 'hostname' ? `${trimmedHost} (${address})` : trimmedHost;
  const resolvedAddress = kind === 'hostname' ? address : undefined;

  let sent = 0;
  let received = 0;
  const latencies: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < count; i++) {
    if (Date.now() >= deadline) {
      console.warn(`[Ping] ${label}: deadline reached after ${sent}/${count} packets`);
      break;
    }

    sent++;
    const packet = await sendPacket(address, family, timeout);

    if (packet.received && packet.latency !== null) {
      received++;
      latencies.push(packet.latency);
    } else if (packet.error) {
      lastError = packet.error;
    }

    if (i < count - 1 && interval > 0) {
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  // No packet actually went out (deadline already passed) — report that rather
  // than inventing a loss figure from zero samples.
  if (sent === 0) {
    return { ...failed('Probe deadline exceeded before any packet was sent'), resolvedAddress };
  }

  const result = summarizeProbe({
    targetId,
    timestamp,
    latencies,
    attempted: sent,
    failureReason: lastError ?? 'All packets lost',
    resolvedAddress,
  });

  console.log(
    `[Ping] ${label}: sent=${sent} received=${received} loss=${result.packetLoss}% ` +
    `avg=${result.latency ?? '-'}ms jitter=${result.jitter ?? '-'}ms`
  );

  return result;
}
