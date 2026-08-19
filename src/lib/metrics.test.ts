import { describe, expect, it } from 'vitest'
import { jitterFromLatencies, mean, median, normalizeLossPercent, percentile, round } from './metrics'

describe('median', () => {
  it('returns the middle value for an odd sample', () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  it('averages the middle pair for an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('does not mutate the caller’s array', () => {
    const input = [3, 1, 2]
    median(input)
    expect(input).toEqual([3, 1, 2])
  })

  it('is unmoved by a single extreme outlier, unlike the midrange', () => {
    const samples = [10, 11, 12, 11, 900]
    const midrange = (Math.min(...samples) + Math.max(...samples)) / 2
    expect(median(samples)).toBe(11)
    expect(midrange).toBe(455) // what the stat card used to display
  })

  it('returns null for an empty sample', () => {
    expect(median([])).toBeNull()
  })
})

describe('jitterFromLatencies', () => {
  it('is zero for a perfectly steady path', () => {
    expect(jitterFromLatencies([10, 10, 10, 10])).toBe(0)
  })

  it('measures variation between consecutive packets', () => {
    // Differences: 5, 5, 5
    expect(jitterFromLatencies([10, 15, 20, 25])).toBe(5)
  })

  it('reports low jitter for a smooth drift that deviation-from-mean would inflate', () => {
    // A path ramping evenly from 10ms to 100ms: consecutive packets are 10ms
    // apart, so delay variation is 10 — but spread around the mean is ~25.
    const ramp = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const avg = mean(ramp)!
    const deviationFromMean =
      ramp.reduce((sum, v) => sum + Math.abs(v - avg), 0) / ramp.length

    expect(jitterFromLatencies(ramp)).toBe(10)
    expect(deviationFromMean).toBeGreaterThan(20)
  })

  it('needs at least two samples', () => {
    expect(jitterFromLatencies([10])).toBeNull()
    expect(jitterFromLatencies([])).toBeNull()
  })
})

describe('normalizeLossPercent', () => {
  it.each([
    [-5, 0],
    [0, 0],
    [42.5, 42.5],
    [150, 100],
  ])('clamps %s to %s', (input, expected) => {
    expect(normalizeLossPercent(input)).toBe(expected)
  })

  it('returns null for values that are not numbers', () => {
    expect(normalizeLossPercent('abc')).toBeNull()
    expect(normalizeLossPercent(NaN)).toBeNull()
    expect(normalizeLossPercent(undefined)).toBeNull()
  })
})

describe('round', () => {
  it('avoids binary floating point noise in accumulated sums', () => {
    expect(round(0.1 + 0.2, 2)).toBe(0.3)
    expect(round(3.3000000000000003, 2)).toBe(3.3)
  })

  it('rounds half away from zero where the literal is exactly representable', () => {
    expect(round(2.5, 0)).toBe(3)
    expect(round(1.25, 1)).toBe(1.3)
  })

  it('inherits the usual IEEE-754 tie behaviour, which is fine for display', () => {
    // 1.005 is stored as 1.00499999...; there is no rounding scheme that gets
    // this "right" without decimal arithmetic, and a 0.005ms latency error is
    // far below the resolution of any ping.
    expect(round(1.005, 2)).toBe(1)
  })
})

describe('mean', () => {
  it('returns null rather than NaN for an empty sample', () => {
    expect(mean([])).toBeNull()
  })
})

describe('percentile', () => {
  it('interpolates between neighbouring samples', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
    expect(percentile([0, 10], 25)).toBe(2.5)
  })

  it('returns the extremes at 0 and 100', () => {
    const values = [5, 1, 9, 3]
    expect(percentile(values, 0)).toBe(1)
    expect(percentile(values, 100)).toBe(9)
  })

  it('does not mutate the caller’s array', () => {
    const values = [3, 1, 2]
    percentile(values, 50)
    expect(values).toEqual([3, 1, 2])
  })

  it('handles degenerate samples', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([7], 50)).toBe(7)
  })

  it('orders the smoke bands so each nests inside the last', () => {
    // 19 fast packets and one straggler: the outer band must be far wider than
    // the inner one, which is the whole point of drawing more than one.
    const latencies = [...Array(19).fill(3), 400]
    const [p10, p25, p75, p90] = [10, 25, 75, 90].map(p => percentile(latencies, p)!)

    expect(p10).toBeLessThanOrEqual(p25)
    expect(p25).toBeLessThanOrEqual(p75)
    expect(p75).toBeLessThanOrEqual(p90)
    expect(Math.max(...latencies) - Math.min(...latencies)).toBeGreaterThan(p90 - p10)
  })
})
