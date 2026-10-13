/**
 * Readings turned into incidents.
 *
 * A chart shows a failure as a red strip to be looked at. Anything that is to
 * be told about it in words, a report for an ISP most of all, needs it as a
 * fact: down from 14:02 to 14:19, seventeen minutes, four probes with no reply
 * at all. This is where a target's readings become that list.
 *
 * Pure: the readings are handed in, whatever they were read from.
 */

/** One probe, as far as an incident is concerned. */
export interface ProbeReading {
  /** Epoch milliseconds. */
  timestamp: number
  /** Share of the probe's packets, queries or requests that failed, 0-100. */
  packetLoss: number
  /** Mean time of those that did not, in milliseconds; null if none did. */
  latency: number | null
  /** Whether anything came back at all. */
  success: boolean
  errorMessage?: string
}

/**
 * `outage` is a spell with at least one probe that got nothing back; `loss`
 * is one in which every probe got something, and not everything.
 */
export type IncidentKind = 'outage' | 'loss'

export interface Incident {
  kind: IncidentKind
  /** The first probe that was affected. The trouble began at some point in the interval before it. */
  start: number
  /**
   * The probe at which it was seen to be over, or null where that was not
   * seen: it was still going at the last reading, or the readings stop.
   */
  end: number | null
  /** The last probe that was affected. */
  lastAffected: number
  /** From `start` to `end`, or to `lastAffected` where no end was seen. */
  durationMs: number
  /** Probes taken from `start` to `lastAffected`, the odd healthy one among them included. */
  probes: number
  /** Of those, the ones that lost something. */
  affectedProbes: number
  /** Of those, the ones that got nothing back at all. */
  failedProbes: number
  worstLoss: number
  /** Mean loss over all of `probes`. */
  meanLoss: number
  /** Why the probes failed, as they said it, most often said first. */
  reasons: string[]
  /** Still going at the newest reading there is. */
  ongoing: boolean
}

export interface IncidentOptions {
  /** How often the target is probed, in milliseconds. */
  intervalMs: number
  /** Loss below this is not an incident. Any loss at all, unless said. */
  minLoss?: number
  /**
   * Healthy probes in a row that end an incident. Two unless said: a path
   * that drops, answers once and drops again is one incident, not two.
   */
  healthyToClose?: number
}

/** A stretch with no readings where there should have been some. */
export interface MonitoringGap {
  start: number
  end: number
  durationMs: number
}

/** Longer than this without a reading and the monitor was not looking, whatever the target was doing. */
export function gapThreshold(intervalMs: number): number {
  return Math.max(intervalMs * 3, intervalMs + 120_000)
}

const MAX_REASONS = 3

/**
 * The incidents in a run of readings, oldest first. `readings` are one
 * target's over one address family, in the order they were taken.
 */
export function findIncidents(readings: readonly ProbeReading[], options: IncidentOptions): Incident[] {
  const minLoss = options.minLoss ?? 0
  const healthyToClose = Math.max(1, options.healthyToClose ?? 2)
  const silence = gapThreshold(options.intervalMs)
  const isAffected = (reading: ProbeReading) => !reading.success || (reading.packetLoss > 0 && reading.packetLoss >= minLoss)

  const incidents: Incident[] = []
  /** The incident being followed: where it started, and the healthy probes seen since its last bad one. */
  let open: { from: number; lastBad: number; healthySince: number } | null = null

  const close = (end: number | null, ongoing: boolean) => {
    if (!open) return
    const span = readings.slice(open.from, open.lastBad + 1)
    const affected = span.filter(isAffected)
    const failed = affected.filter(reading => !reading.success)

    const said = new Map<string, number>()
    for (const reading of affected) {
      if (reading.errorMessage) said.set(reading.errorMessage, (said.get(reading.errorMessage) ?? 0) + 1)
    }

    const start = span[0].timestamp
    const lastAffected = span[span.length - 1].timestamp
    incidents.push({
      kind: failed.length > 0 ? 'outage' : 'loss',
      start,
      end,
      lastAffected,
      durationMs: (end ?? lastAffected) - start,
      probes: span.length,
      affectedProbes: affected.length,
      failedProbes: failed.length,
      worstLoss: Math.max(...span.map(reading => (reading.success ? reading.packetLoss : 100))),
      meanLoss: span.reduce((sum, reading) => sum + (reading.success ? reading.packetLoss : 100), 0) / span.length,
      reasons: [...said.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_REASONS).map(([reason]) => reason),
      ongoing,
    })
    open = null
  }

  for (let index = 0; index < readings.length; index++) {
    const reading = readings[index]

    // Nobody was looking for a while. Whatever was going on before it cannot
    // be said to have gone on through it, nor to have ended.
    if (open && reading.timestamp - readings[index - 1].timestamp > silence) {
      close(null, false)
      open = null
    }

    if (isAffected(reading)) {
      if (open) {
        open.lastBad = index
        open.healthySince = 0
      } else {
        open = { from: index, lastBad: index, healthySince: 0 }
      }
      continue
    }

    if (!open) continue
    open.healthySince++
    // Over at the first of the healthy probes that settled it, not the last.
    if (open.healthySince >= healthyToClose) {
      close(readings[open.lastBad + 1].timestamp, false)
      open = null
    }
  }

  if (open) {
    // Seen to recover, only not for long enough to be sure before the
    // readings ran out: that is an end. Bad to the last is still going.
    if (open.healthySince > 0) close(readings[open.lastBad + 1].timestamp, false)
    else close(null, true)
  }

  return incidents
}

/** The stretches in which a target that should have been probed was not. */
export function findGaps(readings: readonly ProbeReading[], intervalMs: number): MonitoringGap[] {
  const silence = gapThreshold(intervalMs)
  const gaps: MonitoringGap[] = []

  for (let index = 1; index < readings.length; index++) {
    const start = readings[index - 1].timestamp
    const end = readings[index].timestamp
    if (end - start > silence) gaps.push({ start, end, durationMs: end - start })
  }
  return gaps
}
