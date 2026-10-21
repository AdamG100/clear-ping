'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CheckCircle2, ChevronDown, ChevronRight, Download, Route, Trash2, XCircle } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { CopyButton } from '@/components/arc/copy-button/copy-button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { TextShimmer } from '@/components/arc/text-shimmer/text-shimmer'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { useToast } from '@/components/notifications'
import { cn } from '@/lib/utils'
import { mean } from '@/lib/probes/metrics'
import {
  addressFamilyFor,
  canChooseTraceFamily,
  defaultTraceFamilies,
  FAMILY_LABEL,
  type AddressFamily,
  type TraceFamilies,
} from '@/lib/probes/host'
import { newestPerFamily } from '@/lib/traceroute/parse'
import {
  endToEnd,
  formatMs as ms,
  readHops,
  traceAsHtml,
  traceAsText,
  traceFamily,
  traceFileName,
  traceSummary,
  type HopState,
  type TraceSubject,
} from '@/lib/traceroute/export'
import type { IpVersion, Traceroute, TracerouteHop } from '@/types/probe'
import { inDisplayZone } from '@/lib/time-zone'

/**
 * The route to a target, hop by hop.
 *
 * The chart shows that packets were lost; this shows where. Traces are taken
 * on request, and automatically when an alert set to trace fires, since that
 * is usually the only time the broken route can be seen at all.
 */

interface TraceroutePanelProps {
  targetId: string
  /** What the target is called, for a trace copied or saved to share. */
  name: string
  /** What is traced, and over which families unless someone picks others. */
  host: string
  ipVersion?: IpVersion
  /** Changes whenever a new probe lands, so traces taken by an alert show up. */
  refreshKey?: number
  /** The account signed in may look but not change anything: routes are shown, not traced or deleted. */
  readOnly?: boolean
  /** The probe agent it is traced from, when that is not this server. */
  tracedFrom?: string
}

type TraceResponse = Omit<Traceroute, 'timestamp'> & { timestamp: string }

function parseTrace(trace: TraceResponse): Traceroute {
  return { ...trace, timestamp: new Date(trace.timestamp) }
}

/** The runs a trace is made of, one per family, in the order they are run. */
function familiesTraced(
  host: string,
  ipVersion: IpVersion | undefined,
  families: TraceFamilies,
  chosen: boolean
): Array<AddressFamily | null> {
  if (!chosen) return [addressFamilyFor(host, ipVersion)]
  return families === 'both' ? [4, 6] : [families === 'ipv6' ? 6 : 4]
}

const FAMILY_OPTIONS = [
  { value: 'ipv4', label: 'IPv4' },
  { value: 'ipv6', label: 'IPv6' },
  { value: 'both', label: 'Both' },
]

function formatTime(timestamp: Date): string {
  return timestamp.toLocaleString('en-US', inDisplayZone({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
}

/** How long after a trace its hop names are still expected to be arriving. */
const NAMING_WINDOW_MS = 2 * 60 * 1000
const NAMING_POLL_MS = 2500

/** A hop whose reverse lookup has not come back yet. */
function isAwaitingName(hop: TracerouteHop) {
  return hop.address !== null && hop.hostname === undefined
}

// ─── Sharing a trace ────────────────────────────────────────────────────────

/** Hand the browser a file to save, made here rather than fetched. */
function saveFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // After the click has had its turn: revoked at once, some browsers save nothing.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Ways to pass a trace on: as text for a chat or a ticket, or as a page of its
 * own for whoever runs the network it went wrong in, who has no way into this
 * dashboard. A trace taken during an outage is the evidence a provider asks for.
 */
function ShareTrace({ trace, subject }: { trace: Traceroute; subject: TraceSubject }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <CopyButton value={traceAsText(trace, subject)} label="Copy as text" />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => saveFile(traceFileName(trace, subject), traceAsHtml(trace, subject), 'text/html')}
      >
        <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        Save as a web page
      </Button>
    </div>
  )
}

// ─── A hop's place on the path ──────────────────────────────────────────────

const NODE_STYLE: Record<HopState, string> = {
  answered: 'border-signal-perfect/50 bg-signal-perfect/10 text-foreground',
  lossy: 'border-signal-moderate/70 bg-signal-moderate/15 text-foreground',
  silent: 'border-dashed border-muted-foreground/40 text-muted-foreground',
  dead: 'border-destructive/60 bg-destructive/15 text-destructive',
  destination: 'border-signal-perfect bg-signal-perfect font-medium text-background',
}

/** Half of the line joining a hop to the one before or after it. */
function PathLine({ half, broken }: { half: 'above' | 'below'; broken: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute left-1/2 -translate-x-1/2',
        half === 'above' ? 'bottom-1/2 top-0' : 'bottom-0 top-1/2',
        // Past where replies stop the path is not known to go anywhere.
        broken ? 'border-l border-dashed border-destructive/50' : 'w-px bg-border'
      )}
    />
  )
}

/**
 * One hop's timings on a shared scale: a band from its fastest reply to its
 * slowest, with a mark at the average. Reading down the column shows where
 * latency is added along the path, and a wide band shows where it is unstable.
 */
function LatencyBar({ hop, scale, state }: { hop: TracerouteHop; scale: number; state: HopState }) {
  if (hop.rtts.length === 0) {
    return <span className="block h-1.5 rounded-full bg-muted/20" aria-hidden="true" />
  }

  const at = (value: number) => `${Math.min(100, (value / scale) * 100)}%`
  const fastest = Math.min(...hop.rtts)
  const slowest = Math.max(...hop.rtts)
  const average = mean(hop.rtts) ?? fastest
  const colour = state === 'lossy' ? 'bg-signal-moderate' : state === 'destination' ? 'bg-signal-perfect' : 'bg-trace'

  return (
    <span className="relative block h-1.5 rounded-full bg-muted/40" aria-hidden="true">
      <span
        className={cn('absolute inset-y-0 min-w-1 rounded-full opacity-40', colour)}
        style={{ left: at(fastest), width: `calc(${at(slowest)} - ${at(fastest)})` }}
      />
      <span
        className={cn('absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card', colour)}
        style={{ left: at(average) }}
      />
    </span>
  )
}

// ─── A trace under way ──────────────────────────────────────────────────────

const PLACEHOLDER_HOPS = 9

/**
 * A trace that has been asked for and not come back, in the place its result
 * will take: a path of stops lighting up one after another, and how long it
 * has been going. A healthy path takes seconds and a broken one up to a
 * minute and a half, and a spinning button alone did not say which was
 * happening, or that anything was.
 */
function TracingRow({ family, startedAt }: { family: AddressFamily | null; startedAt: number }) {
  const reduceMotion = useReducedMotion()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <li className="rounded-2xl border border-primary/30 bg-primary/5 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        {family && <Badge size="sm" tone="info">{FAMILY_LABEL[family]}</Badge>}
        <TextShimmer className="font-medium">{family ? `Tracing the ${FAMILY_LABEL[family]} route` : 'Tracing the route'}</TextShimmer>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">{seconds}s</span>
      </div>
      <div className="mt-3 flex items-center px-1" aria-hidden="true">
        {Array.from({ length: PLACEHOLDER_HOPS }, (_, index) => (
          <Fragment key={index}>
            {index > 0 && <span className="h-px flex-1 bg-primary/25" />}
            <motion.span
              className="size-2.5 shrink-0 rounded-full bg-primary"
              initial={false}
              animate={reduceMotion ? { opacity: 0.5 } : { opacity: [0.15, 1, 0.15], scale: [0.8, 1.15, 0.8] }}
              transition={reduceMotion ? { duration: 0 } : { duration: 1.6, repeat: Infinity, delay: index * 0.14, ease: 'easeInOut' }}
            />
          </Fragment>
        ))}
      </div>
    </li>
  )
}

function HopTable({ trace }: { trace: Traceroute }) {
  // Each hop's loss is the traffic being lost there (see pathLoss), and
  // `limited` marks replies that did not come from a router the traffic got
  // through.
  const { hops: readings, dead } = readHops(trace)
  const scale = Math.max(1, ...trace.hops.flatMap(hop => hop.rtts))

  const row = ({ hop, state, loss, limited }: (typeof readings)[number], index: number) => {
    const average = mean(hop.rtts)
    const silent = hop.rtts.length === 0

    return (
      <tr key={hop.hop} className={cn('transition-colors hover:bg-muted/30', state === 'dead' && 'bg-destructive/5')}>
        {/* The path itself: each hop a numbered stop on a line running down
            the table, so the route reads as a route before any figure is read. */}
        <td className="relative w-10 p-0">
          {index > 0 && <PathLine half="above" broken={state === 'dead'} />}
          {index < readings.length - 1 && <PathLine half="below" broken={readings[index + 1].state === 'dead'} />}
          {/* Solid underneath, so the line stops at the stop's edge. */}
          <span className="relative mx-auto block size-6 rounded-full bg-card">
            <span
              className={cn(
                'flex size-6 items-center justify-center rounded-full border font-mono text-[10px] tabular-nums',
                NODE_STYLE[state]
              )}
            >
              {hop.hop}
            </span>
          </span>
        </td>

        {/* Cut short on one line where the table is wide. Where it is narrow
            the name wraps instead: a name cut to a dozen letters says nothing,
            and there is no hovering over it on a phone to read the rest. */}
        <td className="w-full max-w-0 py-2 pl-1 pr-4 @md/main:w-2/5">
          {hop.address === null ? (
            <>
              <span className={cn('block', state === 'dead' ? 'text-destructive' : 'text-muted-foreground')}>No reply</span>
              {state === 'silent' && (
                <span className="block text-[11px] text-muted-foreground/70">
                  Does not answer probes. Still passing traffic on.
                </span>
              )}
            </>
          ) : (
            <>
              <span className="flex items-center gap-2">
                <Tooltip content={hop.hostname ?? hop.address}>
                  <span
                    className={cn(
                      'min-w-0 break-all @2xl/main:truncate',
                      hop.hostname ? 'text-foreground' : 'font-mono text-foreground',
                      state === 'destination' && 'font-medium'
                    )}
                  >
                    {hop.hostname ?? hop.address}
                  </span>
                </Tooltip>
                {state === 'destination' && <Badge tone="success" size="sm">Target</Badge>}
              </span>
              {hop.hostname ? (
                <span className="block break-all font-mono text-[11px] text-muted-foreground">{hop.address}</span>
              ) : isAwaitingName(hop) ? (
                <span className="block animate-pulse text-[11px] text-muted-foreground/60">looking up its name…</span>
              ) : null}
            </>
          )}
        </td>

        <td className="whitespace-nowrap py-2 pr-4 text-right font-mono">
          {limited ? (
            <Tooltip
              side="left"
              content={`${hop.sent - hop.rtts.length} of ${hop.sent} replies from this router did not come, but every router after it answered in full. It is slow to answer traceroute probes; it is not losing traffic.`}
            >
              <span className="text-muted-foreground/70">0%*</span>
            </Tooltip>
          ) : loss === 0 ? (
            <span className="text-muted-foreground/70">0%</span>
          ) : state === 'silent' ? (
            // Every probe unanswered, and not a loss of traffic: left quiet.
            <span className="text-muted-foreground">{loss.toFixed(0)}%</span>
          ) : (
            <Badge tone={state === 'dead' ? 'danger' : 'warning'} size="sm">{loss.toFixed(0)}%</Badge>
          )}
        </td>
        <td className="whitespace-nowrap py-2 text-right font-mono text-foreground @md/main:pr-4">
          {average === null ? <span className="text-muted-foreground/60">—</span> : ms(average)}
        </td>
        <td className="hidden py-2 pr-4 text-right font-mono text-muted-foreground @3xl/main:table-cell">
          {silent ? '—' : ms(Math.min(...hop.rtts))}
        </td>
        <td className="hidden py-2 pr-4 text-right font-mono text-muted-foreground @3xl/main:table-cell">
          {silent ? '—' : ms(Math.max(...hop.rtts))}
        </td>
        <td className="hidden w-2/5 min-w-24 py-2 pr-1 align-middle @md/main:table-cell">
          <LatencyBar hop={hop} scale={scale} state={state} />
        </td>
      </tr>
    )
  }

  return (
    // Columns come and go with the width of the main pane (see
    // pane-layout.ts), so that on a phone the table fits the screen instead of
    // scrolling sideways inside its card: first the bars, which draw what the
    // average already says, then the fastest and slowest reply.
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="pb-2 text-center font-medium">Hop</th>
            <th className="pb-2 pl-1 pr-4 font-medium">Router</th>
            <th className="pb-2 pr-4 text-right font-medium">Loss</th>
            <th className="whitespace-nowrap pb-2 text-right font-medium @md/main:pr-4">Avg ms</th>
            <th className="hidden pb-2 pr-4 text-right font-medium @3xl/main:table-cell">Min</th>
            <th className="hidden pb-2 pr-4 text-right font-medium @3xl/main:table-cell">Max</th>
            <th className="hidden pb-2 pr-1 @md/main:table-cell">
              {/* The ends of the scale the bars below are drawn on. */}
              <span className="flex justify-between font-mono font-normal">
                <span>0</span>
                <span>{ms(scale)} ms</span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>{readings.map(row)}</tbody>
      </table>
      {dead !== null && (
        <div className="mt-3">
          <Alert tone="danger" title={`Nothing answered from hop ${dead} onwards`}>
            {/* Seen on a network whose IPv6 ends at the provider's first
                routers: easily read as the target's fault, and a DNS target's
                healthy IPv6 line makes it look stranger still. */}
            {traceFamily(trace) === 6 && dead <= 4
              ? "IPv6 stops inside your own provider's network, so this machine has no working IPv6 path past it. A DNS target's IPv6 line is its AAAA lookup, which can be answered over IPv4, so that can look healthy while this does not."
              : 'The fault is at that hop or just beyond the last one that replied.'}
          </Alert>
        </div>
      )}
    </div>
  )
}

// ─── The panel ──────────────────────────────────────────────────────────────

export function TraceroutePanel({ targetId, name, host, ipVersion, refreshKey, readOnly = false, tracedFrom }: TraceroutePanelProps) {
  const { notify, reportError } = useToast()
  const [traces, setTraces] = useState<Traceroute[]>([])
  // How many are kept in all, which can be more than the newest few listed.
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  // When the trace now under way was asked for, or null when none is.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const running = startedAt !== null
  // A name can be traced over either family; it starts on the ones it is probed over.
  const choosable = canChooseTraceFamily(host)
  const [families, setFamilies] = useState<TraceFamilies>(() => defaultTraceFamilies(host, ipVersion))
  const [tracing, setTracing] = useState<Array<AddressFamily | null>>([])
  const [deleting, setDeleting] = useState(false)
  // The newest trace is open unless another has been chosen.
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/targets/${targetId}/traceroute`)
      if (!response.ok) {
        reportError('Could not load routes', `Server responded ${response.status}`)
        return
      }
      const data = await response.json()
      const listed: Traceroute[] = (data.traceroutes ?? []).map(parseTrace)
      setTraces(listed)
      setTotal(typeof data.total === 'number' ? data.total : listed.length)
    } catch (error) {
      reportError('Could not load routes', error)
    } finally {
      setLoading(false)
    }
  }, [targetId, reportError])

  useEffect(() => {
    // The callback is async and awaits its fetch before touching state, so
    // nothing is set synchronously here; the rule cannot see across the
    // await. Fetching on mount is the intended use of an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load, refreshKey])

  // Hop names are looked up after the trace is stored and saved one at a time,
  // so a recent trace is re-read until they have all arrived. Bounded by the
  // trace's age: a lookup that never finishes must not poll for ever.
  useEffect(() => {
    const stillNaming = traces.some(
      item => Date.now() - item.timestamp.getTime() < NAMING_WINDOW_MS && item.hops.some(isAwaitingName)
    )
    if (!stillNaming) return

    const timer = setTimeout(load, NAMING_POLL_MS)
    return () => clearTimeout(timer)
  }, [traces, load])

  const trace = async () => {
    setTracing(familiesTraced(host, ipVersion, families, choosable))
    setStartedAt(Date.now())
    try {
      const response = await fetch(`/api/targets/${targetId}/traceroute`, {
        method: 'POST',
        ...(choosable ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ family: families }) } : {}),
      })
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError('Traceroute failed', error)
        return
      }
      setChosenId(undefined)
      await load()
    } catch (error) {
      reportError('Traceroute failed', error)
    } finally {
      setStartedAt(null)
    }
  }

  /** Delete what `query` names; true if it went. */
  const remove = async (query: string): Promise<boolean> => {
    setDeleting(true)
    try {
      const response = await fetch(`/api/targets/${targetId}/traceroute?${query}`, { method: 'DELETE' })
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError('Could not delete the route', error)
        return false
      }
      await load()
      return true
    } catch (error) {
      reportError('Could not delete the route', error)
      return false
    } finally {
      setDeleting(false)
    }
  }

  // Deleting asks first, in place: a trace taken while something was broken
  // cannot be taken again once it has mended.
  const removeOne = async (item: Traceroute) => {
    if (!(await remove(`trace=${encodeURIComponent(item.id)}`))) throw new Error('Not deleted')
    // The one that was open is gone; the newest takes its place.
    if (item.id === chosenId) setChosenId(undefined)
  }

  // Everything but the newest trace to each address family. Counted from the
  // total, since the old ones reach back further than the list does.
  const olderCount = Math.max(0, total - newestPerFamily(traces).length)

  const removeOlder = async () => {
    if (!(await remove('older=1'))) throw new Error('Not deleted')
    {
      setChosenId(undefined)
      notify({
        tone: 'info',
        title: `Deleted ${olderCount} older route${olderCount === 1 ? '' : 's'}`,
        detail: 'The newest was kept.',
      })
    }
  }

  const openId = chosenId === undefined ? traces[0]?.id ?? null : chosenId

  return (
    <section
      className={cn('relative rounded-3xl border bg-card transition-colors duration-300', running ? 'border-primary/40' : 'border-border')}
      aria-busy={running}
    >
      {/* A light running along the top edge while a trace is under way, so
          the whole card says it is working, not only its button. */}
      {running && <span className="trace-sweep" aria-hidden="true" />}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-4 @2xl/main:px-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium text-foreground">{tracedFrom ? `Route, traced from ${tracedFrom}` : 'Route'}</h2>
          {running ? (
            <TextShimmer className="text-xs">
              {tracing.length > 1 ? 'Tracing over IPv4, then IPv6' : 'Tracing, which can take up to a minute and a half'}
            </TextShimmer>
          ) : (
            <p className="text-xs text-muted-foreground">
              Where the path goes, hop by hop. Traced automatically when an alert set to trace fires.
            </p>
          )}
        </div>
        {!readOnly && <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
          {olderCount > 0 && (
            <ConfirmMorph
              key={olderCount}
              label={`Delete ${olderCount} older`}
              icon={<Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />}
              // Short enough, with Cancel and Delete beside it, for a phone.
              prompt="Keep only the newest?"
              confirmLabel="Delete"
              doneLabel="Deleted"
              disabled={deleting}
              onConfirm={removeOlder}
            />
          )}
          {/* Which families the next trace goes over. Only a name has a
              choice: an address is reached over its own family alone. */}
          {choosable && (
            <div inert={running} className={cn('flex transition-opacity', running && 'opacity-60')}>
              <SegmentedControl
                label="Trace over"
                value={families}
                onValueChange={value => setFamilies(value as TraceFamilies)}
                options={FAMILY_OPTIONS}
              />
            </div>
          )}
          <Button variant="secondary" size="sm" onClick={trace} loading={running}>
            <Route size={16} strokeWidth={1.75} aria-hidden="true" />
            Trace route
          </Button>
        </div>}
      </div>

      <div className="px-4 pb-4 pt-3 @2xl/main:px-5">
        {loading ? (
          <Skeleton label="Loading the routes" lines={2} />
        ) : traces.length === 0 && !running ? (
          <EmptyState
            icon={<Route size={24} strokeWidth={1.75} />}
            title="No route recorded yet"
            description="Trace it to see every router between here and the target, and how long each takes to answer."
          />
        ) : (
          <>
            <ul className="space-y-1.5">
              {startedAt !== null &&
                tracing.map(family => <TracingRow key={family ?? 'any'} family={family} startedAt={startedAt} />)}
              {traces.map(item => {
                const open = item.id === openId
                const summary = traceSummary(item)
                const took = endToEnd(item)
                const StatusIcon = summary.tone === 'ok' ? CheckCircle2 : XCircle
                const time = formatTime(item.timestamp)
                const family = traceFamily(item)

                return (
                  <li
                    key={item.id}
                    className={cn(
                      'rounded-2xl border transition-colors',
                      open ? 'border-border bg-background' : 'border-border hover:border-border-strong'
                    )}
                  >
                    {/* Side by side, not one inside the other: a button
                        cannot hold another button. On a phone, Delete gets a
                        line of its own under the summary: beside it, the
                        question it opens into ran off the edge of the screen,
                        taking the button that answers it along. */}
                    <div className="flex flex-wrap items-center gap-1 pr-2 @xl/main:flex-nowrap">
                      <button
                        type="button"
                        onClick={() => setChosenId(open ? null : item.id)}
                        aria-expanded={open}
                        className="flex min-w-0 flex-1 basis-full cursor-pointer @xl/main:basis-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-2xl px-3 py-2.5 text-left text-sm touch:py-3"
                      >
                        {open
                          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <StatusIcon
                          className={cn('h-4 w-4 shrink-0', summary.tone === 'ok' ? 'text-signal-perfect' : 'text-destructive')}
                          aria-hidden="true"
                        />
                        {/* Which family, first: the two take different routes,
                            and a list of both read as one otherwise. */}
                        {family && <Badge size="sm" tone="info">{FAMILY_LABEL[family]}</Badge>}
                        <span className={cn('font-medium', summary.tone === 'bad' ? 'text-destructive' : 'text-foreground')}>
                          {summary.text}
                        </span>
                        {took !== null && <span className="font-mono text-muted-foreground">{ms(took)} ms</span>}
                        {item.trigger === 'alert' && <Badge tone="danger" size="sm">Taken on alert</Badge>}
                        <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 font-mono text-[11px] text-muted-foreground">
                          <span className="break-all">{item.address}</span>
                          <span className="whitespace-nowrap">{time}</span>
                        </span>
                      </button>

                      {/* Asked in the route's own row, so "this" says which;
                          the time it was taken made the question too wide. */}
                      {readOnly ? null : (
                        <div className="ml-auto flex max-w-full justify-end pb-2 @xl/main:pb-0">
                          <ConfirmMorph
                            label="Delete"
                            icon={<Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />}
                            prompt="Delete this route?"
                            confirmLabel="Delete"
                            doneLabel="Deleted"
                            disabled={deleting}
                            onConfirm={() => removeOne(item)}
                          />
                        </div>
                      )}
                    </div>

                    <AnimatePresence initial={false}>
                      {open && item.hops.length > 0 && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="overflow-hidden"
                        >
                          <div className="border-t border-border px-3 pb-3 pt-3">
                            <ShareTrace trace={item} subject={{ name, host }} />
                            <HopTable trace={item} />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </li>
                )
              })}
            </ul>
            {total > traces.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                The newest {traces.length} of {total} kept for this target.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
