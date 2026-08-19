import { Resolver } from 'dns/promises';
import { ProbeResult } from '@/types/probe';
import { jitterFromLatencies, mean, percentile, round } from './metrics';

interface DnsOptions {
  recordType?: 'A' | 'AAAA' | 'MX' | 'TXT' | 'NS' | 'CNAME';
  /** Per-query timeout, in milliseconds. */
  timeout?: number;
  /** Queries per probe. */
  count?: number;
  /** Delay between consecutive queries, in milliseconds. */
  interval?: number;
  /** Name resolved when the target is itself a DNS server. */
  probeName?: string;
}

const DEFAULTS = {
  recordType: 'A',
  timeout: 5000,
  count: 5,
  interval: 50,
  probeName: 'example.com',
} as const;

/** Loose check that a string looks like a resolvable name (not an IP literal). */
export function isValidHostname(host: string): boolean {
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  return /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(trimmed);
}

function isIpLiteral(host: string): boolean {
  const trimmed = host.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    return trimmed.split('.').every(part => Number(part) <= 255);
  }
  return /^[0-9a-fA-F:]+$/.test(trimmed) && trimmed.includes(':');
}

/**
 * Execute a DNS probe.
 *
 * The target may be either a *name to resolve* (using the system resolver) or a
 * *DNS server to query* (an IP literal, in which case a known name is resolved
 * through that server). Distinguishing the two matters: sending an IP address
 * to `resolve()` would fail every time and report a permanently dead target.
 *
 * Reports the same three metrics as the ping probe, so that packet loss means
 * the same thing on both: the fraction of requests that got no answer.
 */
export async function executeDnsProbe(
  targetId: string,
  host: string,
  options: DnsOptions = {}
): Promise<ProbeResult> {
  const recordType = options.recordType ?? DEFAULTS.recordType;
  const timeout = Math.max(100, options.timeout ?? DEFAULTS.timeout);
  const count = Math.max(1, Math.floor(options.count ?? DEFAULTS.count));
  const interval = Math.max(0, options.interval ?? DEFAULTS.interval);
  const probeName = options.probeName ?? DEFAULTS.probeName;

  const timestamp = new Date();
  const trimmedHost = host.trim();

  const resolver = new Resolver({ timeout, tries: 1 });
  let queryName = trimmedHost;

  if (isIpLiteral(trimmedHost)) {
    // The target is a nameserver: ask it to resolve a known name.
    resolver.setServers([trimmedHost]);
    queryName = probeName;
  } else if (!isValidHostname(trimmedHost)) {
    return {
      targetId,
      timestamp,
      latency: null,
      packetLoss: 100,
      jitter: null,
      success: false,
      errorMessage: `Invalid DNS target: ${host}`,
    };
  }

  const latencies: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < count; i++) {
    const startTime = Date.now();

    try {
      // The resolver enforces `timeout` itself, so there is no dangling timer
      // left running after a fast answer (a Promise.race would leak one).
      await resolver.resolve(queryName, recordType);
      latencies.push(Date.now() - startTime);
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'DNS query failed';
    }

    if (i < count - 1 && interval > 0) {
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  const received = latencies.length;
  const packetLoss = round(((count - received) / count) * 100, 2);
  const avgLatency = received > 0 ? round(mean(latencies)!, 2) : null;
  const jitter = received > 1 ? round(jitterFromLatencies(latencies)!, 2) : null;

  console.log(
    `[DNS] ${trimmedHost}: queries=${count} answered=${received} loss=${packetLoss}% ` +
    `avg=${avgLatency ?? '-'}ms jitter=${jitter ?? '-'}ms`
  );

  return {
    targetId,
    timestamp,
    latency: avgLatency,
    minLatency: received > 0 ? Math.min(...latencies) : null,
    maxLatency: received > 0 ? Math.max(...latencies) : null,
    p10Latency: received > 0 ? percentile(latencies, 10) : null,
    p25Latency: received > 0 ? percentile(latencies, 25) : null,
    p50Latency: received > 0 ? percentile(latencies, 50) : null,
    p75Latency: received > 0 ? percentile(latencies, 75) : null,
    p90Latency: received > 0 ? percentile(latencies, 90) : null,
    packetLoss,
    jitter,
    success: received > 0,
    errorMessage: received === 0 ? lastError ?? 'All DNS queries failed' : undefined,
  };
}
