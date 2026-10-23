import type { BucketedMeasurement, DataPoint, TimeWindow } from '@/types/probe'

/** Points beyond this are indistinguishable at typical chart widths. */
export const MAX_CHART_POINTS = 400

/** The most targets one comparison takes: a big group's worth. */
export const MAX_COMPARED_TARGETS = 100

/**
 * About how many points a comparison asks for in all. Shared out among its
 * targets, so a group of a hundred comes back as fast as one of twenty: each
 * line coarser, which on a chart that width loses nothing that can be seen.
 */
const COMPARISON_POINTS = 8000

/** How many points to ask for per target when comparing `targets` of them. */
export function comparisonPointsPer(targets: number): number {
  return Math.max(60, Math.min(MAX_CHART_POINTS, Math.round(COMPARISON_POINTS / Math.max(1, targets))))
}

/** Narrowest window worth asking for: below this there is at most one probe. */
export const MIN_WINDOW_MS = 60_000

/** The widest window served: the longest time range, and a zoom within it. */
const MAX_WINDOW_HOURS = 90 * 24
const MAX_WINDOW_MS = MAX_WINDOW_HOURS * 60 * 60 * 1000

/**
 * Read an explicit `start`/`end` window from request parameters.
 *
 * Returns null unless both are usable, so a caller can fall back to its
 * default window rather than query a nonsensical one: an unparseable bound
 * becomes NaN, and `timestamp >= NaN` silently matches nothing.
 */
export function parseWindow(
  start: string | null,
  end: string | null,
  now: number = Date.now()
): TimeWindow | null {
  if (start === null || end === null) return null

  const from = Number(start)
  const to = Math.min(Number(end), now)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  if (to - from < MIN_WINDOW_MS || to - from > MAX_WINDOW_MS) return null

  return { start: from, end: to }
}

/**
 * The window and bucket width a measurements request is asking for.
 *
 * An explicit `start`/`end` is what zooming into a chart sends; otherwise the
 * window is the last `hours`. Because the bucket width is derived from the
 * window, a narrower window comes back at finer resolution rather than as a
 * crop of the coarse one.
 */
export function windowFromQuery(
  searchParams: URLSearchParams,
  now: number = Date.now()
): TimeWindow & { bucketMs: number } {
  // An unparseable `hours` used to produce a NaN window, which queried
  // `timestamp >= NaN` and silently returned nothing.
  const parsedHours = Number(searchParams.get('hours') ?? 24)
  const hours = Number.isFinite(parsedHours) ? Math.min(MAX_WINDOW_HOURS, Math.max(1, parsedHours)) : 24

  const parsedMaxPoints = Number(searchParams.get('maxPoints') ?? MAX_CHART_POINTS)
  const maxPoints = Number.isFinite(parsedMaxPoints)
    ? Math.min(2000, Math.max(10, Math.floor(parsedMaxPoints)))
    : MAX_CHART_POINTS

  const explicit = parseWindow(searchParams.get('start'), searchParams.get('end'), now)
  const end = explicit?.end ?? now
  const windowMs = explicit ? explicit.end - explicit.start : hours * 60 * 60 * 1000

  return { start: end - windowMs, end, bucketMs: bucketWidthFor(windowMs, maxPoints) }
}

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
