import type { BucketedMeasurement, DataPoint } from '@/types/probe'

/** Points beyond this are indistinguishable at typical chart widths. */
export const MAX_CHART_POINTS = 400

/**
 * Choose a bucket width for a window.
 *
 * Deliberately degenerates to "no aggregation" for short windows: at one hour
 * this is ~9 seconds, far below any probe interval, so each bucket holds a
 * single probe and the chart shows raw measurements. At thirty days it becomes
 * ~108 minutes and does real work. One rule covers both cases, so there is no
 * threshold at which the chart abruptly changes character.
 */
export function bucketWidthFor(windowMs: number, maxPoints = MAX_CHART_POINTS): number {
  return Math.max(1000, Math.ceil(windowMs / maxPoints))
}

/**
 * Turn aggregated buckets from the API into chart points, inserting an explicit
 * break wherever probing actually stopped.
 *
 * Aggregation itself happens in SQL. Doing it here meant shipping every raw row
 * to the browser — roughly 86,000 per target for a 30-day window at a
 * 30-second interval — just to average them away.
 *
 * Measurements keep the timestamps the database reports. Snapping them to a
 * grid whose spacing equals the probe interval produced empty cells purely from
 * scheduler drift (probes land ~300s, ~303s, ~308s apart), and every empty cell
 * rendered as a gap even though no probe had been missed.
 */
export function buildSeries(
  buckets: BucketedMeasurement[],
  probeIntervalSeconds: number,
  bucketMs: number
): DataPoint[] {
  const sorted = [...buckets]
    .filter(b => Number.isFinite(new Date(b.timestamp).getTime()))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  if (sorted.length === 0) return []

  const points: DataPoint[] = sorted.map(bucket => ({
    timestamp: new Date(bucket.timestamp),
    latency: bucket.latency,
    minLatency: bucket.minLatency,
    maxLatency: bucket.maxLatency,
    p10Latency: bucket.p10Latency,
    p25Latency: bucket.p25Latency,
    p50Latency: bucket.p50Latency,
    p75Latency: bucket.p75Latency,
    p90Latency: bucket.p90Latency,
    packetLoss: bucket.packetLoss,
    jitter: bucket.jitter,
    isOnline: bucket.isOnline,
    sampleCount: bucket.sampleCount,
  }))

  // Expected spacing is whichever is coarser: the probe cadence or the bucket
  // width. Using only one of them breaks the line on every point in the other
  // regime.
  const spacingMs = Math.max(bucketMs, Math.max(1000, probeIntervalSeconds * 1000))
  const gapThreshold = spacingMs * 2.5

  const withGaps: DataPoint[] = []

  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const previous = points[i - 1].timestamp.getTime()
      const delta = points[i].timestamp.getTime() - previous

      if (delta > gapThreshold) {
        // A single null row inside the hole is what makes the chart render a
        // real gap rather than a straight line bridging a period with no data.
        withGaps.push({
          timestamp: new Date(previous + delta / 2),
          latency: null,
          minLatency: null,
          maxLatency: null,
          p10Latency: null,
          p25Latency: null,
          p50Latency: null,
          p75Latency: null,
          p90Latency: null,
          packetLoss: null,
          jitter: null,
          isOnline: null,
          sampleCount: 0,
        })
      }
    }

    withGaps.push(points[i])
  }

  return withGaps
}
