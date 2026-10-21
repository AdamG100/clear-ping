import { findIncidents, type ProbeReading } from './outages'
import { anyBetween, hoursOfDay } from './evidence'

/**
 * Where a target's loss is, for someone trying to find out why it has any.
 *
 * The figure on the card says how much. Finding the cause needs its shape:
 * whether it is a packet here and there or spells of it, at what time of day,
 * and whether the target's neighbours lost packets at the same moments. Loss
 * shared with the router on the same network starts on that network; loss
 * shared with every target out on the internet starts at the connection or
 * beyond it; loss nobody else had is on this target's own path.
 *
 * Pure. The readings are handed in, whatever they were read from.
 */

/**
 * - `scattered`: a probe here and there, never several close together.
 * - `spells`: probes close together lost packets, a few minutes at a time.
 * - `constant`: most probes lost something.
 */
export type LossPattern = 'none' | 'scattered' | 'spells' | 'constant'

/**
 * - `local`: a target on the same private network lost packets at the same moments.
 * - `shared`: other targets out on the internet did, and none on the network.
 * - `own-path`: others were probed all along, and none of them did.
 * - `unknown`: too little loss, or nothing to compare it with.
 */
export type LossSource = 'local' | 'shared' | 'own-path' | 'unknown'

/** Another target probed from the same place, as far as comparing moments goes. */
export interface Neighbour {
  targetId: string
  name: string
  host: string
  /** On a private network: the router, a switch, a machine on the LAN. */
  local: boolean
  intervalMs: number
  /** How many probes it had in the period. */
  probes: number
  /** When it lost anything, oldest first. */
  affected: number[]
}

export interface SameMoments {
  targetId: string
  name: string
  host: string
  local: boolean
  /** Of this target's probes that lost something, how many it lost something beside. */
  shared: number
  /** More than chance would put beside them: the two have something in common. */
  significant: boolean
}

export interface LossAnalysis {
  probes: number
  /** Probes that lost anything, those that got nothing back among them. */
  affectedProbes: number
  failedProbes: number
  /** For ping: how many packets went, and how many of them were lost. */
  packets: { sent: number; lost: number; singlePacketProbes: number } | null
  pattern: LossPattern
  /** Runs of three or more affected probes close together. */
  spells: number
  /** The longest run of affected probes. */
  longest: { start: number; end: number; durationMs: number; affectedProbes: number } | null
  worst: { loss: number; at: number } | null
  /** Each hour of the day on the clock of the zone asked for, midnight first. */
  hours: { hour: number; probes: number; affected: number }[]
  /** The hour that stands out, if one does. */
  busiestHour: number | null
  sameMoments: SameMoments[]
  /** Whether any target on the same private network was probed in the period to compare with. */
  comparedWithLocal: boolean
  source: LossSource
}

/**
 * Another target shares this one's loss when it lost something beside at
 * least this share of its affected probes, and several times as many as its
 * own loss would land beside them by chance.
 */
const SHARED_SHARE = 0.25
const OVER_CHANCE = 3
/** Fewer affected probes than this and comparing them proves nothing. */
const TOO_FEW = 3
/**
 * An hour stands out when its share of probes with loss is this many times
 * the average, and it holds at least PEAK_SHARE of all of them: with a few
 * dozen lossy probes, one hour doubles the average by chance alone.
 */
const STANDS_OUT = 2
const PEAK_SHARE = 0.2
/** Spells: this many affected probes close together. */
const SPELL = 3
const MOMENTS_SHOWN = 5

const lossOf = (reading: ProbeReading) => (reading.success ? reading.packetLoss : 100)

export function analyzeLoss(
  readings: readonly ProbeReading[],
  options: {
    intervalMs: number
    timeZone: string
    /** Packets in each probe, for ping; null for anything else. */
    packetsPerProbe: number | null
    neighbours: readonly Neighbour[]
  }
): LossAnalysis {
  const affected = readings.filter(reading => lossOf(reading) > 0)
  const failedProbes = readings.filter(reading => !reading.success).length

  const incidents = findIncidents(readings, { intervalMs: options.intervalMs })
  const longest = incidents.reduce<(typeof incidents)[number] | null>(
    (best, incident) => (best === null || incident.durationMs > best.durationMs ? incident : best),
    null
  )
  const spells = incidents.filter(incident => incident.affectedProbes >= SPELL).length

  const pattern: LossPattern =
    affected.length === 0 ? 'none'
    : affected.length / readings.length >= 0.5 ? 'constant'
    : spells > 0 ? 'spells'
    : 'scattered'

  const worstReading = affected.reduce<ProbeReading | null>(
    (worst, reading) => (worst === null || lossOf(reading) > lossOf(worst) ? reading : worst),
    null
  )

  const perProbe = options.packetsPerProbe
  const packets = perProbe
    ? {
        sent: readings.length * perProbe,
        lost: affected.reduce((sum, reading) => sum + Math.round((lossOf(reading) / 100) * perProbe), 0),
        singlePacketProbes: affected.filter(reading => Math.round((lossOf(reading) / 100) * perProbe) === 1).length,
      }
    : null

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, probes: 0, affected: 0 }))
  for (const hour of hoursOfDay(readings, options.timeZone)) {
    const slot = hours[Number(hour.hour.slice(0, 2))]
    slot.probes = hour.probes
    slot.affected = hour.affectedProbes
  }
  const shareOf = (hour: { probes: number; affected: number }) => (hour.probes > 0 ? hour.affected / hour.probes : 0)
  const overall = readings.length > 0 ? affected.length / readings.length : 0
  const busiest = hours.reduce((best, hour) => (shareOf(hour) > shareOf(best) ? hour : best), hours[0])
  const busiestHour =
    busiest.affected >= Math.max(TOO_FEW, affected.length * PEAK_SHARE) && shareOf(busiest) >= overall * STANDS_OUT ? busiest.hour : null

  // Two probes a whole interval apart can still have caught the same
  // trouble: neither target is probed at the same second as the other.
  const span = readings.length > 1 ? readings[readings.length - 1].timestamp - readings[0].timestamp : 0
  const sameMoments = options.neighbours
    .filter(neighbour => neighbour.probes > 0)
    .map(neighbour => {
      const reach = Math.max(options.intervalMs, neighbour.intervalMs)
      const shared = affected.filter(reading => anyBetween(neighbour.affected, reading.timestamp - reach, reading.timestamp + reach)).length
      // How often a moment picked at random would have its loss beside it.
      const chance = span > 0 ? Math.min(1, (neighbour.affected.length * 2 * reach) / span) : 1
      const share = affected.length > 0 ? shared / affected.length : 0
      return {
        targetId: neighbour.targetId,
        name: neighbour.name,
        host: neighbour.host,
        local: neighbour.local,
        shared,
        significant: shared >= TOO_FEW && share >= SHARED_SHARE && share >= chance * OVER_CHANCE,
      }
    })
    .sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name))

  const sharing = sameMoments.filter(each => each.significant)
  const source: LossSource =
    affected.length < TOO_FEW || sameMoments.length === 0 ? 'unknown'
    : sharing.some(each => each.local) ? 'local'
    : sharing.length > 0 ? 'shared'
    : 'own-path'

  return {
    probes: readings.length,
    affectedProbes: affected.length,
    failedProbes,
    packets,
    pattern,
    spells,
    longest: longest && {
      start: longest.start,
      end: longest.lastAffected,
      durationMs: longest.lastAffected - longest.start,
      affectedProbes: longest.affectedProbes,
    },
    worst: worstReading && { loss: lossOf(worstReading), at: worstReading.timestamp },
    hours,
    busiestHour,
    sameMoments: sameMoments.slice(0, MOMENTS_SHOWN),
    comparedWithLocal: sameMoments.some(each => each.local),
    source,
  }
}
