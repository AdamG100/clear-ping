/**
 * Keeping a few spikes from flattening a chart. Pure: the browser runs it.
 *
 * A latency axis drawn to the highest reading gives one bad minute in a month
 * most of the height, and every line that behaved itself is pressed into a
 * band along the bottom. The longer the period, the likelier such a minute is,
 * so it was the widest views that came out as flat lines.
 */

/** Fewer readings than this are too few to tell a spike from the rest. */
const MIN_READINGS = 20

/** The share of readings that may sit above the ceiling: the spikes. */
const SPIKE_SHARE = 0.02

/**
 * Where to cut off a latency axis so the readings below it get the height, or
 * null where nothing needs cutting off.
 *
 * Only a few readings are ever above it, so a line that runs high throughout
 * keeps its place on the chart: it is not a spike. And it is only worth
 * cutting when the spikes would otherwise take more than half the height.
 */
export function spikeCeiling(values: number[]): number | null {
  if (values.length < MIN_READINGS) return null

  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const ceiling = sorted[Math.floor((sorted.length - 1) * (1 - SPIKE_SHARE))]

  if (max - min <= (ceiling - min) * 2) return null
  return ceiling
}
