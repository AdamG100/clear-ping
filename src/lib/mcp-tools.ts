import type { AddressFamily, LatestMeasurement, Target, TargetDefinition } from '@/types/probe'
import { currentBuild } from './version'
import {
  getAllTargets,
  getLatestMeasurementForAllTargets,
  getProbeReadings,
  getResolverRounds,
  getTargetById,
  updateTarget,
} from './database'
import { resolverSeries } from './dns-resolver-series'
import {
  analyzeSeries,
  anyBetween,
  describeIncident,
  describeTrace,
  humanDuration,
  isoIn,
  isTimeZone,
  meanwhile,
  mostSevere,
  type HourOfDay,
  type SeriesEvidence,
} from './evidence'
import { groupLabel, isWithinGroup, normalizeGroupPath } from './group-path'
import { FAMILY_LABEL, IP_VERSIONS, isDualStack, isPrivateAddress } from './host'
import { ToolError, type McpPrompt, type McpServer, type McpTool } from './mcp-protocol'
import { round } from './metrics'
import type { Incident } from './outages'
import { parseAddressInput, PROBE_TYPES, targetAddressLabel } from './probe-config'
import { getScheduler } from './scheduler'
import { addTargets, probeNow } from './target-actions'
import { measurementKey, validateTargetDefinition } from './target-definition'
import { ensureTracerouteSchema, getTraceroutes, traceAndStore } from './traceroute'

/**
 * What an assistant connected to ClearPing can ask it.
 *
 * Most of the tools here read and change nothing, and those are all that a
 * connection gets unless it sent the token. What they return is worked out,
 * not dumped. The point of the whole thing is one request, "put together
 * what happened for my ISP", and an assistant answers that well from a list
 * of incidents with times on them, and badly from a month of rows.
 *
 * The few that change something are further down, with why there are so few.
 *
 * Alerts are left out entirely. Where an alert is sent is a URL with a
 * password in it, and nothing an assistant is asked here needs one.
 */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A year: further back than anything is kept by default, and a bound on what one request can ask to be read. */
const MAX_PERIOD_MS = 366 * DAY_MS

const PROBE_NAME: Record<Target['probeType'], string> = {
  ping: 'ICMP ping',
  tcp: 'TCP connect',
  http: 'HTTP(S) request',
  dns: 'DNS query',
}

// ─── Arguments ──────────────────────────────────────────────────────────────

type Args = Record<string, unknown>

const PERIOD_PROPERTIES = {
  hours: { type: 'number', description: 'How far back to look, in hours, counted back from now.' },
  days: { type: 'number', description: 'How far back to look, in days. Use this or `hours`, not both.' },
  start: { type: 'string', description: 'Start of an exact period, as an ISO 8601 date-time. Use with `end` instead of `hours` or `days`.' },
  end: { type: 'string', description: 'End of an exact period, as an ISO 8601 date-time. Now, if left out.' },
} as const

const TIMEZONE_PROPERTY = {
  timezone: {
    type: 'string',
    description: 'IANA time zone to write times in, such as "Africa/Johannesburg". The time zone of the machine ClearPing runs on, if left out.',
  },
} as const

const WHICH_PROPERTIES = {
  targets: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only these targets, each by its name, its address or its id. Every target, if left out.',
  },
  group: { type: 'string', description: 'Only the targets in this group, and in the groups inside it: "Home/Network".' },
} as const

function numberArg(args: Args, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new ToolError(`${name} must be a number greater than zero.`)
  return number
}

function dateArg(args: Args, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null || value === '') return undefined
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN
  if (!Number.isFinite(time)) throw new ToolError(`${name} is not a date-time. Write it like 2026-10-13T08:00:00+02:00.`)
  return time
}

interface Period {
  start: Date
  end: Date
}

function periodFrom(args: Args, defaultMs: number): Period {
  const now = Date.now()
  const end = dateArg(args, 'end') ?? now
  const hours = numberArg(args, 'hours')
  const days = numberArg(args, 'days')
  const start = dateArg(args, 'start') ?? end - (hours !== undefined ? hours * HOUR_MS : days !== undefined ? days * DAY_MS : defaultMs)

  if (start >= end) throw new ToolError('The period ends before it starts.')
  if (end - start > MAX_PERIOD_MS) throw new ToolError('A period can be at most 366 days.')
  return { start: new Date(start), end: new Date(Math.min(end, now)) }
}

function timeZoneFrom(args: Args): string {
  const asked = args.timezone
  if (asked === undefined || asked === null || asked === '') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  if (!isTimeZone(asked)) throw new ToolError(`${String(asked)} is not a time zone this machine knows. Use an IANA name such as "Europe/London".`)
  return asked
}

function findTarget(all: Target[], reference: unknown): Target {
  const wanted = typeof reference === 'string' ? reference.trim() : ''
  if (!wanted) throw new ToolError('Say which target, by its name, its address or its id.')
  const lower = wanted.toLowerCase()

  const exact =
    all.find(target => target.id === wanted) ??
    all.find(target => target.name.toLowerCase() === lower) ??
    all.find(target => target.host.toLowerCase() === lower)
  if (exact) return exact

  // Part of a name will do, as long as it is part of only one.
  const partial = all.filter(target => target.name.toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]

  const names = (partial.length > 1 ? partial : all).map(target => target.name).slice(0, 40).join(', ')
  throw new ToolError(
    partial.length > 1
      ? `More than one target is called something like "${wanted}": ${names}. Say which.`
      : `There is no target called "${wanted}". There is: ${names || 'none yet'}.`
  )
}

function targetsFrom(all: Target[], args: Args): Target[] {
  let chosen = all

  if (Array.isArray(args.targets) && args.targets.length > 0) {
    chosen = [...new Set(args.targets.map(reference => findTarget(all, reference)))]
  }
  if (typeof args.group === 'string' && args.group.trim()) {
    const group = normalizeGroupPath(args.group)
    chosen = chosen.filter(target => isWithinGroup(normalizeGroupPath(target.group), group))
    if (chosen.length === 0) throw new ToolError(`No target is in a group called "${args.group}".`)
  }
  return chosen
}

// ─── Reading what is kept ───────────────────────────────────────────────────

/** A target's name, with its address where another target has the same name. */
function namer(all: Target[]) {
  const counts = new Map<string, number>()
  for (const target of all) counts.set(target.name, (counts.get(target.name) ?? 0) + 1)
  return (target: Target) => ((counts.get(target.name) ?? 0) > 1 ? `${target.name} [${targetAddressLabel(target)}]` : target.name)
}

/** One target's readings over a period, as a line for each family it is probed over. */
async function seriesOf(target: Target, label: string, period: Period, timeZone: string): Promise<SeriesEvidence[]> {
  const readings = await getProbeReadings(target.id, period.start, period.end)
  const intervalMs = target.interval * 1000
  const options = { timeZone }

  if (!isDualStack(target.host, target.ipVersion)) {
    return [analyzeSeries({ label, targetId: target.id, family: null, intervalMs }, readings, options)]
  }
  return ([4, 6] as const).map(family =>
    analyzeSeries(
      { label: `${label} (${FAMILY_LABEL[family]})`, targetId: target.id, family, intervalMs },
      readings.filter(reading => reading.family === family),
      options
    )
  )
}

/**
 * Every chosen target's series. One target at a time: each one's readings
 * are let go of once they have been summed up, so a month of thirty targets
 * is never all in memory at once.
 */
async function gather(targets: Target[], all: Target[], period: Period, timeZone: string): Promise<SeriesEvidence[]> {
  const nameOf = namer(all)
  const series: SeriesEvidence[] = []
  for (const target of targets) series.push(...(await seriesOf(target, nameOf(target), period, timeZone)))
  return series
}

function describeTarget(target: Target, name: string) {
  const address = target.resolvedAddress ?? target.host
  return {
    id: target.id,
    name,
    address: targetAddressLabel(target),
    ...(target.resolvedAddress && target.resolvedAddress !== target.host ? { resolvesTo: target.resolvedAddress } : {}),
    probe: PROBE_NAME[target.probeType],
    ...(target.group ? { group: groupLabel(target.group) } : {}),
    probedEverySeconds: target.interval,
    ...(isDualStack(target.host, target.ipVersion) ? { ipVersions: 'IPv4 and IPv6, each probed separately' } : {}),
    paused: target.status === 'paused',
    // Inside the local network or outside it: what tells a fault in the
    // building from one beyond it.
    insideLocalNetwork: isPrivateAddress(address),
  }
}

function describeLatest(latest: Omit<LatestMeasurement, 'byFamily'> | undefined, timeZone: string) {
  if (!latest) return null
  return {
    at: isoIn(latest.timestamp.getTime(), timeZone),
    answering: latest.success,
    lossPercent: round(latest.packetLoss, 1),
    latencyMs: latest.latency === null ? null : round(latest.latency, 2),
    ...(latest.errorMessage ? { error: latest.errorMessage } : {}),
  }
}

const outagesOf = (series: SeriesEvidence) => series.incidents.filter(incident => incident.kind === 'outage')
const timeIn = (incidents: Incident[]) => incidents.reduce((sum, incident) => sum + incident.durationMs, 0)

function seriesLine(series: SeriesEvidence, timeZone: string) {
  const outages = outagesOf(series)
  const { summary } = series
  return {
    target: series.label,
    probes: summary.probes,
    firstProbe: summary.firstProbe === null ? null : isoIn(summary.firstProbe, timeZone),
    lastProbe: summary.lastProbe === null ? null : isoIn(summary.lastProbe, timeZone),
    uptimePercent: summary.uptimePercent,
    lossPercent: summary.lossPercent,
    failedProbes: summary.failedProbes,
    lossyProbes: summary.lossyProbes,
    latencyMs: summary.latencyMs,
    outages: outages.length,
    timeInOutage: humanDuration(timeIn(outages)),
    longestOutage: outages.length > 0 ? humanDuration(Math.max(...outages.map(incident => incident.durationMs))) : null,
    spellsOfLoss: series.incidents.length - outages.length,
    monitoringGaps: series.gaps.length,
  }
}

/** An hour of the day as one line: a table of them is a quarter the length of the same as objects. */
function hourLine(hour: HourOfDay): string {
  const latency = hour.medianLatencyMs === null ? 'no reply' : `median ${hour.medianLatencyMs} ms`
  return `${hour.hour}  probes ${hour.probes}  no reply ${hour.failedProbes}  loss ${hour.lossPercent}%  ${latency}`
}

const MAX_NAMES = 15

/** A list of names short enough to read, saying how many were left off. */
function shortList(names: string[]): string[] {
  return names.length <= MAX_NAMES ? names : [...names.slice(0, MAX_NAMES), `and ${names.length - MAX_NAMES} more`]
}

function incidentLines(series: SeriesEvidence[], timeZone: string, limit: number, keep: (incident: Incident) => boolean = () => true) {
  const every = series.flatMap(each => each.incidents.filter(keep).map(incident => ({ series: each, incident })))
  const shown = mostSevere(every, limit)

  return {
    total: every.length,
    lines: shown.map(({ series: of, incident }) => {
      const others = meanwhile(incident, of, series)
      return {
        ...describeIncident(incident, of.label, timeZone),
        meanwhile: {
          alsoAffected: shortList(others.alsoAffected),
          unaffected: shortList(others.unaffected),
          ...(others.notWatched.length > 0 ? { notWatched: shortList(others.notWatched) } : {}),
        },
      }
    }),
  }
}

/**
 * The stretches in which nothing at all was probed: ClearPing itself was not
 * running, or the machine it runs on was off. No reading then is not the
 * same as no outage then, and a report has to say so.
 */
function monitorSilences(series: SeriesEvidence[], timeZone: string) {
  const watched = series.filter(each => each.timestamps.length > 0)
  // Read off the one probed most often, which has the finest view of it.
  const finest = [...watched].sort((a, b) => a.intervalMs - b.intervalMs)[0]
  if (!finest) return []

  return finest.gaps
    .filter(gap => watched.every(each => !anyBetween(each.timestamps, gap.start + 1, gap.end - 1)))
    .map(gap => ({ from: isoIn(gap.start, timeZone), to: isoIn(gap.end, timeZone), duration: humanDuration(gap.durationMs) }))
}

async function tracesFor(targets: Target[], nameOf: (target: Target) => string, period: Period, timeZone: string, limit: number) {
  await ensureTracerouteSchema()

  const traces = (
    await Promise.all(
      targets.map(async target =>
        (await getTraceroutes(target.id, 50))
          .filter(trace => trace.timestamp >= period.start && trace.timestamp <= period.end)
          .map(trace => ({ trace, name: nameOf(target) }))
      )
    )
  ).flat()

  // The ones taken as an alert fired first: those are routes through a
  // failure. Then whichever are newest.
  const rank = (trigger: string) => (trigger === 'alert' ? 1 : 0)
  return {
    total: traces.length,
    lines: traces
      .sort((a, b) => rank(b.trace.trigger) - rank(a.trace.trigger) || b.trace.timestamp.getTime() - a.trace.timestamp.getTime())
      .slice(0, limit)
      .sort((a, b) => a.trace.timestamp.getTime() - b.trace.timestamp.getTime())
      .map(({ trace, name }) => describeTrace(trace, name, timeZone)),
  }
}

/** How each resolver of a DNS target did over a period, for each family it is asked over. */
async function resolversOf(target: Target, period: Period) {
  const resolvers = target.probeType === 'dns' ? target.probeConfig?.resolvers ?? [] : []
  if (resolvers.length === 0) return []

  const families: Array<AddressFamily | null> = isDualStack(target.host, target.ipVersion) ? [4, 6] : [null]
  const whole = period.end.getTime() - period.start.getTime()

  return Promise.all(
    families.map(async family => {
      const rounds = await getResolverRounds(target.id, period.start, period.end, family ?? undefined)
      return {
        ...(family ? { ipVersion: FAMILY_LABEL[family] } : {}),
        resolvers: resolverSeries(target.id, rounds, whole, resolvers).map(line => ({
          resolver: line.label,
          probes: line.statistics.sampleCount,
          medianQueryMs: line.statistics.medianLatency === null ? null : round(line.statistics.medianLatency, 2),
          slowestQueryMs: line.statistics.maxLatency === null ? null : round(line.statistics.maxLatency, 2),
          failedQueriesPercent: round(line.statistics.packetLoss, 2),
          probesAnsweredPercent: round(line.statistics.uptime, 2),
        })),
      }
    })
  )
}

// ─── The tools ──────────────────────────────────────────────────────────────

const HOW_TO_READ = [
  'Times are local to the time zone given, with its offset from UTC written on the end.',
  'An "outage" is a spell in which at least one probe got no reply at all. A "spell of loss" is one in which every probe got a reply but some packets, queries or requests within a probe did not.',
  'An incident starts at the first probe that was affected, so the fault itself began up to one probe interval earlier. It ends at the first of two healthy probes in a row.',
  'uptimePercent is the share of probes that got any reply. lossPercent is the mean loss over every probe, counting a probe with no reply as 100.',
  '"meanwhile" says what every other monitored target was doing during an incident. Targets marked insideLocalNetwork answering while outside ones fail puts the fault beyond the local network.',
]

const listTargets: McpTool = {
  name: 'list_targets',
  title: 'List monitored targets',
  description:
    'Every target ClearPing monitors: what it is, how it is probed, which group it is in, whether it is inside the local network, and how its latest probe went. Start here to learn the names the other tools take.',
  inputSchema: { type: 'object', properties: { ...TIMEZONE_PROPERTY }, additionalProperties: false },
  run: async args => {
    const timeZone = timeZoneFrom(args)
    const [targets, latest] = await Promise.all([getAllTargets(), getLatestMeasurementForAllTargets()])
    const nameOf = namer(targets)

    return {
      timeZone,
      targets: targets.map(target => {
        const reading = latest[target.id]
        return {
          ...describeTarget(target, nameOf(target)),
          latest: describeLatest(reading, timeZone),
          ...(reading?.byFamily
            ? {
                latestByIpVersion: Object.fromEntries(
                  ([4, 6] as const).map(family => [FAMILY_LABEL[family], describeLatest(reading.byFamily?.[family], timeZone)])
                ),
              }
            : {}),
        }
      }),
    }
  },
}

const targetHistory: McpTool = {
  name: 'get_target_history',
  title: 'One target over a period',
  description:
    'How one target did over a period: uptime, loss and latency figures, every outage and spell of loss with its times, the gaps in which it was not being monitored, and how it did at each hour of the day. The last 24 hours unless a period is given.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'The target, by its name, its address or its id.' },
      ...PERIOD_PROPERTIES,
      ...TIMEZONE_PROPERTY,
    },
    required: ['target'],
    additionalProperties: false,
  },
  run: async args => {
    const period = periodFrom(args, DAY_MS)
    const timeZone = timeZoneFrom(args)
    const all = await getAllTargets()
    const target = findTarget(all, args.target)
    const name = namer(all)(target)
    const series = await seriesOf(target, name, period, timeZone)

    return {
      target: describeTarget(target, name),
      period: { from: isoIn(period.start.getTime(), timeZone), to: isoIn(period.end.getTime(), timeZone) },
      timeZone,
      howToRead: HOW_TO_READ.slice(0, 4),
      series: series.map(each => {
        const shown = mostSevere(each.incidents.map(incident => ({ incident })), 60)
        return {
          ...seriesLine(each, timeZone),
          incidents: shown.map(({ incident }) => describeIncident(incident, each.label, timeZone)),
          ...(each.incidents.length > shown.length ? { incidentsNotListed: each.incidents.length - shown.length } : {}),
          monitoringGaps: each.gaps
            .slice(0, 20)
            .map(gap => ({ from: isoIn(gap.start, timeZone), to: isoIn(gap.end, timeZone), duration: humanDuration(gap.durationMs) })),
          // One line an hour: probes taken, probes with no reply, mean loss, median latency.
          byHourOfDay: each.hours.map(hourLine),
        }
      }),
    }
  },
}

const incidents: McpTool = {
  name: 'get_incidents',
  title: 'Outages and loss, across targets',
  description:
    'Every outage and spell of loss in a period, across all targets or some of them, oldest first, each with when it started and ended, how long it lasted, why the probes failed, and what the other targets were doing meanwhile. The last 24 hours unless a period is given.',
  inputSchema: {
    type: 'object',
    properties: {
      ...PERIOD_PROPERTIES,
      ...WHICH_PROPERTIES,
      kind: { type: 'string', enum: ['outage', 'loss'], description: 'Only outages (no reply at all) or only spells of loss. Both, if left out.' },
      min_minutes: { type: 'number', description: 'Leave out incidents shorter than this many minutes.' },
      limit: { type: 'number', description: 'The most incidents to list, 100 unless said. When there are more, the most severe are kept.' },
      ...TIMEZONE_PROPERTY,
    },
    additionalProperties: false,
  },
  run: async args => {
    const period = periodFrom(args, DAY_MS)
    const timeZone = timeZoneFrom(args)
    const all = await getAllTargets()
    const series = await gather(targetsFrom(all, args), all, period, timeZone)

    const kind = args.kind === 'outage' || args.kind === 'loss' ? args.kind : null
    const shortest = (numberArg(args, 'min_minutes') ?? 0) * 60_000
    const limit = Math.min(500, Math.floor(numberArg(args, 'limit') ?? 100))
    const found = incidentLines(series, timeZone, limit, incident => (!kind || incident.kind === kind) && incident.durationMs >= shortest)

    return {
      period: { from: isoIn(period.start.getTime(), timeZone), to: isoIn(period.end.getTime(), timeZone) },
      timeZone,
      howToRead: HOW_TO_READ,
      targetsLookedAt: series.length,
      incidents: found.lines,
      ...(found.total > found.lines.length ? { incidentsNotListed: found.total - found.lines.length } : {}),
    }
  },
}

const traceroutes: McpTool = {
  name: 'get_traceroutes',
  title: 'Saved traceroutes',
  description:
    'The routes ClearPing has traced to a target, or to all of them, hop by hop. The ones marked automatic were traced at the moment a loss alert fired, so they show the route through a failure and the hop at which replies stopped. The last 30 days unless a period is given.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'The target, by its name, its address or its id. Every target, if left out.' },
      ...PERIOD_PROPERTIES,
      limit: { type: 'number', description: 'The most routes to return, 10 unless said.' },
      ...TIMEZONE_PROPERTY,
    },
    additionalProperties: false,
  },
  run: async args => {
    const period = periodFrom(args, 30 * DAY_MS)
    const timeZone = timeZoneFrom(args)
    const all = await getAllTargets()
    const chosen = args.target ? [findTarget(all, args.target)] : all
    const found = await tracesFor(chosen, namer(all), period, timeZone, Math.min(50, Math.floor(numberArg(args, 'limit') ?? 10)))

    return {
      timeZone,
      howToRead:
        'One line a hop: its number, the router, the mean reply time, and the share of packets to it that got no reply. A single hop that does not reply in the middle of a route that arrives is a router that does not answer traceroute, not a fault.',
      traceroutes: found.lines,
      ...(found.total > found.lines.length ? { routesNotListed: found.total - found.lines.length } : {}),
    }
  },
}

const dnsResolvers: McpTool = {
  name: 'get_dns_resolvers',
  title: 'A DNS target, resolver by resolver',
  description:
    'For a DNS target that asks several resolvers: how each one did over a period (query time, share of queries that failed) and what each answered in the latest probe. Shows whether one resolver is slow or failing while the others are not. The last 24 hours unless a period is given.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'The DNS target, by its name, its address or its id.' },
      ...PERIOD_PROPERTIES,
      ...TIMEZONE_PROPERTY,
    },
    required: ['target'],
    additionalProperties: false,
  },
  run: async args => {
    const period = periodFrom(args, DAY_MS)
    const timeZone = timeZoneFrom(args)
    const all = await getAllTargets()
    const target = findTarget(all, args.target)

    const overPeriod = await resolversOf(target, period)
    if (overPeriod.length === 0) {
      throw new ToolError(`${target.name} is not a DNS target with a list of resolvers. Use get_target_history for it.`)
    }

    const latest = (await getLatestMeasurementForAllTargets())[target.id]
    const readings = (reading: Omit<LatestMeasurement, 'byFamily'> | undefined) =>
      reading?.details?.resolvers
        ? {
            at: isoIn(reading.timestamp.getTime(), timeZone),
            resolvers: reading.details.resolvers.map(each => ({
              resolver: each.label,
              queryMs: each.latency,
              failedQueriesPercent: each.loss,
              ...(each.connectMs !== undefined ? { connectMs: each.connectMs } : {}),
              ...(each.answers ? { answers: each.answers } : {}),
              ...(each.error ? { error: each.error } : {}),
            })),
          }
        : null

    return {
      target: describeTarget(target, namer(all)(target)),
      period: { from: isoIn(period.start.getTime(), timeZone), to: isoIn(period.end.getTime(), timeZone) },
      timeZone,
      howToRead:
        'Each probe sends several queries to every resolver at the same moment. A failed query is one that timed out, came back as an error, or gave something other than the expected answer. Resolvers giving different addresses for one name is usual for a name served by region.',
      overThePeriod: overPeriod,
      latestProbe: latest?.byFamily
        ? Object.fromEntries(([4, 6] as const).map(family => [FAMILY_LABEL[family], readings(latest.byFamily?.[family])]))
        : readings(latest),
    }
  },
}

const ispReport: McpTool = {
  name: 'build_isp_report',
  title: 'Evidence for an ISP report',
  description:
    'Everything needed to write up a connection problem for an internet provider, in one call: how every target did over the period, each outage with its times and what else was failing or working meanwhile, the worst spells of packet loss, how the worst-affected targets did by hour of day, the traceroutes taken during failures, how each DNS resolver did, and what the data cannot show. The last 7 days unless a period is given. Use this for any request to gather logs, evidence or a report of connection issues.',
  inputSchema: {
    type: 'object',
    properties: { ...PERIOD_PROPERTIES, ...WHICH_PROPERTIES, ...TIMEZONE_PROPERTY },
    additionalProperties: false,
  },
  run: async args => {
    const period = periodFrom(args, 7 * DAY_MS)
    const timeZone = timeZoneFrom(args)
    const all = await getAllTargets()
    const chosen = targetsFrom(all, args)
    const nameOf = namer(all)

    const series = await gather(chosen, all, period, timeZone)
    // Outages are what the report is about, and are listed all but in full.
    // Spells of loss can run to one an evening for every target, which would
    // bury them: the worst are listed, the rest counted, and the hour-by-hour
    // further down is where their pattern shows. get_incidents has them all.
    const outages = incidentLines(series, timeZone, 60, incident => incident.kind === 'outage')
    const loss = incidentLines(series, timeZone, 20, incident => incident.kind === 'loss')
    const affected = series.filter(each => each.incidents.length > 0)
    const everyOutage = series.flatMap(each => outagesOf(each).map(incident => ({ target: each.label, incident })))
    const longest = [...everyOutage].sort((a, b) => b.incident.durationMs - a.incident.durationMs)[0]

    // The hour-by-hour of the targets that had the worst of it. All of them
    // would be a day's worth of rows for every target that had one blip.
    const worst = [...affected]
      .sort((a, b) => timeIn(outagesOf(b)) - timeIn(outagesOf(a)) || b.summary.lossPercent - a.summary.lossPercent)
      .slice(0, 4)

    const [routes, silences, dns] = await Promise.all([
      tracesFor(chosen, nameOf, period, timeZone, 10),
      Promise.resolve(monitorSilences(series, timeZone)),
      Promise.all(
        chosen
          .filter(target => (target.probeConfig?.resolvers?.length ?? 0) > 1 && target.probeType === 'dns')
          .map(async target => ({ target: nameOf(target), results: await resolversOf(target, period) }))
      ),
    ])

    const local = chosen.filter(target => isPrivateAddress(target.resolvedAddress ?? target.host))
    const unmeasured = series.filter(each => each.summary.probes === 0)

    return {
      generatedAt: isoIn(Date.now(), timeZone),
      period: {
        from: isoIn(period.start.getTime(), timeZone),
        to: isoIn(period.end.getTime(), timeZone),
        length: humanDuration(period.end.getTime() - period.start.getTime()),
      },
      timeZone,
      measuredBy:
        'ClearPing, a network monitor running on one machine at the customer\'s premises. It probes each target on a fixed schedule and records every result.',
      howToRead: HOW_TO_READ,
      totals: {
        targetsMonitored: series.length,
        targetsWithIncidents: affected.length,
        outages: everyOutage.length,
        spellsOfLoss: series.reduce((sum, each) => sum + each.incidents.length, 0) - everyOutage.length,
        longestOutage: longest
          ? { target: longest.target, started: isoIn(longest.incident.start, timeZone), duration: humanDuration(longest.incident.durationMs) }
          : null,
      },
      targets: chosen.map(target => describeTarget(target, nameOf(target))),
      results: series.map(each => seriesLine(each, timeZone)),
      outages: outages.lines,
      ...(outages.total > outages.lines.length ? { outagesNotListed: outages.total - outages.lines.length } : {}),
      spellsOfLoss: {
        total: loss.total,
        ...(loss.total > loss.lines.length ? { listed: `The ${loss.lines.length} longest. get_incidents with kind "loss" lists them all.` } : {}),
        worst: loss.lines,
      },
      byHourOfDay: {
        howToRead: 'The whole period folded into one day, for the targets with the most trouble. One line an hour: probes taken, probes with no reply, mean loss, median latency.',
        targets: worst.map(each => ({ target: each.label, hours: each.hours.map(hourLine) })),
      },
      traceroutes: routes.lines,
      ...(routes.total > routes.lines.length ? { routesNotListed: routes.total - routes.lines.length } : {}),
      dnsResolvers: dns,
      monitorNotRunning: silences,
      caveats: [
        'Every probe is taken from one machine. A fault in that machine or its own connection to the local network looks the same as a fault further out, unless a target inside the local network kept answering.',
        local.length > 0
          ? `Inside the local network: ${local.map(nameOf).join(', ')}. If these answered during an incident, the local network was working.`
          : 'No target inside the local network (a router or gateway on a private address) is monitored, so this data cannot by itself show whether a failure was in the local network or beyond it.',
        ...(silences.length > 0
          ? ['During the stretches under monitorNotRunning nothing was probed. No reading there is not evidence either way.']
          : []),
        ...(unmeasured.length > 0 ? [`No readings in this period for: ${shortList(unmeasured.map(each => each.label)).join(', ')}.`] : []),
        ...(routes.total === 0
          ? ['No traceroute was saved in this period, so there is no hop-by-hop evidence of where a failure was. One is saved automatically when a loss alert fires on a target.']
          : []),
      ],
    }
  },
}

// ─── The tools that change something ────────────────────────────────────────

/**
 * These are only there for a connection that sent the token, and there are
 * few of them on purpose. An assistant can add a target, change one, pause it
 * and take a reading. It cannot delete: a target's history goes with it and
 * does not come back, and that is a button for a person to press. Nor can it
 * touch an alert, which is a URL with a password in it and a message sent to
 * someone.
 *
 * What is added goes through the same check as the form in the app, so there
 * is nothing an assistant can create here that a person could not.
 */

/** The most one request can add: a list, not a scan of a network. */
const MAX_ADDED_AT_ONCE = 50

const isRecord = (value: unknown): value is Args => typeof value === 'object' && value !== null && !Array.isArray(value)

const TARGET_PROPERTIES = {
  name: { type: 'string', description: 'What to call it. Its address, if left out.' },
  probe: {
    type: 'string',
    enum: PROBE_TYPES,
    description:
      'How to check it: "ping" (ICMP), "tcp" (a port accepts connections), "http" (a page loads) or "dns" (a lookup answers). Left out, it is taken from the address: a URL is http, host:port is tcp, anything else ping.',
  },
  group: { type: 'string', description: 'The group to put it in, as a path: "Home/Network". Made if it is not there. An empty string for no group.' },
  interval_seconds: { type: 'number', description: 'How often to probe it, from 10 to 86400 seconds. 300 unless said.' },
  ip_version: {
    type: 'string',
    enum: IP_VERSIONS,
    description: 'For a hostname: "auto", "ipv4", "ipv6", or "both" to probe over each and chart them side by side.',
  },
  settings: {
    type: 'object',
    description:
      'What only that probe has. tcp: port (required unless it is in the address). http: scheme ("http" or "https"), port, path, expectedStatus, keyword (text the page must contain). ' +
      'dns on a server address: queryName, recordType, expectedAnswer. dns on a hostname: resolvers (a list of { protocol: "system" | "udp" | "dot" | "doh", server, name }), recordType, expectedAnswer.',
  },
} as const

const TARGET_REFERENCE = { type: 'string', description: 'The target, by its name, its address or its id.' } as const

/** A target as the app would add it, from what an assistant gave for it. `where` says which one, in an error. */
function definitionFrom(input: Args, where: string, existing?: Target): TargetDefinition {
  const address = typeof input.address === 'string' ? input.address.trim() : ''
  if (!address && !existing) throw new ToolError(`${where}: give its address.`)

  // An address can carry more than a host, as it can in the app: a URL is a
  // web page to load, and host:port a port to connect to.
  const parsed = address ? parseAddressInput(address) : null
  const host = parsed?.host ?? existing?.host ?? ''
  const probeType = input.probe ?? parsed?.probeType ?? existing?.probeType ?? 'ping'
  // Settings belong to one kind of probe. A target changed to another kind
  // starts from none, as it does when the method is changed in the app.
  const kept = existing && existing.probeType === probeType ? existing.probeConfig ?? {} : {}

  const checked = validateTargetDefinition({
    name: typeof input.name === 'string' && input.name.trim() ? input.name : existing?.name ?? host,
    host,
    probeType,
    ipVersion: input.ip_version ?? existing?.ipVersion,
    probeConfig: { ...kept, ...(parsed?.config ?? {}), ...(isRecord(input.settings) ? input.settings : {}) },
    interval: input.interval_seconds ?? existing?.interval ?? 300,
    group: typeof input.group === 'string' ? input.group : existing?.group,
  })
  if (!checked.ok) throw new ToolError(`${where}: ${checked.error}.`)
  return checked.target
}

const addTargetsTool: McpTool = {
  name: 'add_targets',
  title: 'Add targets',
  writes: true,
  description:
    `Start monitoring one or more new targets, up to ${MAX_ADDED_AT_ONCE} at once. Each needs only an address: a hostname, an IP address, host:port or a URL. ` +
    'All of them are checked before any is added, and none is added if one is wrong. A target that is already monitored the same way is passed over and reported, not added twice. ' +
    'Say what you are going to add before calling this.',
  inputSchema: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ADDED_AT_ONCE,
        items: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'A hostname, an IP address, host:port, or a URL: "192.168.1.1", "db.internal:5432", "https://example.com/health".' },
            ...TARGET_PROPERTIES,
          },
          required: ['address'],
          additionalProperties: false,
        },
      },
    },
    required: ['targets'],
    additionalProperties: false,
  },
  run: async args => {
    const entries = args.targets
    if (!Array.isArray(entries) || entries.length === 0) throw new ToolError('Give the targets to add, as a list.')
    if (entries.length > MAX_ADDED_AT_ONCE) throw new ToolError(`At most ${MAX_ADDED_AT_ONCE} targets can be added at once.`)

    const all = await getAllTargets()
    const monitored = new Map(all.map(target => [measurementKey(target), target.name]))
    const definitions: TargetDefinition[] = []
    const alreadyMonitored: Array<{ address: string; as: string }> = []

    entries.forEach((entry, index) => {
      const input = isRecord(entry) ? entry : {}
      const definition = definitionFrom(input, `Target ${index + 1}${typeof input.address === 'string' ? ` (${input.address})` : ''}`)
      const key = measurementKey(definition)
      const as = monitored.get(key)

      if (as !== undefined) alreadyMonitored.push({ address: String(input.address), as })
      else {
        monitored.set(key, definition.name)
        definitions.push(definition)
      }
    })

    const created = definitions.length > 0 ? await addTargets(definitions) : []
    return {
      added: created.map(target => describeTarget(target, target.name)),
      ...(alreadyMonitored.length > 0 ? { alreadyMonitored } : {}),
      note:
        created.length > 0
          ? 'Their first readings arrive within about a minute. probe_now takes one straight away.'
          : 'Nothing was added: every one of them is already monitored.',
    }
  },
}

const updateTargetTool: McpTool = {
  name: 'update_target',
  title: 'Change a target',
  writes: true,
  description:
    'Change a target: its name, group, how often it is probed, its address, how it is checked or that probe\'s settings. Only what is given is changed, and settings given are added to the ones it has. ' +
    'Its history is kept; changing the address or the probe means the readings from then on measure something else. Say what you are going to change before calling this.',
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_REFERENCE,
      address: { type: 'string', description: 'A new address for it: a hostname, an IP address, host:port, or a URL.' },
      ...TARGET_PROPERTIES,
    },
    required: ['target'],
    additionalProperties: false,
  },
  run: async args => {
    const all = await getAllTargets()
    const existing = findTarget(all, args.target)
    const wanted = definitionFrom(args, existing.name, existing)

    // Only what is different is written, so that a change of name does not
    // also count as a change of address and forget where the name resolved to.
    const changes: Partial<Target> = {}
    if (wanted.name !== existing.name) changes.name = wanted.name
    if (wanted.host !== existing.host) changes.host = wanted.host
    if (wanted.probeType !== existing.probeType) changes.probeType = wanted.probeType
    if (wanted.ipVersion !== (existing.ipVersion ?? 'auto')) changes.ipVersion = wanted.ipVersion
    if (wanted.interval !== existing.interval) changes.interval = wanted.interval
    if ((wanted.group ?? '') !== normalizeGroupPath(existing.group)) changes.group = wanted.group ?? ''
    if (JSON.stringify(wanted.probeConfig) !== JSON.stringify(existing.probeConfig ?? {})) changes.probeConfig = wanted.probeConfig

    const changed = Object.keys(changes)
    if (changed.length === 0) throw new ToolError(`Nothing to change: ${existing.name} is already as asked.`)

    await updateTarget(existing.id, changes)
    await getScheduler().reloadTargets()

    const updated = (await getTargetById(existing.id)) ?? existing
    return { changed, target: describeTarget(updated, updated.name) }
  },
}

const pauseTargetTool: McpTool = {
  name: 'set_target_paused',
  title: 'Pause or resume a target',
  writes: true,
  description:
    'Stop probing a target, or start again. A paused target keeps everything it has recorded and is counted as neither online nor offline. This is how to stop monitoring something: nothing here deletes a target.',
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_REFERENCE,
      paused: { type: 'boolean', description: 'true to stop probing it, false to start again.' },
    },
    required: ['target', 'paused'],
    additionalProperties: false,
  },
  run: async args => {
    if (typeof args.paused !== 'boolean') throw new ToolError('Say whether to pause it: paused must be true or false.')
    const target = findTarget(await getAllTargets(), args.target)
    const already = (target.status === 'paused') === args.paused

    if (!already) {
      await updateTarget(target.id, { status: args.paused ? 'paused' : 'active' })
      await getScheduler().reloadTargets()
    }
    return {
      target: target.name,
      paused: args.paused,
      note: already ? `It was ${args.paused ? 'paused' : 'being probed'} already.` : args.paused ? 'No further probes will run until it is resumed.' : `Probing every ${target.interval}s.`,
    }
  },
}

const probeNowTool: McpTool = {
  name: 'probe_now',
  title: 'Probe a target now',
  writes: true,
  description:
    'Take a reading of a target straight away, outside its schedule, and say how it went. The reading is kept with the rest of its history. Use it after adding a target, or to see whether something is down at this moment.',
  inputSchema: {
    type: 'object',
    properties: { target: TARGET_REFERENCE, ...TIMEZONE_PROPERTY },
    required: ['target'],
    additionalProperties: false,
  },
  run: async args => {
    const timeZone = timeZoneFrom(args)
    const target = findTarget(await getAllTargets(), args.target)
    const { result, results } = await probeNow(target)

    const describe = (each: typeof result) => ({
      at: isoIn(each.timestamp.getTime(), timeZone),
      answering: each.success,
      lossPercent: round(each.packetLoss ?? 0, 1),
      latencyMs: each.latency === null ? null : round(each.latency, 2),
      ...(each.resolvedAddress ? { address: each.resolvedAddress } : {}),
      ...(each.errorMessage ? { error: each.errorMessage } : {}),
    })

    return {
      target: target.name,
      ...describe(result),
      ...(results.length > 1
        ? { byIpVersion: Object.fromEntries(results.map(each => [each.family ? FAMILY_LABEL[each.family] : 'unknown', describe(each)])) }
        : {}),
    }
  },
}

const traceRouteTool: McpTool = {
  name: 'run_traceroute',
  title: 'Trace the route to a target now',
  writes: true,
  description:
    'Trace the route to a target now, hop by hop, and save it with its other routes. Takes a few seconds for a path that works and up to a minute and a half for one that goes nowhere. Use it while something is failing: the route through a failure can only be traced while it lasts.',
  inputSchema: {
    type: 'object',
    properties: { target: TARGET_REFERENCE, ...TIMEZONE_PROPERTY },
    required: ['target'],
    additionalProperties: false,
  },
  run: async args => {
    const timeZone = timeZoneFrom(args)
    const target = findTarget(await getAllTargets(), args.target)
    await ensureTracerouteSchema()
    const traces = await traceAndStore(target, 'manual')
    return { traceroutes: traces.map(trace => describeTrace(trace, target.name, timeZone)) }
  },
}

// ─── The prompt ─────────────────────────────────────────────────────────────

const ispReportPrompt: McpPrompt = {
  name: 'isp_report',
  title: 'Write a report for my ISP',
  description: 'Gathers the evidence of connection problems over a period and writes it up as a report to give to an internet provider.',
  arguments: [
    { name: 'days', description: 'How many days back to cover. 7 if left out.' },
    { name: 'isp', description: 'The name of the internet provider the report is for.' },
    { name: 'format', description: 'What to produce: "pdf", "text" or "markdown". PDF if left out and you can make one.' },
  ],
  render: args => {
    const days = Number(args.days) > 0 ? Number(args.days) : 7
    const to = args.isp ? `my internet provider, ${args.isp}` : 'my internet provider'
    const format = args.format ? `as ${args.format}` : 'as a PDF if you can make one, and as a plain text file if not'

    return [
      `Write a report of the problems with my internet connection over the last ${days} days, for me to send to ${to}.`,
      '',
      `Call build_isp_report with days=${days} to get the evidence. Call get_target_history, get_incidents or get_traceroutes if you need more detail on something it shows.`,
      '',
      'The report should have, in this order:',
      '1. A summary of a few sentences: what is wrong, how often, and how bad, with the period covered.',
      '2. How it was measured, in two or three sentences, from "measuredBy" and the list of targets.',
      '3. A table of the outages: start, end, duration, what was affected, and what kept working at the same time. Several targets failing over the same minutes is one outage, not several. Give times with their UTC offset. Then the spells of packet loss: how many, the worst of them, and when in the day they fall.',
      '4. What points at the provider, and what does not: use "meanwhile", the targets inside the local network, the traceroutes and the hour-of-day figures. Say plainly where the evidence is strong and where it is not.',
      '5. A table of each target\'s uptime, loss and latency over the period.',
      '6. What the data cannot show, from "caveats". Keep these in: an engineer who finds an overstated claim will discount the rest.',
      '7. What I am asking the provider to do.',
      '',
      'Use only figures that are in the data. Do not estimate, round an outage up, or guess at a cause the evidence does not support. If the data shows no real problem in the period, say that instead of writing a complaint.',
      '',
      `Write for a support agent who will pass it to a network engineer: factual, specific and short. Produce it ${format}.`,
    ].join('\n')
  },
}

// ─── The server ─────────────────────────────────────────────────────────────

export const clearPingMcp: McpServer = {
  name: 'clearping',
  title: 'ClearPing',
  version: currentBuild().version,
  instructions:
    'ClearPing is a self-hosted network monitor: it probes hosts on a schedule (ping, TCP, HTTP, DNS) and keeps every result. ' +
    'These tools read that history; none of them changes anything. ' +
    'For a request to gather logs or evidence of connection problems, or to report them to an ISP, call build_isp_report and write from what it returns. ' +
    'Use list_targets to learn what is monitored, get_target_history for one target in depth, get_incidents for outages across targets, ' +
    'get_traceroutes for the route to a target, and get_dns_resolvers to compare the resolvers of a DNS target. ' +
    'Report only figures the tools return, with their times and UTC offsets, and pass on the caveats they give.',
  writeInstructions:
    'This connection sent the token, so it can also change things: add_targets, update_target, set_target_paused, probe_now and run_traceroute. ' +
    'Tell the person what you are about to add or change before you do it, and make only the changes they asked for. ' +
    'Nothing can be deleted from here and alerts cannot be seen or changed: for either, point the person to the ClearPing app.',
  tools: [
    listTargets,
    ispReport,
    incidents,
    targetHistory,
    traceroutes,
    dnsResolvers,
    addTargetsTool,
    updateTargetTool,
    pauseTargetTool,
    probeNowTool,
    traceRouteTool,
  ],
  prompts: [ispReportPrompt],
}
