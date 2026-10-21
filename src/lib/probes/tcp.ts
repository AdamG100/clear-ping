import net from 'net';
import type { ProbeIpVersion, ProbeResult } from '@/types/probe';
import { classifyHost, normalizeHost, type AddressFamily } from './host';
import { elapsedSince, failedProbe, pause, summarizeProbe } from './result';
import { resolveHost } from './resolve';

/**
 * TCP connect probe.
 *
 * Opens a connection to a port, times the handshake, and closes it without
 * sending anything. That answers two things a ping cannot: whether the service
 * is actually listening, and what the path looks like to hosts that drop or
 * deprioritise ICMP.
 *
 *   packetLoss = share of connection attempts that did not complete
 *   latency    = mean time to complete the handshake
 *
 * A refused connection fails fast and a filtered one times out; both are
 * failed attempts, but the error message keeps them apart, because "nothing is
 * listening" and "something is dropping the packets" are different faults.
 */

export interface TcpOptions {
  port: number;
  /** Connection attempts per probe. */
  count?: number;
  /** Per-attempt timeout, in milliseconds. */
  timeout?: number;
  /** Delay between consecutive attempts, in milliseconds. */
  interval?: number;
  /** Address family to resolve a domain target to. Ignored for IP literals. */
  ipVersion?: ProbeIpVersion;
}

/**
 * Fewer attempts than a ping, further apart: each one is a full connection the
 * far end has to accept and tear down, not a packet it can answer statelessly.
 */
const DEFAULTS = {
  count: 10,
  timeout: 2000,
  interval: 100,
} as const;

const REASONS: Record<string, string> = {
  ECONNREFUSED: 'Connection refused (nothing is listening on the port)',
  ETIMEDOUT: 'Connection timed out',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ECONNRESET: 'Connection reset',
};

type Attempt = { ok: true; latency: number } | { ok: false; error: string };

/** Open one connection and report how long the handshake took. */
function connectOnce(address: string, family: AddressFamily, port: number, timeoutMs: number): Promise<Attempt> {
  return new Promise(resolve => {
    const startedAt = performance.now();
    const socket = net.connect({ host: address, port, family });

    const finish = (attempt: Attempt) => {
      socket.removeAllListeners();
      // A late error after destroy must not surface as an unhandled exception.
      socket.on('error', () => {});
      socket.destroy();
      resolve(attempt);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, latency: elapsedSince(startedAt) }));
    socket.once('timeout', () => finish({ ok: false, error: REASONS.ETIMEDOUT }));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish({ ok: false, error: REASONS[error.code ?? ''] ?? error.message })
    );
  });
}

export async function executeTcpProbe(
  targetId: string,
  host: string,
  options: TcpOptions
): Promise<ProbeResult> {
  const count = Math.max(1, Math.floor(options.count ?? DEFAULTS.count));
  const timeout = Math.max(100, Math.floor(options.timeout ?? DEFAULTS.timeout));
  const interval = Math.max(0, Math.floor(options.interval ?? DEFAULTS.interval));
  const { port } = options;

  const timestamp = new Date();
  const trimmedHost = normalizeHost(host);
  const kind = classifyHost(trimmedHost);

  if (kind === 'invalid') return failedProbe(targetId, timestamp, `Invalid host: ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return failedProbe(targetId, timestamp, `Invalid port: ${port}`);
  }

  let address = trimmedHost;
  let family: AddressFamily = kind === 'ipv6' ? 6 : 4;

  // Resolved once, for the same reason as the ping probe: every attempt of one
  // probe should be measuring the same server.
  if (kind === 'hostname') {
    const resolved = await resolveHost(trimmedHost, options.ipVersion);
    if (!resolved.ok) {
      console.log(`[TCP] ${trimmedHost}:${port}: ${resolved.error}`);
      return failedProbe(targetId, timestamp, resolved.error);
    }
    address = resolved.address;
    family = resolved.family;
  }

  const latencies: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < count; i++) {
    const attempt = await connectOnce(address, family, port, timeout);

    if (attempt.ok) latencies.push(attempt.latency);
    else lastError = attempt.error;

    if (i < count - 1 && interval > 0) await pause(interval);
  }

  const result = summarizeProbe({
    targetId,
    timestamp,
    latencies,
    attempted: count,
    failureReason: lastError ?? 'All connection attempts failed',
    resolvedAddress: kind === 'hostname' ? address : undefined,
  });

  console.log(
    `[TCP] ${trimmedHost}:${port}${kind === 'hostname' ? ` (${address})` : ''}: ` +
    `attempts=${count} connected=${latencies.length} loss=${result.packetLoss}% ` +
    `avg=${result.latency ?? '-'}ms jitter=${result.jitter ?? '-'}ms`
  );

  return result;
}
