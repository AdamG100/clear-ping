import type { AddressFamily, Traceroute } from '@/types/probe'
import { mean, round } from './metrics'
import { findGaps, findIncidents, type Incident, type MonitoringGap, type ProbeReading } from './outages'
import { firstDeadHop, hopLoss } from './traceroute-parse'

/**
 * What the readings amount to, said the way it would be said to someone else.
 *
 * The dashboard is for looking; this is for telling. An assistant asked to
 * write to an ISP about a week of dropouts needs each of them as a line with
 * a time on it, what else was failing at that moment and what was not, and
 * how the week went hour by hour, and it needs them worked out here: handed
 * forty thousand rows it would have to guess.
 *
 * Pure. The readings are handed in, whatever they were read from.
 */

// ─── Times ──────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Whether `value` names a time zone this machine knows: "Africa/Johannesburg", "UTC". */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * A moment as the clock on the wall had it, with how far that is from UTC:
 * "2026-10-13T10:46:42+02:00". One string that reads as local time to the
 * person and is still exact to the ISP's engineer in another zone.
 */
export function isoIn(timestamp: number, timeZone: string): string {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]))
  // "GMT+02:00", or plain "GMT" for no offset at all.
  const offset = (parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00'
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}

/** A length of time as it would be said: "45s", "17m 5s", "2h 3m", "3d 4h". */
export function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
  return `${rest}s`
}

// ─── One series ─────────────────────────────────────────────────────────────

export interface LatencySummary {
  median: number
  mean: number
  p95: number
  min: number
  max: number
}

export interface SeriesSummary {
  probes: number
  /** Probes that got nothing back at all. */
  failedProbes: number
  /** Probes that got something back, and not everything. */
  lossyProbes: number
  /** Share of probes that got something back, 0-100. */
  uptimePercent: number
  /** Mean loss over every probe, one that got nothing back counting as 100. */
  lossPercent: number
  /** Null where no probe got an answer to time. */
  latencyMs: LatencySummary | null
  firstProbe: number | null
  lastProbe: number | null
}

const lossOf = (reading: ProbeReading) => (reading.success ? reading.packetLoss : 100)

/** A value part way through a list that is already in order. */
function quantile(sorted: number[], p: number): number {
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

function latencySummary(latencies: number[]): LatencySummary | null {
  if (latencies.length === 0) return null
  const sorted = [...latencies].sort((a, b) => a - b)
  return {
    median: round(quantile(sorted, 50), 2),
    mean: round(mean(sorted) ?? 0, 2),
    p95: round(quantile(sorted, 95), 2),
    min: round(sorted[0], 2),
    max: round(sorted[sorted.length - 1], 2),
  }
}

export function summarizeReadings(readings: readonly ProbeReading[]): SeriesSummary {
  const failed = readings.filter(reading => !reading.success).length
  const lossy = readings.filter(reading => reading.success && reading.packetLoss > 0).length
  const latencies = readings.map(reading => reading.latency).filter((latency): latency is number => latency !== null)

  return {
    probes: readings.length,
    failedProbes: failed,
    lossyProbes: lossy,
    uptimePercent: readings.length > 0 ? round(((readings.length - failed) / readings.length) * 100, 3) : 0,
    lossPercent: readings.length > 0 ? round(readings.reduce((sum, reading) => sum + lossOf(reading), 0) / readings.length, 3) : 0,
    latencyMs: latencySummary(latencies),
    firstProbe: readings[0]?.timestamp ?? null,
    lastProbe: readings[readings.length - 1]?.timestamp ?? null,
  }
}

export interface HourOfDay {
  /** The hour it starts at, on the clock of the time zone asked for: "18:00". */
  hour: string
  probes: number
  failedProbes: number
  lossPercent: number
  medianLatencyMs: number | null
}

/**
 * The period folded into one day: every probe taken between six and seven in
 * the evening together, whichever evening it was. A line that is fine all
 * morning and loses packets every night at eight shows here and nowhere else,
 * and that pattern, congestion at the busy hour, is the one an ISP has to
 * answer for.
 */
export function hoursOfDay(readings: readonly ProbeReading[], timeZone: string): HourOfDay[] {
  const hours = Array.from({ length: 24 }, () => ({ probes: 0, failed: 0, loss: 0, latencies: [] as number[] }))

  // The clock is asked once for each quarter of an hour, not once a reading:
  // no time zone is offset from another by less.
  const QUARTER = 900_000
  const known = new Map<number, number>()
  const formatter = formatterFor(timeZone)
  const hourOf = (timestamp: number) => {
    const slot = Math.floor(timestamp / QUARTER)
    let hour = known.get(slot)
    if (hour === undefined) {
      hour = Number(formatter.formatToParts(new Date(timestamp)).find(part => part.type === 'hour')?.value ?? 0) % 24
      known.set(slot, hour)
    }
    return hour
  }

  for (const reading of readings) {
    const hour = hours[hourOf(reading.timestamp)]
    hour.probes++
    if (!reading.success) hour.failed++
    hour.loss += lossOf(reading)
    if (reading.latency !== null) hour.latencies.push(reading.latency)
  }

  return hours.flatMap((hour, index) =>
    hour.probes === 0
      ? []
      : [{
          hour: `${String(index).padStart(2, '0')}:00`,
          probes: hour.probes,
          failedProbes: hour.failed,
          lossPercent: round(hour.loss / hour.probes, 2),
          medianLatencyMs: latencySummary(hour.latencies)?.median ?? null,
        }]
  )
}

/** One line on a chart: a target, or one address family of a target probed over both. */
export interface SeriesEvidence {
  /** What it is called in a report: the target's name, with the family where there are two. */
  label: string
  targetId: string
  family: AddressFamily | null
  intervalMs: number
  summary: SeriesSummary
  incidents: Incident[]
  gaps: MonitoringGap[]
  hours: HourOfDay[]
  /** When each probe was taken, and nothing else of it: enough to say whether it was being watched at a given moment. */
  timestamps: number[]
}

export function analyzeSeries(
  series: Pick<SeriesEvidence, 'label' | 'targetId' | 'family' | 'intervalMs'>,
  readings: readonly ProbeReading[],
  options: { timeZone: string; minLoss?: number }
): SeriesEvidence {
  return {
    ...series,
    summary: summarizeReadings(readings),
    incidents: findIncidents(readings, { intervalMs: series.intervalMs, minLoss: options.minLoss }),
    gaps: findGaps(readings, series.intervalMs),
    hours: hoursOfDay(readings, options.timeZone),
    timestamps: readings.map(reading => reading.timestamp),
  }
}

// ─── Incidents, told ────────────────────────────────────────────────────────

/** The last moment an incident is known to have been going on. */
const until = (incident: Incident) => incident.end ?? incident.lastAffected

/** Whether a list in order has anything from `from` to `to`. */
export function anyBetween(sorted: readonly number[], from: number, to: number): boolean {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle] < from) low = middle + 1
    else high = middle
  }
  return low < sorted.length && sorted[low] <= to
}

export interface Meanwhile {
  /** Other series with an incident of their own at the same time. */
  alsoAffected: string[]
  /** Other series that were being probed then and lost nothing. */
  unaffected: string[]
  /** Other series with no probe near enough to say either way. */
  notWatched: string[]
}

/**
 * What everything else was doing while one thing was failing.
 *
 * This is the part of the evidence that says where a fault was. The router
 * answering while every address beyond it does not is a fault past the
 * router; one website failing while the rest of the internet answers is that
 * website's.
 */
export function meanwhile(incident: Incident, of: SeriesEvidence, all: readonly SeriesEvidence[]): Meanwhile {
  const result: Meanwhile = { alsoAffected: [], unaffected: [], notWatched: [] }

  for (const other of all) {
    if (other === of) continue

    if (other.incidents.some(each => each.start <= until(incident) && until(each) >= incident.start)) {
      result.alsoAffected.push(other.label)
      // A probe either side counts: a short incident can fall wholly between
      // two probes of a target that is looked at less often.
    } else if (anyBetween(other.timestamps, incident.start - other.intervalMs, until(incident) + other.intervalMs)) {
      result.unaffected.push(other.label)
    } else {
      result.notWatched.push(other.label)
    }
  }
  return result
}

export interface IncidentLine {
  target: string
  kind: Incident['kind']
  /** The first probe that was affected. */
  start: string
  /** The probe at which it was seen to be over; null where that was not seen. */
  end: string | null
  ongoing: boolean
  /** Said only where there is no `end` and it is not `ongoing`. */
  endNote?: string
  duration: string
  durationSeconds: number
  probes: number
  failedProbes: number
  worstLossPercent: number
  meanLossPercent: number
  reasons: string[]
  meanwhile?: Meanwhile
}

export function describeIncident(incident: Incident, target: string, timeZone: string): IncidentLine {
  return {
    target,
    kind: incident.kind,
    start: isoIn(incident.start, timeZone),
    end: incident.end === null ? null : isoIn(incident.end, timeZone),
    ongoing: incident.ongoing,
    ...(incident.end === null && !incident.ongoing
      ? { endNote: 'Monitoring stopped before it was seen to end; the duration is to the last failed probe.' }
      : {}),
    duration: humanDuration(incident.durationMs),
    durationSeconds: Math.round(incident.durationMs / 1000),
    probes: incident.probes,
    failedProbes: incident.failedProbes,
    worstLossPercent: round(incident.worstLoss, 1),
    meanLossPercent: round(incident.meanLoss, 1),
    reasons: incident.reasons,
  }
}

/**
 * The incidents there is room to list, oldest first. Where there are more
 * than that, the ones kept are the ones that matter most: an outage before a
 * spell of loss, and of either the longer.
 */
export function mostSevere<T extends { incident: Incident }>(entries: T[], limit: number): T[] {
  if (entries.length <= limit) return [...entries].sort((a, b) => a.incident.start - b.incident.start)

  const rank = (entry: T) => (entry.incident.kind === 'outage' ? 1 : 0)
  return [...entries]
    .sort((a, b) => rank(b) - rank(a) || b.incident.durationMs - a.incident.durationMs)
    .slice(0, limit)
    .sort((a, b) => a.incident.start - b.incident.start)
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export interface TraceLine {
  target: string
  takenAt: string
  /** Traced by the monitor itself at the moment an alert fired, or by someone pressing the button. */
  trigger: string
  address: string
  reachedTheTarget: boolean
  /** The hop from which nothing further answered, where the trace did not arrive. */
  repliesStopAtHop: number | null
  error?: string
  /** "3  100.64.0.1 (bng1.example.net)  12.4 ms  loss 0%", one for each hop. */
  hops: string[]
}

export function describeTrace(trace: Traceroute, target: string, timeZone: string): TraceLine {
  return {
    target,
    takenAt: isoIn(trace.timestamp.getTime(), timeZone),
    trigger: trace.trigger === 'alert' ? 'automatic, when an alert fired' : 'manual',
    address: trace.address,
    reachedTheTarget: trace.reached,
    repliesStopAtHop: firstDeadHop(trace.hops, trace.reached),
    ...(trace.errorMessage ? { error: trace.errorMessage } : {}),
    hops: trace.hops.map(hop => {
      const who = hop.address ? (hop.hostname ? `${hop.address} (${hop.hostname})` : hop.address) : '*'
      const time = mean(hop.rtts)
      return `${hop.hop}  ${who}  ${time === null ? 'no reply' : `${round(time, 1)} ms`}  loss ${round(hopLoss(hop), 0)}%`
    }),
  }
}

