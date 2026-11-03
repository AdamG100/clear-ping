import type { AddressFamily, Target } from '@/types/probe'
import type { ProbeAgentOutage } from '@/types/probe-agent'
import type { OverviewEvent, OverviewEventScope, OverviewReport, OverviewSlice, OverviewTarget } from '@/types/overview'
import { getAllTargets, getNeverAnswered } from '../db/database'
import { isMeaningfulLoss } from '../charts/packet-loss-colors'
import { isClosedPortCheck } from '../probes/config'
import { classifyHost, FAMILY_LABEL, isDualStack, isLocalHost, isPrivateAddress } from '../probes/host'
import { listProbeAgentSummaries, probeAgentOutages } from '../probe-agents/store'
import { agentIdOf, probeIdsOf } from '../targets/probes'
import { readDay } from './day-readings'
import { anyBetween, summarizeReadings } from './evidence'
import { findIncidents, type Incident, type ProbeReading } from './outages'

/**
 * The day, for the overview: each target's uptime, the events in it, and how
 * many targets were in trouble in each quarter of an hour.
 *
 * The incidents are the ones a report finds (outages.ts). What the overview
 * adds is putting them together. When the line goes down, twenty targets each
 * have an outage at 12:49, and listing twenty outages hides the one thing
 * worth knowing, that it was one fault. So incidents that start together,
 * seen from the same place, are one event, and the event says where the fault
 * lay from what else was answering at the time.
 *
 * `buildOverview` is pure: the readings are handed in. `readOverview` reads them.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** A spell of loss shorter than this is counted, not listed: a few dropped packets now and then are ordinary. */
export const LISTED_LOSS_MS = 10 * MINUTE_MS

/** Incidents that start within this of the one before, or within a probe of it if that is longer, are one event. */
const TOGETHER_MS = 2 * MINUTE_MS

export const SLICE_MS = 15 * MINUTE_MS

type Reading = ProbeReading & { family?: AddressFamily }

export interface OverviewInput {
  start: number
  end: number
  targets: Pick<Target, 'id' | 'name' | 'host' | 'interval' | 'ipVersion' | 'probeAgentId'>[]
  /** By target id, oldest first. */
  readings: Map<string, Reading[]>
  probeAgentOutages: Record<string, ProbeAgentOutage[]>
}

/** Inside the network it is probed from: a private address, or a name that only means something there. */
function isLocal(host: string): boolean {
  return classifyHost(host) === 'hostname' ? isLocalHost(host) : isPrivateAddress(host)
}

/** One line of readings: a target, or one family of a target probed over both. */
interface Line {
  target: OverviewInput['targets'][number]
  label: string
  intervalMs: number
  timestamps: number[]
  incidents: Incident[]
}

function linesOf(target: OverviewInput['targets'][number], readings: Reading[]): Line[] {
  const intervalMs = target.interval * 1000
  const line = (label: string, of: Reading[]): Line => ({
    target,
    label,
    intervalMs,
    timestamps: of.map(reading => reading.timestamp),
    incidents: findIncidents(of, { intervalMs }),
  })

  if (!isDualStack(target.host, target.ipVersion)) return [line(target.name, readings)]
  return ([4, 6] as const).map(family =>
    line(`${target.name} (${FAMILY_LABEL[family]})`, readings.filter(reading => reading.family === family))
  )
}

/** Worth an entry of its own: no reply at all, or loss that went on. */
const isListed = (incident: Incident) => incident.kind === 'outage' || incident.durationMs >= LISTED_LOSS_MS

/** The last moment an incident is known to have been going on. */
const until = (incident: Incident) => incident.end ?? incident.lastAffected

interface Gathering {
  probeAgentId: string | null
  members: { line: Line; incident: Incident }[]
  lastStart: number
}

function scopeOf(affected: Set<string>, watchedLines: Line[], inputTargets: Map<string, OverviewInput['targets'][number]>): OverviewEventScope {
  const watchedTargets = new Set(watchedLines.map(line => line.target.id))
  if ([...affected].some(id => isLocal(inputTargets.get(id)?.host ?? ''))) return 'local'
  if (affected.size === 1) return watchedTargets.size > 1 ? 'single' : 'unclear'
  const localAnswering = watchedLines.some(line => !affected.has(line.target.id) && isLocal(line.target.host))
  return localAnswering ? 'beyond' : 'unclear'
}

function eventOf(gathering: Gathering, lines: Line[], inputTargets: Map<string, OverviewInput['targets'][number]>): OverviewEvent {
  const { members, probeAgentId } = gathering
  const start = Math.min(...members.map(({ incident }) => incident.start))
  const ongoing = members.some(({ incident }) => incident.ongoing)
  // Over when the last of them was; not known to be over while any is not.
  const unended = members.some(({ incident }) => incident.end === null)
  const last = Math.max(...members.map(({ incident }) => until(incident)))

  // A target probed over both families can be in it twice: once is enough,
  // under its own name if both failed.
  const byTarget = new Map<string, OverviewEvent['targets'][number] & { labels: Set<string> }>()
  for (const { line, incident } of members) {
    const existing = byTarget.get(line.target.id)
    if (existing) {
      existing.labels.add(line.label)
      if (incident.kind === 'outage') existing.kind = 'outage'
      for (const reason of incident.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
    } else {
      byTarget.set(line.target.id, {
        targetId: line.target.id,
        label: line.label,
        labels: new Set([line.label]),
        kind: incident.kind,
        reasons: [...incident.reasons],
      })
    }
  }
  const targets = [...byTarget.values()].map(({ labels, ...each }) => ({
    ...each,
    label: labels.size > 1 ? inputTargets.get(each.targetId)?.name ?? each.label : each.label,
    reasons: each.reasons.slice(0, 3),
  }))

  // Everything probed from the same place with a probe near enough to say
  // whether it was affected: a probe either side counts, as in a report.
  const watchedLines = lines.filter(
    line =>
      (line.target.probeAgentId ?? null) === probeAgentId &&
      anyBetween(line.timestamps, start - line.intervalMs, last + line.intervalMs)
  )
  const affected = new Set(byTarget.keys())

  return {
    id: `${probeAgentId ?? 'here'}:${start}`,
    probeAgentId,
    kind: members.some(({ incident }) => incident.kind === 'outage') ? 'outage' : 'loss',
    start,
    end: unended ? null : last,
    ongoing,
    durationMs: last - start,
    targets,
    watched: new Set([...watchedLines.map(line => line.target.id), ...affected]).size,
    scope: scopeOf(affected, watchedLines, inputTargets),
  }
}

/** Incidents that started together, from the same place, as events, oldest first. */
function gatherEvents(lines: Line[], inputTargets: Map<string, OverviewInput['targets'][number]>): OverviewEvent[] {
  const listed = lines
    .flatMap(line => line.incidents.filter(isListed).map(incident => ({ line, incident })))
    .sort((a, b) => a.incident.start - b.incident.start)

  // Open gatherings, one for each place things are probed from.
  const open = new Map<string | null, Gathering>()
  const done: Gathering[] = []

  for (const member of listed) {
    const from = member.line.target.probeAgentId ?? null
    const current = open.get(from)
    const slack = Math.max(TOGETHER_MS, member.line.intervalMs)
    if (current && member.incident.start - current.lastStart <= slack) {
      current.members.push(member)
      current.lastStart = member.incident.start
    } else {
      if (current) done.push(current)
      open.set(from, { probeAgentId: from, members: [member], lastStart: member.incident.start })
    }
  }
  done.push(...open.values())

  return done.map(gathering => eventOf(gathering, lines, inputTargets)).sort((a, b) => a.start - b.start)
}

/** How many targets were watched, down and losing in each slice of the period. */
function slicesOf(input: OverviewInput): OverviewSlice[] {
  // On the quarter hours of the clock, so the hours can be marked under them.
  const first = Math.floor(input.start / SLICE_MS) * SLICE_MS
  const count = Math.max(1, Math.ceil((input.end - first) / SLICE_MS))
  const slices = Array.from({ length: count }, (_, index) => ({
    start: first + index * SLICE_MS,
    watched: new Set<string>(),
    down: new Set<string>(),
    lossy: new Set<string>(),
  }))

  for (const [targetId, readings] of input.readings) {
    for (const reading of readings) {
      const slice = slices[Math.floor((reading.timestamp - first) / SLICE_MS)]
      if (!slice) continue
      slice.watched.add(targetId)
      if (!reading.success) slice.down.add(targetId)
      else if (isMeaningfulLoss(reading.packetLoss)) slice.lossy.add(targetId)
    }
  }

  return slices.map(slice => ({
    start: slice.start,
    watched: slice.watched.size,
    down: slice.down.size,
    // Down at some point in the slice is the worse of the two, and is said once.
    lossy: [...slice.lossy].filter(id => !slice.down.has(id)).length,
  }))
}

export function buildOverview(input: OverviewInput): OverviewReport {
  const inputTargets = new Map(input.targets.map(target => [target.id, target]))
  const lines = input.targets.flatMap(target => linesOf(target, input.readings.get(target.id) ?? []))

  const targets: OverviewTarget[] = input.targets.map(target => {
    const summary = summarizeReadings(input.readings.get(target.id) ?? [])
    return {
      targetId: target.id,
      probes: summary.probes,
      failedProbes: summary.failedProbes,
      lossyProbes: summary.lossyProbes,
      uptimePercent: summary.uptimePercent,
      lossPercent: summary.lossPercent,
      medianLatencyMs: summary.latencyMs?.median ?? null,
    }
  })

  return {
    start: input.start,
    end: input.end,
    targets,
    events: gatherEvents(lines, inputTargets),
    briefLossSpells: lines.reduce((sum, line) => sum + line.incidents.filter(incident => !isListed(incident)).length, 0),
    slices: slicesOf(input),
    sliceMs: SLICE_MS,
    probeAgentOutages: input.probeAgentOutages,
  }
}

/**
 * The last `hours` up to `now`, read and worked out. A closed-port check that
 * has never had an answer is left out: all it has done is fail, which says
 * nothing about its server (see the sidebar's grey dot for it).
 */
export async function readOverview(hours = 24, now = Date.now()): Promise<OverviewReport> {
  const start = now - hours * HOUR_MS
  const [all, agents] = await Promise.all([getAllTargets(), listProbeAgentSummaries()])
  const unmeasured = await getNeverAnswered(all.filter(isClosedPortCheck).map(target => target.id))
  const targets = all.filter(target => !unmeasured.has(target.id))

  // A monitor measured from several probes is a line for each: what one sees
  // is not what another does, and an event is about the probe that saw it. The
  // first probe keeps the monitor's own id; the others are told apart by
  // theirs, and put back to the monitor's after.
  const pairs = targets.flatMap(target =>
    probeIdsOf(target).map((probe, index) => ({
      ...target,
      id: index === 0 ? target.id : `${target.id}${PAIR_SEPARATOR}${probe}`,
      probeAgentId: agentIdOf(probe),
      probe,
      monitor: target.id,
    }))
  );

  const readings = await readDay(pairs.map(pair => ({ key: pair.id, monitor: pair.monitor, probe: pair.probe })), start, now)

  const outages = await Promise.all(agents.map(async agent => [agent.id, await probeAgentOutages(agent.id, start, now)] as const))

  const report = buildOverview({ start, end: now, targets: pairs, readings, probeAgentOutages: Object.fromEntries(outages) })
  return {
    ...report,
    // The monitors' own figures are their first probe's.
    targets: report.targets.filter(each => !each.targetId.includes(PAIR_SEPARATOR)),
    events: report.events.map(event => ({
      ...event,
      targets: event.targets.map(each => ({ ...each, targetId: each.targetId.split(PAIR_SEPARATOR)[0] })),
    })),
  }
}

/** Between a monitor's id and its probe's, on the line of a probe other than its first. */
const PAIR_SEPARATOR = '|'
