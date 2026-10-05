import { describe, expect, it } from 'vitest'
import type { SparklinePoint } from '@/types/probe'
import { combineSeries } from './group-series'

/** A trace with a reading every `every` ms from `from`, all at one latency. */
function trace(from: number, every: number, count: number, latency: number | null, packetLoss = 0): SparklinePoint[] {
  return Array.from({ length: count }, (_, i) => ({ timestamp: from + i * every, latency, packetLoss }))
}

describe('combineSeries', () => {
  it('has nothing to draw without readings', () => {
    expect(combineSeries([])).toEqual([])
    expect(combineSeries([[], []])).toEqual([])
    expect(combineSeries([[{ timestamp: 1000, latency: 5, packetLoss: 0 }]])).toEqual([])
  })

  it('draws the mean of the targets', () => {
    const combined = combineSeries([trace(0, 1000, 10, 10), trace(0, 1000, 10, 30)], 5)
    expect(combined).toHaveLength(5)
    expect(combined.every(point => point.latency === 20)).toBe(true)
    expect(combined[0].timestamp).toBe(0)
    expect(combined[4].timestamp).toBe(9000)
  })

  it('stays level when targets are probed at different rates', () => {
    // One target on the LAN probed every second, one far away probed every
    // five. Pooling whatever landed in each slice would swing between 1ms and
    // the mean of the two; reading both at each moment does not.
    const combined = combineSeries([trace(0, 1000, 21, 1), trace(0, 5000, 5, 101)], 12)
    expect(combined.every(point => point.latency === 51)).toBe(true)
  })

  it('starts where the last of the traces starts', () => {
    const combined = combineSeries([trace(0, 1000, 11, 10), trace(6000, 1000, 5, 30)], 5)
    expect(combined[0].timestamp).toBe(6000)
    expect(combined.every(point => point.latency === 20)).toBe(true)
  })

  it('marks the group with the worst loss among its targets', () => {
    const combined = combineSeries([trace(0, 1000, 5, 10, 0), trace(0, 1000, 5, 10, 40)], 5)
    expect(combined.every(point => point.packetLoss === 40)).toBe(true)
  })

  it('averages only the targets that replied, and breaks the line when none did', () => {
    const oneDown = combineSeries([trace(0, 1000, 5, 10), trace(0, 1000, 5, null, 100)], 5)
    expect(oneDown.every(point => point.latency === 10 && point.packetLoss === 100)).toBe(true)

    const allDown = combineSeries([trace(0, 1000, 5, null, 100), trace(0, 1000, 5, null, 100)], 5)
    expect(allDown.every(point => point.latency === null)).toBe(true)
  })

  it('is not blanked by a target whose only reading is the newest one', () => {
    // A target added a moment ago: starting the trace where its readings
    // start would leave a trace with no width at all.
    const combined = combineSeries([trace(0, 1000, 5, 10), [{ timestamp: 4000, latency: 30, packetLoss: 0 }]], 4)
    expect(combined.map(point => point.latency)).toEqual([10, 10, 10, 20])
    expect(combined[0].timestamp).toBe(0)
  })
})
