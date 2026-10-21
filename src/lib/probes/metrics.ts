/**
 * Shared statistical helpers for probe measurements.
 *
 * These are used both server-side (ping/DNS probes) and client-side (dashboard
 * stats) so that a value labelled "jitter" or "median" means the same thing
 * everywhere in the app.
 */

/** Arithmetic mean. Returns null for an empty sample. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** True median (average of the middle two for an even-sized sample). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Jitter — mean absolute difference between *consecutive* samples.
 *
 * This is the packet delay variation described by RFC 3550, and is what
 * "jitter" means for a network path. (Deviation from the mean is a different
 * quantity: it reports a large value for a path whose latency drifts smoothly,
 * even though consecutive packets arrive evenly spaced.)
 *
 * Requires at least two samples; returns null otherwise.
 */
export function jitterFromLatencies(latencies: number[]): number | null {
  if (latencies.length < 2) return null;
  let total = 0;
  for (let i = 1; i < latencies.length; i++) {
    total += Math.abs(latencies[i] - latencies[i - 1]);
  }
  return total / (latencies.length - 1);
}

/** Clamp a packet-loss value into the 0–100 range, mapping non-numbers to null. */
export function normalizeLossPercent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/** Round to a fixed number of decimals without accumulating float noise. */
export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Linear-interpolated percentile, matching the common "type 7" definition.
 *
 * Used to record the shape of a probe's round-trip times, not just its
 * extremes: min and max alone describe a distribution's edges but say nothing
 * about where the packets actually clustered, which is exactly what the smoke
 * band exists to show.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);

  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** The percentile pairs the smoke band is drawn from, widest first. */
export const SMOKE_PERCENTILES = [10, 25, 75, 90] as const;
