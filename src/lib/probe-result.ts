import type { ProbeDetails, ProbeMeasurement, ProbeResult } from '@/types/probe';
import { FAMILY_LABEL } from './host';
import { jitterFromLatencies, mean, percentile, round } from './metrics';

/**
 * Turning a probe's raw samples into the result every probe reports.
 *
 * Ping, TCP, HTTP and DNS probes all do the same thing at this level — make a
 * number of attempts, time the ones that succeed — so they share one
 * definition of loss, latency and jitter. A reading labelled "5% loss" then
 * means the same on every kind of target:
 *
 *   packetLoss = (attempted - answered) / attempted * 100
 *   latency    = mean time of the attempts that were answered
 *   jitter     = mean absolute difference between consecutive times
 */

interface ProbeSamples {
  targetId: string;
  timestamp: Date;
  /** Time taken by each attempt that succeeded, in milliseconds, in order. */
  latencies: number[];
  /** Attempts actually made. Attempts abandoned at a deadline are not counted. */
  attempted: number;
  /** Reported when every attempt failed. */
  failureReason: string;
  resolvedAddress?: string;
  details?: ProbeDetails;
}

/** A probe that could not make a single attempt: bad target, name did not resolve. */
export function failedProbe(
  targetId: string,
  timestamp: Date,
  errorMessage: string,
  extra: Pick<ProbeResult, 'resolvedAddress' | 'details'> = {}
): ProbeResult {
  return {
    targetId,
    timestamp,
    latency: null,
    packetLoss: 100,
    jitter: null,
    success: false,
    errorMessage,
    ...extra,
  };
}

export function summarizeProbe(samples: ProbeSamples): ProbeResult {
  const { targetId, timestamp, latencies, attempted, resolvedAddress, details } = samples;
  const answered = latencies.length;
  const stat = (value: number | null) => (value === null ? null : round(value, 2));

  return {
    targetId,
    timestamp,
    latency: stat(mean(latencies)),
    // The extremes of the individual attempts, not of the probe averages. This
    // is what makes the smoke band show real delay distribution: a path
    // averaging 20ms while individual packets range 8–400ms is unusable, and
    // the mean alone cannot say so.
    minLatency: answered > 0 ? round(Math.min(...latencies), 2) : null,
    maxLatency: answered > 0 ? round(Math.max(...latencies), 2) : null,
    // Percentiles turn the band from a pair of edges into a distribution: they
    // are what shows a path whose packets mostly arrive together but
    // occasionally do not, as distinct from one that is uniformly erratic.
    p10Latency: stat(percentile(latencies, 10)),
    p25Latency: stat(percentile(latencies, 25)),
    p50Latency: stat(percentile(latencies, 50)),
    p75Latency: stat(percentile(latencies, 75)),
    p90Latency: stat(percentile(latencies, 90)),
    packetLoss: round(((attempted - answered) / attempted) * 100, 2),
    jitter: stat(jitterFromLatencies(latencies)),
    success: answered > 0,
    errorMessage: answered === 0 ? samples.failureReason : undefined,
    resolvedAddress,
    details,
  };
}

/** The stored form of a result. */
export function measurementFrom(id: string, result: ProbeResult): ProbeMeasurement {
  return {
    id,
    targetId: result.targetId,
    timestamp: result.timestamp,
    latency: result.latency,
    minLatency: result.minLatency ?? null,
    maxLatency: result.maxLatency ?? null,
    p10Latency: result.p10Latency ?? null,
    p25Latency: result.p25Latency ?? null,
    p50Latency: result.p50Latency ?? null,
    p75Latency: result.p75Latency ?? null,
    p90Latency: result.p90Latency ?? null,
    // `??`, not `||`: a jitter of exactly 0 is a perfectly stable path, not a
    // missing reading, and 0% loss is not the same as "unknown".
    packetLoss: result.packetLoss ?? 0,
    jitter: result.jitter ?? null,
    success: result.success,
    errorMessage: result.errorMessage,
    details: result.details,
    family: result.family,
  };
}

function worst(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number');
  return known.length > 0 ? Math.max(...known) : null;
}

/**
 * One round's results as a single reading, taking the worse of each figure.
 *
 * This is what a dual-stack target's alert rules are judged on. A rule's run
 * of consecutive breaches is counted per round, and the two families report
 * in the same round: fed to the rule one after the other, a healthy IPv4
 * reading would reset the count a failing IPv6 one had just started, and the
 * rule could never fire. Judged on the worse of the pair, it fires when
 * either family is in trouble, and the message says which.
 */
export function worstOf(results: ProbeResult[]): ProbeResult {
  if (results.length === 1) return results[0];

  const failures = results
    .filter(result => !result.success && result.errorMessage)
    .map(result => (result.family ? `${FAMILY_LABEL[result.family]}: ` : '') + result.errorMessage);
  const expiries = results
    .map(result => result.details?.certExpiresAt)
    .filter((value): value is number => value !== undefined);
  const addresses = results.map(result => result.resolvedAddress).filter(Boolean);

  return {
    targetId: results[0].targetId,
    timestamp: results[0].timestamp,
    latency: worst(results.map(result => result.latency)),
    packetLoss: worst(results.map(result => result.packetLoss)) ?? 0,
    jitter: worst(results.map(result => result.jitter)),
    success: results.every(result => result.success),
    errorMessage: failures.length > 0 ? failures.join('; ') : undefined,
    resolvedAddress: addresses.length > 0 ? addresses.join(', ') : undefined,
    // The certificate that runs out first is the one to be warned about.
    details: expiries.length > 0 ? { certExpiresAt: Math.min(...expiries) } : undefined,
  };
}

/** `ms` spent since `startedAt`, on the sub-millisecond clock. */
export function elapsedSince(startedAt: number): number {
  return round(performance.now() - startedAt, 2);
}

/** Pause between attempts. */
export function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
