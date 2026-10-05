import { Resolver } from 'dns/promises';
import type { DnsRecordType, ProbeConfig, ProbeIpVersion, ProbeResult } from '@/types/probe';
import { classifyHost, normalizeHost } from './host';
import { DEFAULT_DNS_QUERY_NAME } from './probe-config';
import { elapsedSince, failedProbe, pause, summarizeProbe } from './probe-result';
import { resolveHost } from './resolve';

interface DnsOptions extends Pick<ProbeConfig, 'queryName' | 'recordType' | 'expectedAnswer'> {
  /**
   * For a name target, the address family to resolve to. For a server target
   * with no `recordType`, `ipv6` asks for AAAA instead of A.
   */
  ipVersion?: ProbeIpVersion;
  /** Per-query timeout, in milliseconds. */
  timeout?: number;
  /** Queries per probe. */
  count?: number;
  /** Delay between consecutive queries, in milliseconds. */
  interval?: number;
}

const DEFAULTS = {
  timeout: 5000,
  count: 5,
  interval: 50,
} as const;

/**
 * Error codes that are still an answer. A nameserver replying "no such name"
 * or "no record of that type" has done its job promptly; only silence or an
 * outright failure says anything about the server's health.
 */
const NEGATIVE_ANSWERS = new Set(['ENOTFOUND', 'ENODATA']);

type QueryOutcome = { answered: true; answers: string[] } | { answered: false; error: string };

/** Reduce whatever shape a record type comes back in to comparable strings. */
export function flattenAnswers(records: unknown): string[] {
  if (!Array.isArray(records)) return [];

  return records.map(record => {
    if (typeof record === 'string') return record;
    // TXT records arrive as arrays of chunks that belong together.
    if (Array.isArray(record)) return record.join('');
    if (record && typeof record === 'object') {
      const fields = record as Record<string, unknown>;
      // MX carries a priority alongside the name that matters.
      return String(fields.exchange ?? fields.value ?? fields.address ?? JSON.stringify(fields));
    }
    return String(record);
  });
}

/**
 * Whether the answers include the expected value.
 *
 * Names compare without case or a trailing dot, since both vary between
 * servers for the same record. TXT matches on a substring: the usual check is
 * for one token ("v=spf1", a verification code) inside a longer record.
 */
export function answersInclude(answers: string[], expected: string, recordType: DnsRecordType): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');
  const wanted = normalize(expected);

  return answers.some(answer =>
    recordType === 'TXT' ? normalize(answer).includes(wanted) : normalize(answer) === wanted
  );
}

/**
 * One query against a specific nameserver, bypassing the system resolver
 * entirely so the timing is that server's and nobody else's cache.
 */
function nameserverQuery(server: string, name: string, recordType: DnsRecordType, timeout: number) {
  // The resolver enforces `timeout` itself, so there is no dangling timer left
  // running after a fast answer.
  const resolver = new Resolver({ timeout, tries: 1 });
  resolver.setServers([server]);

  return async (): Promise<QueryOutcome> => {
    try {
      return { answered: true, answers: flattenAnswers(await resolver.resolve(name, recordType)) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && NEGATIVE_ANSWERS.has(code)) return { answered: true, answers: [] };
      return { answered: false, error: error instanceof Error ? error.message : 'DNS query failed' };
    }
  };
}

/**
 * One lookup of a name through the system resolver.
 *
 * Deliberately the same path every other program on the machine takes — hosts
 * file, VPN or encrypted-DNS client and OS cache included — rather than a
 * direct query to whichever servers the DNS library believes are configured.
 * On machines where a local proxy or VPN handles DNS that list is wrong, and
 * every direct query was refused while the name resolved fine for everything
 * else.
 */
function systemLookup(name: string, ipVersion: ProbeIpVersion | undefined, timeout: number) {
  return async (): Promise<QueryOutcome> => {
    const resolved = await resolveHost(name, ipVersion, { timeoutMs: timeout });
    return resolved.ok
      ? { answered: true, answers: resolved.addresses }
      : { answered: false, error: resolved.error };
  };
}

/**
 * Execute a DNS probe.
 *
 * The target may be either a *DNS server to query* (an IP literal, in which
 * case a name is resolved through that server) or a *name to resolve* (through
 * the system resolver). Distinguishing the two matters: sending an IP address
 * to be resolved would fail every time and report a permanently dead target.
 *
 * The two also differ in what counts as a reply. A nameserver that answers
 * "no such name" has answered, so that is a success for a server target; for a
 * name target the name failing to resolve is the very thing being watched for.
 *
 * With an expected answer set, a reply only counts if it contains that value.
 * That turns the probe from "does this server answer" into "does my record
 * still point where it should" — the failure a hijacked or half-finished DNS
 * change produces, in which every server answers promptly and wrongly.
 *
 * Unlike the ping probe nothing here sends ICMP: the latency is the time a DNS
 * query takes to come back, which is why a target can ping in 3ms and still
 * show a slow or failing DNS probe.
 *
 * Reports the same three metrics as the ping probe, so that packet loss means
 * the same thing on both: the fraction of requests that got no usable answer.
 */
export async function executeDnsProbe(
  targetId: string,
  host: string,
  options: DnsOptions = {}
): Promise<ProbeResult> {
  const timeout = Math.max(100, options.timeout ?? DEFAULTS.timeout);
  const count = Math.max(1, Math.floor(options.count ?? DEFAULTS.count));
  const interval = Math.max(0, options.interval ?? DEFAULTS.interval);
  const { expectedAnswer } = options;

  const timestamp = new Date();
  const trimmedHost = normalizeHost(host);
  const kind = classifyHost(trimmedHost);

  let query: () => Promise<QueryOutcome>;
  let description: string;
  let recordType: DnsRecordType;

  if (kind === 'ipv4' || kind === 'ipv6') {
    const queryName = options.queryName ?? DEFAULT_DNS_QUERY_NAME;
    recordType = options.recordType ?? (options.ipVersion === 'ipv6' ? 'AAAA' : 'A');
    try {
      query = nameserverQuery(trimmedHost, queryName, recordType, timeout);
    } catch {
      // A scoped link-local address ("fe80::1%eth0") is a valid thing to ping
      // but not something the resolver library can be pointed at.
      return failedProbe(targetId, timestamp, `Invalid DNS target: ${host}`);
    }
    description = `${recordType} ${queryName} @${trimmedHost}`;
  } else if (kind === 'hostname') {
    recordType = options.ipVersion === 'ipv6' ? 'AAAA' : 'A';
    query = systemLookup(trimmedHost, options.ipVersion, timeout);
    description = `resolve ${trimmedHost}`;
  } else {
    return failedProbe(targetId, timestamp, `Invalid DNS target: ${host}`);
  }

  const latencies: number[] = [];
  let lastError: string | undefined;
  let answers: string[] | undefined;

  for (let i = 0; i < count; i++) {
    // Sub-millisecond clock: a cached answer from a nearby resolver comes back
    // faster than Date.now() can tell apart from zero.
    const startedAt = performance.now();
    const outcome = await query();
    const latency = elapsedSince(startedAt);

    if (!outcome.answered) {
      lastError = outcome.error;
    } else {
      answers = outcome.answers;
      if (expectedAnswer && !answersInclude(outcome.answers, expectedAnswer, recordType)) {
        const got = outcome.answers.length > 0 ? outcome.answers.join(', ') : 'no records';
        lastError = `Unexpected answer: got ${got}, expected ${expectedAnswer}`;
      } else {
        latencies.push(latency);
      }
    }

    if (i < count - 1 && interval > 0) await pause(interval);
  }

  const result = summarizeProbe({
    targetId,
    timestamp,
    latencies,
    attempted: count,
    failureReason: lastError ?? 'All DNS queries failed',
    // For a name target, the first address is where the name points.
    resolvedAddress: kind === 'hostname' ? answers?.[0] : undefined,
    // A sample for display: a TXT lookup can return dozens of long records.
    details: answers ? { answers: answers.slice(0, 6).map(answer => answer.slice(0, 120)) } : undefined,
  });

  console.log(
    `[DNS] ${description}: queries=${count} answered=${latencies.length} loss=${result.packetLoss}% ` +
    `avg=${result.latency ?? '-'}ms jitter=${result.jitter ?? '-'}ms`
  );

  return result;
}
