'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Activity, ChartLine, ChevronRight, CircleX, MapPin, Plus, RadioTower, Server, X } from 'lucide-react'
import type { GroupOrder, LatestMeasurement, Target } from '@/types/probe'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import type { IncidentKind, OverviewEvent, OverviewReport, OverviewSlice } from '@/types/overview'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { MetricCard } from '@/components/arc/metric-card/metric-card'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Timeline, type TimelineEvent } from '@/components/arc/timeline/timeline'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { alertTitle } from '@/lib/alerts/delivery'
import { NO_DATA_COLOR, NO_REPLY_COLOR, SIGNAL_VARS } from '@/lib/charts/packet-loss-colors'
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
 * Most important first: is anything wrong now, then how the day has gone,
 * then the network as a whole. What is wrong now comes from the readings the
 * sidebar already has. The day comes from /api/overview, which reads every
 * probe in it and puts the failures that happened together into one event,
 * with where the fault lay. Every problem leads to the target it was on.
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

/** One target's trouble over a stretch of the day, from the events it was in. */
interface Problem {
  targetId: string
  label: string
  /** The worse of what happened to it: an outage outranks loss. */
  kind: IncidentKind
  spells: number
  totalMs: number
  ongoing: boolean
  /** When its latest spell began. */
  latest: number
  reasons: string[]
}

/** Every target that went wrong between `from` and `to`, the ones still wrong first, then the longest. */
function problemsBetween(report: OverviewReport, from: number, to: number, targetsById: Map<string, Target>): Problem[] {
  const byTarget = new Map<string, Problem>()
  for (const event of report.events) {
    if ((event.end ?? report.end) <= from || event.start >= to) continue
    for (const each of event.targets) {
      if (!targetsById.has(each.targetId)) continue
      const was = byTarget.get(each.targetId)
      const problem: Problem = was ?? { targetId: each.targetId, label: each.label, kind: each.kind, spells: 0, totalMs: 0, ongoing: false, latest: 0, reasons: [] }
      problem.spells++
      problem.totalMs += event.durationMs
      problem.ongoing ||= event.ongoing
      problem.latest = Math.max(problem.latest, event.start)
      if (each.kind === 'outage') problem.kind = 'outage'
      for (const reason of each.reasons) if (!problem.reasons.includes(reason)) problem.reasons.push(reason)
      byTarget.set(each.targetId, problem)
    }
  }
  return [...byTarget.values()].sort(
    (a, b) => Number(b.ongoing) - Number(a.ongoing) || Number(b.kind === 'outage') - Number(a.kind === 'outage') || b.totalMs - a.totalMs
  )
}

type Show = 'all' | IncidentKind

/** Rows listed before "Show all". */
const PROBLEM_ROWS = 8

/**
 * The day in quarters of an hour, and under it who had trouble: the whole
 * day's, or one quarter's when it is picked on the strip. Each row opens its
 * target, so a red stretch leads straight to the probe that caused it.
 */
function Day({
  report,
  targetsById,
  onSelectTarget,
}: {
  report: OverviewReport
  targetsById: Map<string, Target>
  onSelectTarget: (id: string) => void
}) {
  const { slices, sliceMs } = report
  const [picked, setPicked] = useState<number | null>(null)
  const [show, setShow] = useState<Show>('all')
  const [everything, setEverything] = useState(false)

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

  const slice = picked !== null ? slices.find(each => each.start === picked) : undefined
  const from = slice ? slice.start : report.start
  const to = slice ? slice.start + sliceMs : report.end + 1
  const problems = problemsBetween(report, from, to, targetsById)
  const counts = {
    all: problems.length,
    outage: problems.filter(problem => problem.kind === 'outage').length,
    loss: problems.filter(problem => problem.kind === 'loss').length,
  }
  const shown = show === 'all' ? problems : problems.filter(problem => problem.kind === show)
  const rows = everything ? shown : shown.slice(0, PROBLEM_ROWS)
  const pick = (start: number) => {
    setPicked(was => (was === start ? null : start))
    setEverything(false)
  }

  return (
    <section className={PANEL} aria-labelledby="overview-day">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="overview-day" className="text-sm font-medium">Last 24 hours</h2>
        <p className="text-xs text-muted-foreground">
          {troubled === 0 ? quiet : `Something was not answering in ${humanDuration(troubled * sliceMs)} of it. Pick a red or amber stretch to see who.`}
        </p>
      </div>
      <div className="mt-4 flex h-8 @xl/main:h-10 @xl/main:gap-px" role="group" aria-label={`The last 24 hours in quarters of an hour. ${troubled} had a target not answering.`}>
        {slices.map(each => {
          const trouble = each.down > 0 || each.lossy > 0
          const style = { background: sliceColour(each) }
          const dimmed = picked !== null && picked !== each.start
          return (
            <Tooltip key={each.start} content={trouble ? `${sliceNote(each, sliceMs)}. Click to see who.` : sliceNote(each, sliceMs)}>
              {trouble ? (
                <button
                  type="button"
                  onClick={() => pick(each.start)}
                  aria-pressed={picked === each.start}
                  aria-label={sliceNote(each, sliceMs)}
                  className={cn(
                    'h-full min-w-0 flex-1 cursor-pointer transition-opacity @xl/main:rounded-xs hover:opacity-80',
                    dimmed && 'opacity-35',
                    picked === each.start && 'relative z-10 outline-2 outline-offset-1 outline-foreground'
                  )}
                  style={style}
                />
              ) : (
                <span className={cn('h-full min-w-0 flex-1 transition-opacity @xl/main:rounded-xs', dimmed && 'opacity-35')} style={style} />
              )}
            </Tooltip>
          )
        })}
      </div>
      <div className="relative mt-1.5 h-4 font-mono text-[11px] text-muted-foreground" aria-hidden="true">
        {/* At the left edge of the slice that starts on the hour. */}
        {ticks.map(({ slice: each, index }) => (
          <span key={each.start} className="absolute -translate-x-1/2" style={{ left: `${(index / slices.length) * 100}%` }}>
            {clock(each.start)}
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

      <div className="mt-5 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{slice ? 'Trouble at that time' : 'Trouble today'}</h3>
            {slice && (
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted/40"
                aria-label="Show the whole day again"
              >
                {clock(slice.start)} to {clock(slice.start + sliceMs)}
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
          {counts.outage > 0 && counts.loss > 0 && (
            <SegmentedControl
              label="Which trouble"
              value={show}
              onValueChange={value => {
                setShow(value as Show)
                setEverything(false)
              }}
              options={[
                { value: 'all', label: `All ${counts.all}` },
                { value: 'outage', label: `Not answering ${counts.outage}` },
                { value: 'loss', label: `Losing packets ${counts.loss}` },
              ]}
            />
          )}
        </div>

        {shown.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {slice && slice.lossy > 0
              ? 'Only brief packet loss then, too short to list. A target\'s chart shows it.'
              : slice
                ? 'Every target answered then.'
                : report.briefLossSpells > 0
                  ? `No outages and no lasting loss, only ${plural(report.briefLossSpells, 'brief spell')} of packet loss.`
                  : 'No outages and no lasting loss today.'}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {rows.map(problem => (
              <li key={problem.targetId}>
                <button
                  type="button"
                  onClick={() => onSelectTarget(problem.targetId)}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/40"
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: problem.kind === 'outage' ? NO_REPLY_COLOR : SIGNAL_VARS.minor }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm">{targetsById.get(problem.targetId)?.name ?? problem.label}</span>
                      {problem.ongoing && <Badge size="sm" tone="danger">Now</Badge>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {problem.kind === 'outage' ? 'Not answering' : 'Losing packets'}
                      {problem.reasons.length > 0 ? `: ${problem.reasons.slice(0, 2).join('; ')}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right font-mono text-xs text-muted-foreground">
                    <span className="block">
                      {humanDuration(problem.totalMs)}
                      {problem.spells > 1 ? `, ${problem.spells} times` : ''}
                    </span>
                    <span className="block">{problem.ongoing ? `since ${clock(problem.latest)}` : `last at ${clock(problem.latest)}`}</span>
                  </span>
                  <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {shown.length > rows.length && (
          <Button type="button" size="sm" variant="ghost" className="mt-1" onClick={() => setEverything(true)}>
            Show all {shown.length}
          </Button>
        )}
      </div>
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
        <h2 id="overview-events" className="text-sm font-medium">What happened, and where the fault lay</h2>
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

      {/* Most important first: what is wrong now, then the day and who had
          trouble in it, then the network as a whole. */}
      <Attention now={now} latest={latest} report={report} onSelectTarget={onSelectTarget} />

      {report ? (
        <>
          <Day report={report} targetsById={targetsById} onSelectTarget={onSelectTarget} />
          <Events report={report} targetsById={targetsById} probeAgents={probeAgents} onSelectTarget={onSelectTarget} />
        </>
      ) : (
        <OverviewDaySkeleton />
      )}

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
    </div>
  )
}
