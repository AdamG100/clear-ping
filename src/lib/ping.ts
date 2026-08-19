import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProbeResult } from '@/types/probe';
import { jitterFromLatencies, mean, percentile, round } from './metrics';
import { isValidPingHost, parsePingOutput, pingArgs } from './ping-parse';

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
}

const DEFAULTS = {
  count: 20,
  timeout: 1000,
  interval: 10,
} as const;

/** Send one echo request and parse the reply. */
async function sendPacket(host: string, timeoutMs: number) {
  const args = pingArgs(host, timeoutMs);
  let stdout = '';
  let failure: string | undefined;

  try {
    const result = await execFileAsync('ping', args, {
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

  if (!isValidPingHost(host)) {
    return {
      targetId,
      timestamp,
      latency: null,
      packetLoss: 100,
      jitter: null,
      success: false,
      errorMessage: `Invalid host: ${host}`,
    };
  }

  const trimmedHost = host.trim();
  const deadline = Date.now() + maxDuration;

  let sent = 0;
  let received = 0;
  const latencies: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < count; i++) {
    if (Date.now() >= deadline) {
      console.warn(`[Ping] ${trimmedHost}: deadline reached after ${sent}/${count} packets`);
      break;
    }

    sent++;
    const packet = await sendPacket(trimmedHost, timeout);

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
    return {
      targetId,
      timestamp,
      latency: null,
      packetLoss: 100,
      jitter: null,
      success: false,
      errorMessage: 'Probe deadline exceeded before any packet was sent',
    };
  }

  const packetLoss = round(((sent - received) / sent) * 100, 2);
  const avgLatency = received > 0 ? round(mean(latencies)!, 2) : null;
  const jitter = latencies.length > 1 ? round(jitterFromLatencies(latencies)!, 2) : null;

  console.log(
    `[Ping] ${trimmedHost}: sent=${sent} received=${received} loss=${packetLoss}% ` +
    `avg=${avgLatency ?? '-'}ms jitter=${jitter ?? '-'}ms`
  );

  return {
    targetId,
    timestamp,
    latency: avgLatency,
    // The extremes of the individual packets, not of the probe averages. This
    // is what makes the smoke band show real delay distribution: a path
    // averaging 20ms while individual packets range 8–400ms is unusable, and
    // the mean alone cannot say so.
    minLatency: received > 0 ? round(Math.min(...latencies), 2) : null,
    maxLatency: received > 0 ? round(Math.max(...latencies), 2) : null,
    // Percentiles turn the band from a pair of edges into a distribution: they
    // are what shows a path whose packets mostly arrive together but
    // occasionally do not, as distinct from one that is uniformly erratic.
    p10Latency: received > 0 ? round(percentile(latencies, 10)!, 2) : null,
    p25Latency: received > 0 ? round(percentile(latencies, 25)!, 2) : null,
    p50Latency: received > 0 ? round(percentile(latencies, 50)!, 2) : null,
    p75Latency: received > 0 ? round(percentile(latencies, 75)!, 2) : null,
    p90Latency: received > 0 ? round(percentile(latencies, 90)!, 2) : null,
    packetLoss,
    jitter,
    success: received > 0,
    errorMessage: received === 0 ? lastError ?? 'All packets lost' : undefined,
  };
}

/**
 * Ping several targets concurrently.
 *
 * Concurrency is bounded so a large target list cannot spawn hundreds of
 * `ping` processes at once, which would distort the very latencies it is
 * trying to measure.
 */
export async function pingMultipleTargets(
  targets: Array<{ id: string; host: string }>,
  options: PingOptions = {},
  concurrency = 8
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array(targets.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      const target = targets[index];
      results[index] = await executePing(target.id, target.host, options);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker)
  );

  console.log(
    `[Ping] Probed ${targets.length} targets: ` +
    `${results.filter(r => r.success).length} reachable`
  );

  return results;
}
