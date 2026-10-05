import type { SparklinePoint } from '@/types/probe'

/**
 * One trace for a whole group, from the recent traces of its targets.
 *
 * Drawn on a collapsed group, where the rows that would otherwise say how it
 * is doing are hidden. Latency is the mean across the group's targets and loss
 * is the worst of them, so a single target in trouble marks the group's trace
 * the way it would mark its own.
 *
 * The targets are read at the same moments rather than pooled. They are probed
 * at different intervals and never at the same instant, and a target on the
 * LAN averages very differently from one across an ocean: pooling whatever
 * happened to land in each slice would make the line jump whenever the mix in
 * a slice changed, with nothing having happened on the network. So each target
 * contributes its most recent reading as of each moment.
 *
 * The trace starts where the last of the targets' own traces starts, for the
 * same reason: before that, the mean would be of fewer targets.
 */
export function combineSeries(series: SparklinePoint[][], points = 32): SparklinePoint[] {
  const traces = series.filter(trace => trace.length > 0)
  if (traces.length === 0) return []

  const end = Math.max(...traces.map(trace => trace[trace.length - 1].timestamp))
  const commonStart = Math.max(...traces.map(trace => trace[0].timestamp))
  // A target whose first reading is also the newest of all leaves no common
  // period to read, so the trace falls back to covering everything.
  const start = commonStart < end ? commonStart : Math.min(...traces.map(trace => trace[0].timestamp))
  if (start === end) return []

  const cursors = traces.map(() => 0)
  const combined: SparklinePoint[] = []

  for (let step = 0; step < points; step++) {
    const moment = start + ((end - start) * step) / (points - 1)

    let latencyTotal = 0
    let replying = 0
    let reporting = 0
    let worstLoss = 0

    traces.forEach((trace, index) => {
      while (cursors[index] + 1 < trace.length && trace[cursors[index] + 1].timestamp <= moment) cursors[index]++
      const reading = trace[cursors[index]]
      if (reading.timestamp > moment) return

      reporting++
      worstLoss = Math.max(worstLoss, reading.packetLoss)
      if (reading.latency !== null) {
        latencyTotal += reading.latency
        replying++
      }
    })

    if (reporting === 0) continue
    combined.push({
      timestamp: moment,
      latency: replying > 0 ? latencyTotal / replying : null,
      packetLoss: worstLoss,
    })
  }

  return combined
}
