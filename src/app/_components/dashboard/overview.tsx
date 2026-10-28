'use client'

import { useMemo, type ReactNode } from 'react'
import { Activity, ChartLine, CircleX, MapPin, Plus, RadioTower, Server } from 'lucide-react'
import type { GroupOrder, LatestMeasurement, Target } from '@/types/probe'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import type { OverviewEvent, OverviewReport, OverviewSlice } from '@/types/overview'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { MetricCard } from '@/components/arc/metric-card/metric-card'
import { Timeline, type TimelineEvent } from '@/components/arc/timeline/timeline'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { alertTitle } from '@/lib/alerts/delivery'
import { isMeaningfulLoss, NO_DATA_COLOR, NO_REPLY_COLOR, SIGNAL_VARS } from '@/lib/charts/packet-loss-colors'
import { probeVocabulary } from '@/lib/probes/labels'
import { humanDuration } from '@/lib/reports/evidence'
import { describeGroupHealth, groupIsOnline, groupIsPaused, summarizeGroupHealth } from '@/lib/targets/group-health'
import { groupLabel, groupName } from '@/lib/targets/group-path'
import { buildSidebarLayout, subgroups, targetsWithin } from '@/lib/targets/sidebar-layout'
import { displayLocale, displayTimeZone, inDisplayZone, wallClock } from '@/lib/time-zone'
import { cn } from '@/lib/utils'
import type { AlertResponse } from '../alerts/alerts-view'
import { PROBE_AGENT_STATE } from '../settings/probe-agent-labels'
import { StatusIndicator } from '../sidebar/status-indicator'
import { PANE, PANE_HEADER, PANE_TITLE } from './pane-layout'
import { RoutingGlance } from './routing-glance'
import { OverviewDaySkeleton, OverviewSkeleton } from './skeleton'
import { useOverview } from './use-overview'

/**
 * Everything at a glance, and where the dashboard opens.
 *
 * Two questions, in order: is anything wrong now, and how has the day gone.
 * What is wrong now comes from the readings the sidebar already has. The day
 * comes from /api/overview, which reads every probe in it and puts the
 * failures that happened together into one event, with where the fault lay.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

/** A panel of the page, as the panels on a target's page are drawn. */
const PANEL = 'rounded-3xl border border-border bg-card p-4 text-foreground @2xl/main:p-6'

interface OverviewPageProps {
  /** As the sidebar has them: with each one's newest reading and the probe agent it is probed from. */
  targets: Target[]
  latest: Record<string, LatestMeasurement>
  probeAgents: ProbeAgentSummary[]
  alerts: AlertResponse[]
  groups: string[]
  groupOrders: GroupOrder[]
  loaded: boolean
  /** Moves on whenever any target is probed again. */
  refreshKey: number
  readOnly: boolean
  onSelectTarget: (id: string) => void
  onSelectGroup: (group: string) => void
  /** Lists the targets probed from one place in the sidebar: a probe agent's id, or `local` for this server. */
  onShowTargetsFrom: (from: string) => void
  onAddTarget: () => void
  onOpenRouting: () => void
  onOpenRoutingPrefix: (id: string) => void
  reportError: (title: string, error?: unknown) => void
}

/**
 * Loss in the latest probe that puts a target on the list to look at. A ping
 * of 20 that lost one is 5%, and ICMP is dropped that way all day long; one
 * reading of it is not something to be told about on the front page.
 */
const ATTENTION_LOSS = 10

/** Targets listed under Needs attention before the rest are only counted. */
const ATTENTION_ROWS = 5

/**
 * A closed-port check that has never had an answer cannot measure its server
 * (see the sidebar), so it counts as not measured yet, never as down.
 */
const asMeasured = (target: Target): Target => (target.neverAnswered ? { ...target, isOnline: undefined } : target)

/** Where each target stands now. Paused ones are left out of everything but their count. */
function standing(targets: Target[]) {
  const active = targets.filter(target => target.status !== 'paused')
  return {
    active,
    paused: targets.length - active.length,
    // Its probe agent being down says nothing of the target: those are held apart.
    onHold: active.filter(target => target.onHold),
    down: active.filter(target => !target.onHold && target.isOnline === false),
    lossy: active.filter(target => !target.onHold && target.isOnline === true && (target.packetLoss ?? 0) >= ATTENTION_LOSS),
    answering: active.filter(target => !target.onHold && target.isOnline === true),
  }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** A short list of names: "A, B and 3 more". */
function nameList(names: string[], shown = 3): string {
  if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? ''
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
}

const clock = (time: number) => new Date(time).toLocaleTimeString(undefined, inDisplayZone({ hour: '2-digit', minute: '2-digit' }))

// ─── Now ────────────────────────────────────────────────────────────────────

function Headline({ now, agentsDown }: { now: ReturnType<typeof standing>; agentsDown: ProbeAgentSummary[] }) {
  if (now.down.length > 0) {
    return (
      <Alert tone="danger" title={`${plural(now.down.length, 'target')} not answering`}>
        {nameList(now.down.map(target => target.name))} {now.down.length === 1 ? 'is' : 'are'} getting no reply.
      </Alert>
    )
  }
  if (agentsDown.length > 0) {
    return (
      <Alert tone="warning" title={`${plural(agentsDown.length, 'probe agent')} cannot be reached`}>
        No readings are coming from {nameList(agentsDown.map(agent => agent.name))}, so {plural(now.onHold.length, 'target')} probed from
        there {now.onHold.length === 1 ? 'is' : 'are'} on hold.
      </Alert>
    )
  }
  if (now.lossy.length > 0) {
    return (
      <Alert tone="warning" title={`Everything is answering, ${now.lossy.length} with loss`}>
        {nameList(now.lossy.map(target => target.name))} lost {ATTENTION_LOSS}% or more of the packets, queries or requests in the latest probe.
      </Alert>
    )
  }
  if (now.answering.length === 0) {
    return <Alert tone="info" title="Waiting for the first readings">Targets are probed as soon as they are added.</Alert>
  }
  return (
    <Alert tone="success" title="Everything is answering">
      All {plural(now.answering.length, 'target')} answered in full the last time {now.answering.length === 1 ? 'it was' : 'they were'} probed.
    </Alert>
  )
}

/** The targets that are wrong now, each with why and for how long. */
function Attention({
  now,
  latest,
  report,
  onSelectTarget,
}: {
  now: ReturnType<typeof standing>
  latest: Record<string, LatestMeasurement>
  report: OverviewReport | null
  onSelectTarget: (id: string) => void
}) {
  const all = [...now.down, ...now.lossy, ...now.onHold]
  if (all.length === 0) return null
  // The worst first, and only a few: the sidebar has the full list.
  const rows = all.slice(0, ATTENTION_ROWS)

  // Since when: the start of the event it is in that has not ended.
  const since = (id: string) =>
    report?.events.find(event => event.ongoing && event.targets.some(each => each.targetId === id))?.start

  return (
    <section className={PANEL} aria-labelledby="overview-attention">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="overview-attention" className="text-sm font-medium">Needs attention</h2>
        {all.length > rows.length && (
          <p className="text-xs text-muted-foreground">{all.length - rows.length} more in the sidebar</p>
        )}
      </div>
      <ul className="mt-3 divide-y divide-border">
        {rows.map(target => {
          const started = since(target.id)
          const why = target.onHold
            ? target.onHold
            : target.isOnline === false
              ? latest[target.id]?.errorMessage ?? 'No reply'
              : `${(target.packetLoss ?? 0).toFixed(1)}% lost in the latest probe`
          return (
            <li key={target.id}>
              <button
                type="button"
                onClick={() => onSelectTarget(target.id)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/40"
              >
                <StatusIndicator isOnline={target.isOnline} packetLoss={target.packetLoss} onHold={target.onHold} bare />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{target.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{why}</span>
                </span>
                {started !== undefined && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">since {clock(started)}</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ─── The day ────────────────────────────────────────────────────────────────

function sliceColour(slice: OverviewSlice): string {
  if (slice.watched === 0) return NO_DATA_COLOR
  if (slice.down > 0) return NO_REPLY_COLOR
  if (slice.lossy > 0) return SIGNAL_VARS.minor
  return SIGNAL_VARS.perfect
}

function sliceNote(slice: OverviewSlice, sliceMs: number): string {
  const when = `${clock(slice.start)} to ${clock(slice.start + sliceMs)}`
  if (slice.watched === 0) return `${when}: nothing probed`
  const parts = [
    slice.down > 0 && `${slice.down} not answering`,
    slice.lossy > 0 && `${slice.lossy} losing packets`,
  ].filter(Boolean)
  return `${when}: ${parts.length > 0 ? parts.join(', ') : `all ${slice.watched} answering`}`
}

/** The day in quarters of an hour: green where everything answered, red where something did not. */
function DayStrip({ report }: { report: OverviewReport }) {
  const { slices, sliceMs } = report
  const troubled = slices.filter(slice => slice.down > 0).length
  // "All day" only of a day that was watched all through.
  const watched = slices.filter(slice => slice.watched > 0).length
  const quiet = watched === slices.length ? 'Every target answered all day' : `Every target answered in the ${humanDuration(watched * sliceMs)} probed`
  // A label every six hours, on the hour, on the clock times are shown by.
  const zone = displayTimeZone()
  const ticks = slices
    .map((slice, index) => ({ slice, index }))
    .filter(({ slice }) => {
      const { hour, minute } = wallClock(slice.start, zone)
      return minute === 0 && hour % 6 === 0
    })

  return (
    <section className={PANEL} aria-labelledby="overview-day">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="overview-day" className="text-sm font-medium">Last 24 hours</h2>
        <p className="text-xs text-muted-foreground">
          {troubled === 0 ? quiet : `Something was not answering in ${humanDuration(troubled * sliceMs)} of it`}
        </p>
      </div>
      <div className="mt-4 flex h-8 @xl/main:h-10 @xl/main:gap-px" role="img" aria-label={`The last 24 hours in quarters of an hour. ${troubled} had a target not answering.`}>
        {slices.map(slice => (
          <Tooltip key={slice.start} content={sliceNote(slice, sliceMs)}>
            <span className="h-full min-w-0 flex-1 @xl/main:rounded-xs" style={{ background: sliceColour(slice) }} />
          </Tooltip>
        ))}
      </div>
      <div className="relative mt-1.5 h-4 font-mono text-[11px] text-muted-foreground" aria-hidden="true">
        {/* At the left edge of the slice that starts on the hour. */}
        {ticks.map(({ slice, index }) => (
          <span key={slice.start} className="absolute -translate-x-1/2" style={{ left: `${(index / slices.length) * 100}%` }}>
            {clock(slice.start)}
          </span>
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[
          { colour: SIGNAL_VARS.perfect, label: 'All answering' },
          { colour: SIGNAL_VARS.minor, label: 'Some losing packets' },
          { colour: NO_REPLY_COLOR, label: 'Something not answering' },
          { colour: NO_DATA_COLOR, label: 'Nothing probed' },
        ].map(({ colour, label }) => (
          <li key={label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-xs" style={{ background: colour }} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Where an event's fault lay, as a reader would want it said. */
function scopeNote(event: OverviewEvent, fromAgent: string | undefined): string | null {
  const affected = event.targets.length
  switch (event.scope) {
    case 'local':
      return fromAgent
        ? `Something inside ${fromAgent}'s own network stopped answering too`
        : 'Something inside your own network stopped answering too'
    case 'single':
      return `Only this target: the other ${plural(event.watched - 1, 'target')} probed from ${fromAgent ?? 'here'} kept answering`
    case 'beyond':
      return `Beyond the local network: ${plural(affected, 'target')} of ${event.watched}, while everything inside it kept answering`
    case 'unclear':
      return affected > 1 ? `${affected} of the ${event.watched} targets probed from ${fromAgent ?? 'here'}` : null
  }
}

function eventTitle(event: OverviewEvent, nameOf: (id: string) => string): string {
  const who = event.targets.length === 1 ? nameOf(event.targets[0].targetId) : `${event.targets.length} targets`
  const what = event.kind === 'outage' ? 'stopped answering' : 'lost packets'
  return event.ongoing ? `${who} ${event.kind === 'outage' ? 'not answering' : 'losing packets'}` : `${who} ${what}`
}

/** The events of the day, and the probe agents' outages among them, newest first. */
function Events({
  report,
  targetsById,
  probeAgents,
  onSelectTarget,
}: {
  report: OverviewReport
  targetsById: Map<string, Target>
  probeAgents: ProbeAgentSummary[]
  onSelectTarget: (id: string) => void
}) {
  const agentName = (id: string | null) => (id ? probeAgents.find(agent => agent.id === id)?.name ?? 'a removed probe agent' : undefined)
  const nameOf = (id: string) => targetsById.get(id)?.name ?? 'A deleted target'

  const events: TimelineEvent[] = [
    ...report.events.map((event): TimelineEvent => {
      const fromAgent = agentName(event.probeAgentId)
      const duration = `${humanDuration(event.durationMs)}${event.ongoing ? ' so far' : event.end === null ? ', end not seen' : ''}`
      return {
        id: event.id,
        at: event.start,
        title: eventTitle(event, nameOf),
        meta: [duration, scopeNote(event, fromAgent)].filter(Boolean).join(' · '),
        tone: event.ongoing ? 'danger' : 'neutral',
        icon: event.kind === 'outage' ? <CircleX {...ICON} /> : <Activity {...ICON} />,
        detail: (
          <ul className="space-y-1.5">
            {event.targets.map(each => (
              <li key={each.targetId} className="text-xs">
                <button
                  type="button"
                  className="cursor-pointer font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => onSelectTarget(each.targetId)}
                >
                  {targetsById.has(each.targetId) ? each.label : nameOf(each.targetId)}
                </button>
                {each.reasons.length > 0 && <span className="text-muted-foreground">: {each.reasons.join('; ')}</span>}
              </li>
            ))}
          </ul>
        ),
      }
    }),
    ...Object.entries(report.probeAgentOutages).flatMap(([id, outages]) =>
      outages.map((outage): TimelineEvent => {
        const end = outage.end ?? report.end
        return {
          id: `probe-agent:${id}:${outage.start}`,
          at: Math.max(outage.start, report.start),
          title: `Probe agent ${agentName(id)} ${outage.end === null ? 'cannot be reached' : 'could not be reached'}`,
          meta: `${humanDuration(end - outage.start)}${outage.end === null ? ' so far' : ''} · Its targets took no readings meanwhile`,
          tone: outage.end === null ? 'danger' : 'neutral',
          icon: <RadioTower {...ICON} />,
        }
      })
    ),
  ]

  return (
    <section className={PANEL} aria-labelledby="overview-events">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="overview-events" className="text-sm font-medium">What happened</h2>
        {report.briefLossSpells > 0 && (
          <p className="text-xs text-muted-foreground">
            And {plural(report.briefLossSpells, 'brief spell')} of packet loss, too short to list
          </p>
        )}
      </div>
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No outages and no lasting loss in the last 24 hours.</p>
      ) : (
        <div className="mt-3">
          <Timeline
            label="Outages and loss in the last 24 hours"
            events={events}
            now={report.end}
            timeZone={displayTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
            locale={displayLocale()}
            maxHeight={560}
            scrollToNew={false}
            headingLevel={3}
          />
        </div>
      )}
    </section>
  )
}

// ─── The network ────────────────────────────────────────────────────────────

/** A tile in a grid of them: one group, or one place readings come from. */
const TILE =
  'flex min-w-0 cursor-pointer flex-col gap-1 rounded-2xl border border-border p-3 text-left transition-colors hover:bg-muted/40'

/**
 * The groups at the top of the sidebar as tiles, each lit by everything in
 * it: the network at a glance, and the way into any part of it.
 */
function Network({
  targets,
  groups,
  groupOrders,
  uptimeOf,
  onSelectTarget,
  onSelectGroup,
}: {
  targets: Target[]
  groups: string[]
  groupOrders: GroupOrder[]
  uptimeOf: (ids: string[]) => number | null
  onSelectTarget: (id: string) => void
  onSelectGroup: (group: string) => void
}) {
  const byId = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])
  const tiles = useMemo(() => {
    const layout = buildSidebarLayout(targets, groupOrders, groups)
    return subgroups(layout, '')
      .map(group => {
        const ids = targetsWithin(layout, group)
        return { group, ids, health: summarizeGroupHealth(ids.map(id => byId.get(id)).filter((target): target is Target => !!target)) }
      })
      .filter(({ ids }) => ids.length > 0)
  }, [targets, groups, groupOrders, byId])

  // How many of each kind of probe there are: "ICMP 22 · DNS 11".
  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const target of targets) {
      const method = probeVocabulary(target.probeType).method
      counts.set(method, (counts.get(method) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [targets])

  if (tiles.length === 0) return null

  return (
    <section className={PANEL} aria-labelledby="overview-network">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="overview-network" className="text-sm font-medium">Your network</h2>
        <ul className="flex flex-wrap gap-1.5" aria-label="Targets by kind of probe">
          {kinds.map(([method, count]) => (
            <li key={method}>
              <Badge size="sm">{method} {count}</Badge>
            </li>
          ))}
        </ul>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-2 @3xl/main:grid-cols-3 @6xl/main:grid-cols-4 @[100rem]/main:grid-cols-6">
        {tiles.map(({ group, ids, health }) => {
          const uptime = uptimeOf(ids)
          const state = describeGroupHealth(health)
          return (
            <li key={group} className="flex">
              <button
                type="button"
                // A group of one has nothing to compare, so it opens its target.
                onClick={() => (ids.length > 1 ? onSelectGroup(group) : onSelectTarget(ids[0]))}
                className={cn(TILE, 'w-full', health.offline > 0 && 'border-destructive/60')}
                aria-label={`${groupLabel(group)}: ${state}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <StatusIndicator isOnline={groupIsOnline(health)} packetLoss={health.worstLoss} paused={groupIsPaused(health)} bare />
                  <span className="truncate text-sm">{groupName(group)}</span>
                </span>
                <span className="truncate text-xs text-muted-foreground">{state}</span>
                {uptime !== null && (
                  <span className={cn('font-mono text-xs', uptime < 99.9 ? 'text-warning' : 'text-muted-foreground')}>
                    {uptime.toFixed(uptime === 100 ? 0 : 2)}% today
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * This server and each probe agent, as tiles. Only where there are probe
 * agents: with none, every reading is this server's and there is nothing to
 * tell apart.
 */
function ProbeAgents({
  targets,
  probeAgents,
  report,
  onShowTargetsFrom,
}: {
  targets: Target[]
  probeAgents: ProbeAgentSummary[]
  report: OverviewReport | null
  onShowTargetsFrom: (from: string) => void
}) {
  if (probeAgents.length === 0) return null

  const tile = (key: string, icon: ReactNode, name: string, badge: ReactNode, lines: string[], members: Target[]) => (
    <li key={key} className="flex">
      <button
        type="button"
        onClick={() => onShowTargetsFrom(key)}
        className={cn(TILE, 'w-full')}
        aria-label={`${name}: show its targets in the sidebar`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          <span className="truncate text-sm">{name}</span>
          {badge}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {members.length === 0 ? 'No targets' : `${plural(members.length, 'target')}: ${describeGroupHealth(summarizeGroupHealth(members))}`}
        </span>
        {lines.filter(Boolean).map(line => (
          <span key={line} className="truncate text-xs text-muted-foreground">{line}</span>
        ))}
      </button>
    </li>
  )

  return (
    <section className={PANEL} aria-labelledby="overview-sources">
      <h2 id="overview-sources" className="text-sm font-medium">Where readings come from</h2>
      <ul className="mt-3 grid gap-2 @xl/main:grid-cols-2 @5xl/main:grid-cols-3 @[100rem]/main:grid-cols-4">
        {tile('local', <Server {...ICON} />, 'This server', null, [], targets.filter(target => !target.probeAgentId))}
        {probeAgents.map(agent => {
          const outages = report?.probeAgentOutages[agent.id] ?? []
          const down = agent.state !== 'online' && agent.state !== 'unpaired'
          return tile(
            agent.id,
            <MapPin {...ICON} />,
            agent.name,
            <Badge size="sm" tone={PROBE_AGENT_STATE[agent.state].tone}>{PROBE_AGENT_STATE[agent.state].label}</Badge>,
            [
              [agent.hostname, agent.address].filter(Boolean).join(' · '),
              down && agent.lastSeenAt
                ? `Last seen ${new Date(agent.lastSeenAt).toLocaleString(undefined, inDisplayZone({ dateStyle: 'short', timeStyle: 'short' }))}`
                : outages.length === 0
                  ? 'Reachable all day'
                  : `${plural(outages.length, 'outage')} in the last 24 hours`,
            ],
            targets.filter(target => target.probeAgentId === agent.id)
          )
        })}
      </ul>
    </section>
  )
}

/** The targets that did worst over the day, for where to look first. */
/** The five that did worst: lowest uptime first, then most loss. Only ones that lost anything worth saying. */
function leastReliable(report: OverviewReport, targetsById: Map<string, Target>) {
  return report.targets
    .filter(each => each.probes > 0 && targetsById.has(each.targetId) && (each.uptimePercent < 100 || isMeaningfulLoss(each.lossPercent)))
    .sort((a, b) => a.uptimePercent - b.uptimePercent || b.lossPercent - a.lossPercent)
    .slice(0, 5)
}

function LeastReliable({
  worst,
  targetsById,
  onSelectTarget,
}: {
  worst: OverviewReport['targets']
  targetsById: Map<string, Target>
  onSelectTarget: (id: string) => void
}) {
  return (
    <section className={PANEL} aria-labelledby="overview-worst">
      <h2 id="overview-worst" className="text-sm font-medium">Least reliable today</h2>
      <table className="mt-3 w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="pb-2 font-normal">Target</th>
            <th className="pb-2 text-right font-normal">Uptime</th>
            <th className="pb-2 text-right font-normal">Loss</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {worst.map(each => (
            <tr key={each.targetId}>
              <td className="max-w-0 py-2 pr-2">
                <button
                  type="button"
                  className="block w-full cursor-pointer truncate text-left hover:underline"
                  onClick={() => onSelectTarget(each.targetId)}
                >
                  {targetsById.get(each.targetId)?.name}
                </button>
              </td>
              <td className={cn('py-2 text-right font-mono text-xs', each.uptimePercent < 99 ? 'text-destructive' : 'text-muted-foreground')}>
                {each.uptimePercent.toFixed(2)}%
              </td>
              <td className="py-2 pl-2 text-right font-mono text-xs text-muted-foreground">{each.lossPercent.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// ─── The page ───────────────────────────────────────────────────────────────

export function OverviewPage({
  targets: allTargets,
  latest,
  probeAgents,
  alerts,
  groups,
  groupOrders,
  loaded,
  refreshKey,
  readOnly,
  onSelectTarget,
  onSelectGroup,
  onShowTargetsFrom,
  onAddTarget,
  onOpenRouting,
  onOpenRoutingPrefix,
  reportError,
}: OverviewPageProps) {
  // The day leaves out the checks that have never answered; so does now.
  const report = useOverview(refreshKey, reportError)
  const targets = useMemo(() => allTargets.map(asMeasured), [allTargets])
  const now = useMemo(() => standing(targets), [targets])
  const targetsById = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])
  const agentsDown = probeAgents.filter(agent => agent.state !== 'online' && agent.state !== 'unpaired')

  const day = useMemo(() => {
    if (!report) return null
    const measured = report.targets.filter(each => each.probes > 0 && targetsById.has(each.targetId))
    const outages = report.events.filter(event => event.kind === 'outage')
    return {
      fullyUp: measured.filter(each => each.uptimePercent === 100).length,
      meanUptime: measured.length > 0 ? measured.reduce((sum, each) => sum + each.uptimePercent, 0) / measured.length : null,
      outages: outages.length,
      longest: outages.length > 0 ? Math.max(...outages.map(event => event.durationMs)) : null,
      uptimeById: new Map(measured.map(each => [each.targetId, each.uptimePercent])),
    }
  }, [report, targetsById])

  const worst = useMemo(() => (report ? leastReliable(report, targetsById) : []), [report, targetsById])

  const uptimeOf = (ids: string[]) => {
    const known = ids.map(id => day?.uptimeById.get(id)).filter((uptime): uptime is number => uptime !== undefined)
    return known.length > 0 ? known.reduce((sum, uptime) => sum + uptime, 0) / known.length : null
  }

  const enabledAlerts = alerts.filter(alert => alert.enabled)
  const firing = enabledAlerts.filter(alert => alert.targets.some(entry => entry.state === 'firing'))

  if (loaded && targets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<ChartLine size={24} strokeWidth={1.75} />}
          title="Nothing is being watched yet"
          description="Add a target to start measuring its latency and packet loss. The overview fills in from its first readings."
          action={readOnly ? undefined : <Button onClick={onAddTarget}><Plus {...ICON} />Add target</Button>}
        />
      </div>
    )
  }

  const sourcesLine =
    probeAgents.length === 0 ? 'probed from this server' : `probed from this server and ${plural(probeAgents.length, 'probe agent')}`

  // Until the targets are in, the page has nothing true to say: its figures
  // would read 0 of 0 and its headline that it waits for the first readings.
  // A placeholder in its shape holds the place instead.
  if (!loaded) {
    return (
      <div className={PANE}>
        <header className={PANE_HEADER}>
          <div className="min-w-0">
            <h1 className={PANE_TITLE}>Overview</h1>
            <div className="mt-2 h-4 w-64 max-w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none" aria-hidden="true" />
          </div>
        </header>
        <OverviewSkeleton />
      </div>
    )
  }

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {plural(targets.length, 'target')} {sourcesLine}
            {now.paused > 0 ? `, ${now.paused} paused` : ''}
          </p>
        </div>
        {refreshKey > 0 && (
          <p className="font-mono text-xs text-muted-foreground">Last reading {clock(refreshKey)}</p>
        )}
      </header>

      <Headline now={now} agentsDown={agentsDown} />

      {/* Two by two on a phone: four tiles one under another were a screen
          of scrolling before anything else. */}
      <div className="grid grid-cols-2 gap-3 @2xl/main:gap-4 @5xl/main:grid-cols-4">
        <MetricCard label="Answering now" value={now.answering.length} context={`of ${now.active.length} being probed`} />
        <MetricCard
          label="Up all day"
          value={day?.fullyUp ?? 0}
          context={day?.meanUptime != null ? `Average uptime ${day.meanUptime.toFixed(2)}%` : 'Reading the last 24 hours'}
        />
        <MetricCard
          label="Outages, 24h"
          value={day?.outages ?? 0}
          context={day ? (day.longest !== null ? `Longest ${humanDuration(day.longest)}` : 'None in 24 hours') : 'Reading the last 24 hours'}
        />
        <MetricCard
          label="Alerts firing"
          value={firing.length}
          context={
            firing.length > 0
              ? nameList(firing.map(alertTitle), 2)
              : enabledAlerts.length > 0
                ? `${plural(enabledAlerts.length, 'alert')} watching, all quiet`
                : 'No alerts set up'
          }
        />
      </div>

      {/* Now, from the top: what is wrong, the network as a whole, and where
          it is seen from. Then the day. */}
      <Attention now={now} latest={latest} report={report} onSelectTarget={onSelectTarget} />

      <RoutingGlance onOpenRouting={onOpenRouting} onOpenPrefix={onOpenRoutingPrefix} />

      <Network
        targets={targets}
        groups={groups}
        groupOrders={groupOrders}
        uptimeOf={uptimeOf}
        onSelectTarget={onSelectTarget}
        onSelectGroup={onSelectGroup}
      />

      <ProbeAgents targets={targets} probeAgents={probeAgents} report={report} onShowTargetsFrom={onShowTargetsFrom} />

      {report ? (
        <>
          <DayStrip report={report} />
          {/* Side by side where there is a list of the worst; the events the
              whole width where there is not. */}
          <div className={cn('grid items-start gap-4 @2xl/main:gap-6', worst.length > 0 && '@5xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
            <Events report={report} targetsById={targetsById} probeAgents={probeAgents} onSelectTarget={onSelectTarget} />
            {worst.length > 0 && <LeastReliable worst={worst} targetsById={targetsById} onSelectTarget={onSelectTarget} />}
          </div>
        </>
      ) : (
        <OverviewDaySkeleton />
      )}
    </div>
  )
}
