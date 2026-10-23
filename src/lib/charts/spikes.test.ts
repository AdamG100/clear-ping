import { describe, expect, it } from 'vitest'
import { spikeCeiling } from './spikes'

/** `count` readings wandering between `low` and `high`. */
const steady = (count: number, low: number, high: number) =>
  Array.from({ length: count }, (_, i) => low + ((high - low) * (i % 7)) / 6)

describe('spikeCeiling', () => {
  it('leaves readings with no spikes alone', () => {
    expect(spikeCeiling(steady(200, 10, 14))).toBeNull()
  })

  it('cuts off a spike that would take most of the height', () => {
    const ceiling = spikeCeiling([...steady(200, 10, 14), 400])

    expect(ceiling).not.toBeNull()
    expect(ceiling!).toBeLessThanOrEqual(14)
  })

  it('cuts off spikes even when every other reading is the same', () => {
    expect(spikeCeiling([...Array(100).fill(3), 90])).toBe(3)
  })

  it('keeps a line that runs high throughout, which is not a spike', () => {
    // One target in ten at 150 ms beside nine at 3 to 5 ms.
    const values = [...steady(900, 3, 5), ...steady(100, 140, 160)]

    expect(spikeCeiling(values)).toBeNull()
  })

  it('leaves a spike alone that takes less than half the height', () => {
    expect(spikeCeiling([...steady(200, 10, 20), 28])).toBeNull()
  })

  it('does not judge from too few readings', () => {
    expect(spikeCeiling([10, 11, 12, 500])).toBeNull()
  })
})
