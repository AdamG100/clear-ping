import type { ProbeResult } from '@/types/probe';

/**
 * What most likely broke, from what the failing reading said, in a few words
 * for a notification: "the connection was refused", "its certificate has
 * expired". Null when the reading does not say. Only a guess from the message
 * a probe gave, so the notification says "likely".
 */
export function likelyCause(result: Pick<ProbeResult, 'success' | 'errorMessage' | 'details' | 'packetLoss' | 'latency'>, now: number): string | null {
  const expires = result.details?.certExpiresAt;
  if (expires !== undefined && expires <= now) return 'its certificate has expired';

  const status = result.details?.statusCode;
  if (status !== undefined && status >= 400) return `it answered with HTTP ${status}`;

  const message = result.errorMessage ?? '';
  if (/refused/i.test(message)) return 'the connection was refused';
  if (/certificate|\btls\b|\bssl\b/i.test(message)) return 'there is a problem with its certificate';
  if (/enotfound|nxdomain|not found|could not resolve|did not resolve|getaddrinfo/i.test(message)) return 'its name did not resolve';
  if (/unexpected|different answer|did not match|wrong answer/i.test(message)) return 'it gave a different answer from the one expected';
  if (/time(d)? ?out|etimedout/i.test(message)) return 'it did not answer in time';
  if (!result.success && (result.packetLoss ?? 100) >= 100 && result.latency === null) return 'it did not answer';
  return null;
}

/**
 * Where the trouble is seen from, when that is a part of the picture: "seen
 * from Europe only", when the probes in breach all share one labelled region and
 * others that are reporting are fine. Null when it is everywhere, or unlabelled.
 */
export function whereSeen(probes: Array<{ inBreach: boolean; silent: boolean; region?: string }>): string | null {
  const reporting = probes.filter(probe => !probe.silent);
  const breaching = reporting.filter(probe => probe.inBreach);
  if (breaching.length === 0 || breaching.length === reporting.length) return null;
  const regions = new Set(breaching.map(probe => probe.region));
  const [only] = [...regions];
  return regions.size === 1 && only ? `seen from ${only} only` : null;
}

/** The two joined for a notification, or null when there is nothing to say. */
export function describeCause(cause: string | null, where: string | null): string | null {
  const parts = [cause, where].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join('; ') : null;
}
