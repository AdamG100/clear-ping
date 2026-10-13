import type { DnsRecordType, DnsResolver, DnsResolverReading, ProbeConfig, ProbeIpVersion, ProbeResult } from '@/types/probe';
import { resolverLabel } from './dns-resolvers';
import { openResolverSession, type QueryOutcome, type ResolverSession } from './dns-transport';
import { classifyHost, normalizeHost } from './host';
import { jitterFromLatencies, mean, round } from './metrics';
import { DEFAULT_DNS_QUERY_NAME, DNS_QUERIES_PER_PROBE, isAddressRecord, nameRecordType } from './probe-config';
import { elapsedSince, failedProbe, pause, summarizeProbe } from './probe-result';
import { resolveHost } from './resolve';

interface DnsOptions extends Pick<ProbeConfig, 'queryName' | 'recordType' | 'expectedAnswer' | 'resolvers'> {
  /**
   * For a name target, the address family to resolve to. For a server target
   * with no `recordType`, `ipv6` asks for AAAA instead of A.
   */
  ipVersion?: ProbeIpVersion;
  /** Per-query timeout, in milliseconds. */
  timeout?: number;
  /** Queries per probe, to each resolver. */
  count?: number;
  /** Delay between consecutive queries, in milliseconds. */
  interval?: number;
}

const DEFAULTS = {
  timeout: 5000,
  count: DNS_QUERIES_PER_PROBE,
  interval: 50,
} as const;

/** How much of an answer is kept for display: a TXT lookup can return dozens of long records. */
const sample = (answers: string[], records = 6, letters = 120) =>
  answers.slice(0, records).map(answer => answer.slice(0, letters));

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

interface Asking {
  recordType: DnsRecordType;
  expectedAnswer?: string;
  /**
   * Set when the name is the thing being watched: an answer with no records in
   * it then says the name is gone, which is the failure, where from a server
   * being watched it only says the server answered.
   */
  mustExist?: string;
  timeout: number;
  count: number;
  interval: number;
}

/** Why an outcome is not a usable answer, or null if it is one. */
function failureOf(outcome: QueryOutcome, asking: Asking): string | null {
  if (!outcome.answered) return outcome.error;

  if (asking.mustExist && outcome.answers.length === 0) {
    return `No ${asking.recordType} record for ${asking.mustExist}`;
  }
  if (asking.expectedAnswer && !answersInclude(outcome.answers, asking.expectedAnswer, asking.recordType)) {
    const got = outcome.answers.length > 0 ? outcome.answers.join(', ') : 'no records';
    return `Unexpected answer: got ${got}, expected ${asking.expectedAnswer}`;
  }
  return null;
}

interface Asked {
  /** Time taken by each query that got a usable answer, in order. */
  latencies: number[];
  /** The last answer that came back, usable or not. */
  answers?: string[];
  /** Why the last failed query failed. */
  lastError?: string;
}

/** Ask the same question `count` times, timing each. */
async function ask(query: ResolverSession['query'], asking: Asking): Promise<Asked> {
  const asked: Asked = { latencies: [] };

  for (let i = 0; i < asking.count; i++) {
    // Sub-millisecond clock: a cached answer from a nearby resolver comes back
    // faster than Date.now() can tell apart from zero.
    const startedAt = performance.now();
    const outcome = await query();
    const latency = elapsedSince(startedAt);

    if (outcome.answered) asked.answers = outcome.answers;
    const failure = failureOf(outcome, asking);
    if (failure) asked.lastError = failure;
    else asked.latencies.push(latency);

    if (i < asking.count - 1 && asking.interval > 0) await pause(asking.interval);
  }
  return asked;
}

/**
 * One lookup of a name through the system resolver, over whichever family the
 * target is set to.
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

/** One resolver's share of a probe that asks several. */
async function askResolver(
  resolver: DnsResolver,
  name: string,
  asking: Asking
): Promise<{ reading: DnsResolverReading; latencies: number[] }> {
  const { protocol } = resolver;
  // What every reading of it says about itself, whether or not it answered.
  const asked = { label: resolverLabel(resolver), protocol, server: resolver.server, sent: asking.count };

  let session: ResolverSession;
  try {
    session = await openResolverSession(resolver, name, asking.recordType, asking.timeout);
  } catch (error) {
    // Not reached at all: every question it would have been asked went unanswered.
    const reason = error instanceof Error && error.message ? error.message : 'Could not reach the resolver';
    return { reading: { ...asked, latency: null, loss: 100, error: reason }, latencies: [] };
  }

  try {
    const replies = await ask(session.query, asking);
    const latency = mean(replies.latencies);

    return {
      latencies: replies.latencies,
      reading: {
        ...asked,
        latency: latency === null ? null : round(latency, 2),
        loss: round(((asking.count - replies.latencies.length) / asking.count) * 100, 2),
        // Fewer and shorter than for a target with one resolver: this is kept
        // once for each of them, with every probe.
        answers: replies.answers ? sample(replies.answers, 4, 80) : undefined,
        connectMs: session.connectMs,
        error: replies.lastError,
      },
    };
  } finally {
    session.close();
  }
}

/**
 * A name looked up through each of several resolvers at once.
 *
 * The result that is charted and judged is all of their queries together: five
 * to each of three resolvers is fifteen queries, and one resolver going quiet
 * is a third of them lost. How each one did is kept beside it, which is what
 * says which resolver that was, and what each of them answered.
 */
async function probeThroughResolvers(
  targetId: string,
  timestamp: Date,
  name: string,
  resolvers: DnsResolver[],
  asking: Asking
): Promise<ProbeResult> {
  // All of them at the same moment: they are being compared, and a resolver
  // asked a few seconds after another is being asked about a different moment.
  const asked = await Promise.all(resolvers.map(resolver => askResolver(resolver, name, asking)));
  const readings = asked.map(each => each.reading);
  const latencies = asked.flatMap(each => each.latencies);

  const failures = readings.filter(reading => reading.error).map(reading => `${reading.label}: ${reading.error}`);
  const firstAnswers = readings.find(reading => reading.answers && reading.answers.length > 0)?.answers;
  const isAddress = isAddressRecord(asking.recordType);

  const summary = summarizeProbe({
    targetId,
    timestamp,
    latencies,
    attempted: asking.count * resolvers.length,
    failureReason: failures.join('; ') || 'All DNS queries failed',
    resolvedAddress: isAddress ? firstAnswers?.[0] : undefined,
    details: { answers: firstAnswers, resolvers: readings },
  });

  // Jitter is how much one query differs from the next to the same resolver.
  // Taken across all of them in a row it would also count the step from one
  // resolver's usual time to the next one's, which is not variation at all.
  const jitters = asked
    .map(each => jitterFromLatencies(each.latencies))
    .filter((jitter): jitter is number => jitter !== null);
  const jitter = mean(jitters);
  const result: ProbeResult = { ...summary, jitter: jitter === null ? null : round(jitter, 2) };

  console.log(
    `[DNS] ${asking.recordType} ${name} via ${readings.map(reading => reading.label).join(', ')}: ` +
    `queries=${asking.count * resolvers.length} answered=${latencies.length} loss=${result.packetLoss}% ` +
    `avg=${result.latency ?? '-'}ms`
  );

  return result;
}

/**
 * Execute a DNS probe.
 *
 * The target may be either a *DNS server to query* (an IP literal, in which
 * case a name is resolved through that server) or a *name to resolve*: through
 * the system resolver, or through each of the resolvers listed for it, which
 * can be asked over plain DNS, DNS over TLS or DNS over HTTPS. Distinguishing
 * a server from a name matters: sending an IP address to be resolved would
 * fail every time and report a permanently dead target.
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
  const timing = {
    timeout: Math.max(100, options.timeout ?? DEFAULTS.timeout),
    count: Math.max(1, Math.floor(options.count ?? DEFAULTS.count)),
    interval: Math.max(0, options.interval ?? DEFAULTS.interval),
  };
  const { expectedAnswer } = options;

  const timestamp = new Date();
  const trimmedHost = normalizeHost(host);
  const kind = classifyHost(trimmedHost);

  if (kind === 'invalid') {
    return failedProbe(targetId, timestamp, `Invalid DNS target: ${host}`);
  }

  // A name with resolvers of its own to be asked through.
  if (kind === 'hostname' && options.resolvers && options.resolvers.length > 0) {
    const recordType = nameRecordType(options.recordType, options.ipVersion);
    return probeThroughResolvers(targetId, timestamp, trimmedHost, options.resolvers, {
      ...timing,
      recordType,
      expectedAnswer,
      mustExist: trimmedHost,
    });
  }

  let session: ResolverSession;
  let description: string;
  let recordType: DnsRecordType;

  if (kind === 'hostname') {
    recordType = options.ipVersion === 'ipv6' ? 'AAAA' : 'A';
    session = { query: systemLookup(trimmedHost, options.ipVersion, timing.timeout), close: () => {} };
    description = `resolve ${trimmedHost}`;
  } else {
    const queryName = options.queryName ?? DEFAULT_DNS_QUERY_NAME;
    recordType = options.recordType ?? (options.ipVersion === 'ipv6' ? 'AAAA' : 'A');
    try {
      session = await openResolverSession({ protocol: 'udp', server: trimmedHost }, queryName, recordType, timing.timeout);
    } catch {
      // A scoped link-local address ("fe80::1%eth0") is a valid thing to ping
      // but not something the resolver library can be pointed at.
      return failedProbe(targetId, timestamp, `Invalid DNS target: ${host}`);
    }
    description = `${recordType} ${queryName} @${trimmedHost}`;
  }

  let asked: Asked;
  try {
    asked = await ask(session.query, { ...timing, recordType, expectedAnswer });
  } finally {
    session.close();
  }

  const result = summarizeProbe({
    targetId,
    timestamp,
    latencies: asked.latencies,
    attempted: timing.count,
    failureReason: asked.lastError ?? 'All DNS queries failed',
    // For a name target, the first address is where the name points.
    resolvedAddress: kind === 'hostname' ? asked.answers?.[0] : undefined,
    details: asked.answers ? { answers: sample(asked.answers) } : undefined,
  });

  console.log(
    `[DNS] ${description}: queries=${timing.count} answered=${asked.latencies.length} loss=${result.packetLoss}% ` +
    `avg=${result.latency ?? '-'}ms jitter=${result.jitter ?? '-'}ms`
  );

  return result;
}
