import { describe, expect, it } from 'vitest'
import { bucketWidthFor, buildSeries, MAX_CHART_POINTS } from './series'
import type { BucketedMeasurement } from '@/types/probe'

const MINUTE = 60_000
const base = Date.parse('2026-08-19T12:00:00.000Z')

function bucket(offsetMinutes: number, over: Partial<BucketedMeasurement> = {}): BucketedMeasurement {
  return {
    timestamp: new Date(base + offsetMinutes * MINUTE),
    sampleCount: 1,
    latency: 10,
    minLatency: 10,
    maxLatency: 10,
    p10Latency: 10,
    p25Latency: 10,
    p50Latency: 10,
    p75Latency: 10,
    p90Latency: 10,
    packetLoss: 0,
    maxPacketLoss: 0,
    jitter: 1,
    isOnline: true,
    ...over,
  }
}

/** Probes every 5 minutes, with the drift a 10-second scheduler tick produces. */
function drifting(count: number): BucketedMeasurement[] {
  const drift = [0, 0, 3000, 0, 8000, 2000, 0, 8000]
  return Array.from({ length: count }, (_, i) =>
    bucket(0, { timestamp: new Date(base + i * 5 * MINUTE + drift[i % drift.length]) })
  )
}

const FIVE_MIN_PROBE = 300

describe('bucketWidthFor', () => {
  it('degenerates to sub-probe resolution for short windows', () => {
    // One hour over 400 points is ~9s: below any probe interval, so each bucket
    // holds a single probe and the chart shows raw measurements.
    expect(bucketWidthFor(60 * 60_000)).toBeLessThan(30_000)
  })

  it('aggregates meaningfully for long windows', () => {
    const width = bucketWidthFor(30 * 24 * 60 * 60_000)
    expect(width).toBeGreaterThan(60 * 60_000)
  })

  it('never returns a width below one second', () => {
    expect(bucketWidthFor(100, MAX_CHART_POINTS)).toBe(1000)
  })

  it('keeps the point count within the requested budget', () => {
    const windowMs = 7 * 24 * 60 * 60_000
    expect(Math.ceil(windowMs / bucketWidthFor(windowMs, 400))).toBeLessThanOrEqual(400)
  })
})

describe('buildSeries', () => {
  it('returns nothing for no buckets', () => {
    expect(buildSeries([], FIVE_MIN_PROBE, 9000)).toEqual([])
  })

  it('passes buckets through one-for-one', () => {
    const series = buildSeries(drifting(12), FIVE_MIN_PROBE, 9000)
    expect(series).toHaveLength(12)
    expect(series.every(p => p.sampleCount === 1)).toBe(true)
  })

  it('does not break the line for scheduler drift', () => {
    // The regression this guards: snapping probes to a grid whose spacing
    // equals the probe interval produced empty cells purely from drift, and
    // every empty cell rendered as a gap even though nothing had been missed.
    const series = buildSeries(drifting(12), FIVE_MIN_PROBE, 9000)
    expect(series.filter(p => p.sampleCount === 0)).toHaveLength(0)
  })

  it('breaks the line where probing genuinely stopped', () => {
    const series = buildSeries(
      [bucket(0), bucket(5), bucket(10), bucket(40), bucket(45)],
      FIVE_MIN_PROBE,
      9000
    )

    const gaps = series.filter(p => p.sampleCount === 0)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].latency).toBeNull()
    expect(gaps[0].packetLoss).toBeNull()
    expect(gaps[0].timestamp.getTime()).toBeGreaterThan(base + 10 * MINUTE)
    expect(gaps[0].timestamp.getTime()).toBeLessThan(base + 40 * MINUTE)
  })

  it('uses the coarser of probe interval and bucket width to judge a gap', () => {
    // Hourly buckets from a 5-minute probe: consecutive buckets are an hour
    // apart by construction and must not each count as a missed probe.
    const hourly = [bucket(0), bucket(60), bucket(120), bucket(180)]
    const series = buildSeries(hourly, FIVE_MIN_PROBE, 60 * MINUTE)
    expect(series.filter(p => p.sampleCount === 0)).toHaveLength(0)
  })

  it('orders output by time even when the API returns it unsorted', () => {
    const series = buildSeries([bucket(10), bucket(0), bucket(5)], FIVE_MIN_PROBE, 9000)
    const times = series.map(p => p.timestamp.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('preserves a partial-loss reading rather than rounding to online/offline', () => {
    const series = buildSeries([bucket(0, { packetLoss: 75, isOnline: true })], FIVE_MIN_PROBE, 9000)
    expect(series[0].packetLoss).toBe(75)
    expect(series[0].isOnline).toBe(true)
  })

  it('carries a fully failed bucket through as offline', () => {
    const series = buildSeries(
      [bucket(0, { packetLoss: 100, latency: null, isOnline: false })],
      FIVE_MIN_PROBE,
      9000
    )
    expect(series[0].isOnline).toBe(false)
    expect(series[0].latency).toBeNull()
    // Distinct from a gap: a probe ran, it just got nothing back.
    expect(series[0].sampleCount).toBe(1)
  })

  it('ignores buckets with an unparseable timestamp', () => {
    const bad = bucket(0, { timestamp: new Date('nonsense') })
    expect(buildSeries([bad, bucket(5)], FIVE_MIN_PROBE, 9000)).toHaveLength(1)
  })

  it('carries the latency spread through for the smoke bands', () => {
    const series = buildSeries(
      [bucket(0, { minLatency: 4, latency: 10, maxLatency: 90 })],
      FIVE_MIN_PROBE,
      9000
    )
    expect(series[0].minLatency).toBe(4)
    expect(series[0].maxLatency).toBe(90)
  })

  it('leaves the spread null on a gap row so no band is drawn across it', () => {
    const series = buildSeries([bucket(0), bucket(40)], FIVE_MIN_PROBE, 9000)
    const gap = series.find(p => p.sampleCount === 0)!
    expect(gap.minLatency).toBeNull()
    expect(gap.maxLatency).toBeNull()
  })

  it('keeps the sample count so the tooltip can report how many probes it covers', () => {
    const series = buildSeries([bucket(0, { sampleCount: 37 })], FIVE_MIN_PROBE, 60 * MINUTE)
    expect(series[0].sampleCount).toBe(37)
  })
})
