'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, ChevronDown, ChevronRight, Route, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { mean } from '@/lib/metrics'
import { firstDeadHop, hopLoss, newestPerFamily } from '@/lib/traceroute-parse'
import type { Traceroute, TracerouteHop } from '@/types/probe'

/**
 * The route to a target, hop by hop.
 *
 * The chart shows that packets were lost; this shows where. Traces are taken
 * on request, and automatically at the moment a loss alert fires, since that
 * is usually the only time the broken route can be seen at all.
 */

interface TraceroutePanelProps {
  targetId: string
  /** Changes whenever a new probe lands, so traces taken by an alert show up. */
  refreshKey?: number
  /** The account signed in may look but not change anything: routes are shown, not traced or deleted. */
  readOnly?: boolean
}

type TraceResponse = Omit<Traceroute, 'timestamp'> & { timestamp: string }

function parseTrace(trace: TraceResponse): Traceroute {
  return { ...trace, timestamp: new Date(trace.timestamp) }
}

function summarize(trace: Traceroute): { text: string; tone: 'ok' | 'bad' } {
  if (trace.hops.length === 0) {
    return { text: trace.errorMessage ?? 'No hops recorded', tone: 'bad' }
  }
  if (trace.reached) {
    return { text: `Reached in ${trace.hops.length} hop${trace.hops.length === 1 ? '' : 's'}`, tone: 'ok' }
  }

  const dead = firstDeadHop(trace.hops, trace.reached)
  if (dead === null) return { text: `Did not reach ${trace.address}`, tone: 'bad' }
  return {
    text: dead <= 1 ? 'No replies from the first hop on' : `No replies beyond hop ${dead - 1}`,
    tone: 'bad',
  }
}

/** How long the whole path took: the average reply from the target itself. */
function endToEnd(trace: Traceroute): number | null {
  return trace.reached ? mean(trace.hops.at(-1)?.rtts ?? []) : null
}

function formatTime(timestamp: Date): string {
  return timestamp.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** How long after a trace its hop names are still expected to be arriving. */
const NAMING_WINDOW_MS = 2 * 60 * 1000
const NAMING_POLL_MS = 2500

/** A hop whose reverse lookup has not come back yet. */
function isAwaitingName(hop: TracerouteHop) {
  return hop.address !== null && hop.hostname === undefined
}

const ms = (value: number) => value.toFixed(value < 10 ? 1 : 0)

// ─── A hop's place on the path ──────────────────────────────────────────────

/**
 * How a hop stands, which is what its mark on the path is drawn from.
 *
 * `silent` is a router that did not answer while later ones did. It is
 * forwarding traffic and declining to reply, and calling it the fault is the
 * classic misreading of a traceroute, so it is drawn as a gap in what is
 * known and not as a failure. `dead` is where replies stop for good.
 */
type HopState = 'answered' | 'lossy' | 'silent' | 'dead' | 'destination'

function hopState(hop: TracerouteHop, trace: Traceroute, dead: number | null): HopState {
  if (dead !== null && hop.hop >= dead) return 'dead'
  if (hop.rtts.length === 0) return 'silent'
  if (trace.reached && hop === trace.hops.at(-1)) return 'destination'
  return hopLoss(hop) > 0 ? 'lossy' : 'answered'
}

const NODE_STYLE: Record<HopState, string> = {
  answered: 'border-signal-perfect/50 bg-signal-perfect/10 text-foreground',
  lossy: 'border-signal-moderate/70 bg-signal-moderate/15 text-foreground',
  silent: 'border-dashed border-muted-foreground/40 text-muted-foreground',
  dead: 'border-destructive/60 bg-destructive/15 text-destructive',
  destination: 'border-signal-perfect bg-signal-perfect font-semibold text-background',
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

function HopTable({ trace }: { trace: Traceroute }) {
  const dead = firstDeadHop(trace.hops, trace.reached)
  const scale = Math.max(1, ...trace.hops.flatMap(hop => hop.rtts))
  const states = trace.hops.map(hop => hopState(hop, trace, dead))

  const row = (hop: TracerouteHop, index: number) => {
    const state = states[index]
    const loss = hopLoss(hop)
    const average = mean(hop.rtts)
    const silent = hop.rtts.length === 0

    return (
      <tr key={hop.hop} className={cn('transition-colors hover:bg-muted/30', state === 'dead' && 'bg-destructive/5')}>
        {/* The path itself: each hop a numbered stop on a line running down
            the table, so the route reads as a route before any figure is read. */}
        <td className="relative w-10 p-0">
          {index > 0 && <PathLine half="above" broken={state === 'dead'} />}
          {index < trace.hops.length - 1 && <PathLine half="below" broken={states[index + 1] === 'dead'} />}
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
                <span
                  className={cn(
                    'min-w-0 break-all @2xl/main:truncate',
                    hop.hostname ? 'text-foreground' : 'font-mono text-foreground',
                    state === 'destination' && 'font-medium'
                  )}
                  data-tip={hop.hostname ?? hop.address}
                >
                  {hop.hostname ?? hop.address}
                </span>
                {state === 'destination' && (
                  <span className="shrink-0 rounded bg-signal-perfect/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-signal-perfect">
                    Target
                  </span>
                )}
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
          {loss === 0 ? (
            <span className="text-muted-foreground/70">0%</span>
          ) : state === 'silent' ? (
            // Every probe unanswered, and not a loss of traffic: left quiet.
            <span className="text-muted-foreground">{loss.toFixed(0)}%</span>
          ) : (
            <span
              className={cn(
                'rounded px-1.5 py-0.5',
                state === 'dead' ? 'bg-destructive/15 text-destructive' : 'bg-signal-moderate/15 text-signal-moderate'
              )}
            >
              {loss.toFixed(0)}%
            </span>
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
          <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <th className="pb-2 text-center font-medium">Hop</th>
            <th className="pb-2 pl-1 pr-4 font-medium">Router</th>
            <th className="pb-2 pr-4 text-right font-medium">Loss</th>
            <th className="whitespace-nowrap pb-2 text-right font-medium @md/main:pr-4">Avg ms</th>
            <th className="hidden pb-2 pr-4 text-right font-medium @3xl/main:table-cell">Min</th>
            <th className="hidden pb-2 pr-4 text-right font-medium @3xl/main:table-cell">Max</th>
            <th className="hidden pb-2 pr-1 @md/main:table-cell">
              {/* The ends of the scale the bars below are drawn on. */}
              <span className="flex justify-between font-mono font-normal normal-case tracking-normal">
                <span>0</span>
                <span>{ms(scale)} ms</span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>{trace.hops.map(row)}</tbody>
      </table>
      {dead !== null && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-foreground">
          Nothing answered from hop {dead} onwards. The fault is at that hop or just beyond the last one that
          replied.
        </p>
      )}
    </div>
  )
}

// ─── The panel ──────────────────────────────────────────────────────────────

export function TraceroutePanel({ targetId, refreshKey, readOnly = false }: TraceroutePanelProps) {
  const { notify, reportError } = useToast()
  const [traces, setTraces] = useState<Traceroute[]>([])
  // How many are kept in all, which can be more than the newest few listed.
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // The newest trace is open unless another has been chosen.
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined)
  // Deleting takes two presses of the same button: a trace taken while
  // something was broken cannot be taken again once it has mended. This is the
  // trace whose button has had its first press, or `older` for the old ones.
  const [confirming, setConfirming] = useState<string | null>(null)

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
    setRunning(true)
    try {
      const response = await fetch(`/api/targets/${targetId}/traceroute`, { method: 'POST' })
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
      setRunning(false)
    }
  }

  /** Delete what `query` names; true if it went. */
  const remove = async (query: string): Promise<boolean> => {
    setConfirming(null)
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

  const removeOne = async (item: Traceroute) => {
    if (confirming !== item.id) {
      setConfirming(item.id)
      return
    }
    // The one that was open is gone; the newest takes its place.
    if ((await remove(`trace=${encodeURIComponent(item.id)}`)) && item.id === chosenId) setChosenId(undefined)
  }

  // Everything but the newest trace to each address family. Counted from the
  // total, since the old ones reach back further than the list does.
  const olderCount = Math.max(0, total - newestPerFamily(traces).length)

  const removeOlder = async () => {
    if (confirming !== 'older') {
      setConfirming('older')
      return
    }
    if (await remove('older=1')) {
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
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-4 @2xl/main:px-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium text-foreground">Route</h2>
          <p className="text-xs text-muted-foreground">
            Where the path goes, hop by hop. Traced automatically when a loss alert fires.
          </p>
        </div>
        {!readOnly && <div className="flex shrink-0 items-center gap-2">
          {olderCount > 0 && (
            <Button
              variant={confirming === 'older' ? 'destructive' : 'outline'}
              size="sm"
              onClick={removeOlder}
              onBlur={() => setConfirming(current => (current === 'older' ? null : current))}
              disabled={deleting}
              className="h-8"
              data-tip="Delete every route but the newest"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {confirming === 'older' ? `Delete ${olderCount}?` : `Delete ${olderCount} older`}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={trace} disabled={running} className="h-8">
            <Route className={cn('mr-2 h-3.5 w-3.5', running && 'animate-pulse')} />
            {running ? 'Tracing…' : 'Trace route'}
          </Button>
        </div>}
      </div>

      <div className="px-4 pb-4 pt-3 @2xl/main:px-5">
        {loading ? (
          <div className="h-8 w-56 animate-pulse rounded bg-muted/50" />
        ) : traces.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <Route className={cn('h-5 w-5 text-muted-foreground/60', running && 'animate-pulse')} aria-hidden="true" />
            <p className="max-w-sm text-xs text-muted-foreground">
              {running
                ? 'Tracing. A healthy path takes a few seconds; one that goes nowhere can take a minute.'
                : 'No route recorded yet. Trace it to see every router between here and the target, and how long each takes to answer.'}
            </p>
          </div>
        ) : (
          <>
            <ul className="space-y-1.5">
              {traces.map(item => {
                const open = item.id === openId
                const summary = summarize(item)
                const took = endToEnd(item)
                const StatusIcon = summary.tone === 'ok' ? CheckCircle2 : XCircle
                const time = formatTime(item.timestamp)

                return (
                  <li
                    key={item.id}
                    className={cn(
                      'rounded-lg border transition-colors',
                      open ? 'border-border bg-background/40' : 'border-border/60 hover:border-border'
                    )}
                  >
                    {/* Side by side, not one inside the other: a button
                        cannot hold another button. */}
                    <div className="flex items-center gap-1 pr-2">
                      <button
                        type="button"
                        onClick={() => setChosenId(open ? null : item.id)}
                        aria-expanded={open}
                        className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring touch:py-3"
                      >
                        {open
                          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <StatusIcon
                          className={cn('h-4 w-4 shrink-0', summary.tone === 'ok' ? 'text-signal-perfect' : 'text-destructive')}
                          aria-hidden="true"
                        />
                        <span className={cn('font-medium', summary.tone === 'bad' ? 'text-destructive' : 'text-foreground')}>
                          {summary.text}
                        </span>
                        {took !== null && <span className="font-mono text-muted-foreground">{ms(took)} ms</span>}
                        {item.trigger === 'alert' && (
                          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                            taken on alert
                          </span>
                        )}
                        <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 font-mono text-[11px] text-muted-foreground">
                          <span className="break-all">{item.address}</span>
                          <span className="whitespace-nowrap">{time}</span>
                        </span>
                      </button>

                      {readOnly ? null : confirming === item.id ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-xs touch:h-9 touch:px-3"
                          onClick={() => removeOne(item)}
                          onBlur={() => setConfirming(null)}
                          autoFocus
                        >
                          Delete?
                        </Button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => removeOne(item)}
                          disabled={deleting}
                          className="shrink-0 cursor-pointer rounded p-1.5 transition-colors hover:bg-destructive/20 disabled:opacity-40 touch:p-2.5"
                          aria-label={`Delete the route taken ${time}`}
                          data-tip="Delete this route"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </button>
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
                          <div className="border-t border-border/60 px-3 pb-3 pt-3">
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
              <p className="mt-2 text-[11px] text-muted-foreground">
                The newest {traces.length} of {total} kept for this target.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
