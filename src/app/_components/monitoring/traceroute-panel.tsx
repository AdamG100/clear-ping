'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronRight, Route } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { mean } from '@/lib/metrics'
import { firstDeadHop, hopLoss } from '@/lib/traceroute-parse'
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
}

type TraceResponse = Omit<Traceroute, 'timestamp'> & { timestamp: string }

function parseTrace(trace: TraceResponse): Traceroute {
  return { ...trace, timestamp: new Date(trace.timestamp) }
}

function summarize(trace: Traceroute): { text: string; tone: 'ok' | 'bad' | 'muted' } {
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

/** How long after a trace its hop names are still expected to be arriving. */
const NAMING_WINDOW_MS = 2 * 60 * 1000
const NAMING_POLL_MS = 2500

/** A hop whose reverse lookup has not come back yet. */
function isAwaitingName(hop: TracerouteHop) {
  return hop.address !== null && hop.hostname === undefined
}

const ms = (value: number) => value.toFixed(value < 10 ? 1 : 0)

/**
 * One hop's timings on a shared scale: a band from its fastest reply to its
 * slowest, with a mark at the average. Reading down the column shows where
 * latency is added along the path, and a wide band shows where it is unstable.
 */
function LatencyBar({ hop, scale }: { hop: TracerouteHop; scale: number }) {
  if (hop.rtts.length === 0) return null

  const at = (value: number) => `${Math.min(100, (value / scale) * 100)}%`
  const fastest = Math.min(...hop.rtts)
  const slowest = Math.max(...hop.rtts)
  const average = mean(hop.rtts) ?? fastest

  return (
    <span className="relative block h-3" aria-hidden="true">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/60" />
      <span
        className="absolute top-1/2 h-1.5 min-w-0.5 -translate-y-1/2 rounded-full bg-[var(--trace)] opacity-40"
        style={{ left: at(fastest), width: `calc(${at(slowest)} - ${at(fastest)})` }}
      />
      <span
        className="absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--trace)]"
        style={{ left: at(average) }}
      />
    </span>
  )
}

function HopTable({ trace }: { trace: Traceroute }) {
  const dead = firstDeadHop(trace.hops, trace.reached)
  const scale = Math.max(1, ...trace.hops.flatMap(hop => hop.rtts))

  const row = (hop: TracerouteHop) => {
    const loss = hopLoss(hop)
    const average = mean(hop.rtts)
    const silent = hop.rtts.length === 0
    const isDeadEnd = dead !== null && hop.hop >= dead

    return (
      <tr key={hop.hop} className={cn('border-t border-border/50 align-top', isDeadEnd && 'bg-destructive/5')}>
        <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">{hop.hop}</td>
        {/* Cut short on one line where the table is wide. Where it is narrow
            the name wraps instead: a name cut to a dozen letters says nothing,
            and there is no hovering over it on a phone to read the rest. */}
        <td className="py-1.5 pr-4 break-all @2xl/main:max-w-64 @2xl/main:truncate" title={hop.hostname ?? undefined}>
          {hop.hostname ? (
            <span className="text-foreground">{hop.hostname}</span>
          ) : isAwaitingName(hop) ? (
            <span className="animate-pulse text-muted-foreground/60">resolving…</span>
          ) : silent && !isDeadEnd ? (
            // A router that stays silent while later hops answer is forwarding
            // traffic and declining to reply; calling it the fault is the
            // classic misreading of a traceroute, so say what it is.
            <span className="break-normal text-muted-foreground">does not answer probes, still forwarding</span>
          ) : (
            // Only where the name has a column to itself: above the address, a
            // dash for "no name" is a line of nothing.
            <span className="hidden text-muted-foreground/60 @2xl/main:inline">—</span>
          )}
          {/* The address, under the name while it has no column of its own. */}
          <span className="block font-mono text-[11px] text-muted-foreground @2xl/main:hidden">
            {hop.address ?? 'no reply'}
          </span>
        </td>
        <td className="hidden py-1.5 pr-4 font-mono text-muted-foreground @2xl/main:table-cell">
          {hop.address ?? <span className="text-muted-foreground/60">no reply</span>}
        </td>
        <td className={cn('py-1.5 pr-4 text-right font-mono', loss > 0 ? 'text-destructive' : 'text-muted-foreground')}>
          {loss.toFixed(0)}%
        </td>
        <td className="py-1.5 text-right font-mono @md/main:pr-4">{average === null ? '—' : ms(average)}</td>
        <td className="hidden py-1.5 pr-4 text-right font-mono text-muted-foreground @3xl/main:table-cell">
          {silent ? '—' : ms(Math.min(...hop.rtts))}
        </td>
        <td className="hidden py-1.5 pr-4 text-right font-mono text-muted-foreground @3xl/main:table-cell">
          {silent ? '—' : ms(Math.max(...hop.rtts))}
        </td>
        <td className="hidden w-1/4 min-w-20 py-1.5 align-middle @md/main:table-cell">
          <LatencyBar hop={hop} scale={scale} />
        </td>
      </tr>
    )
  }

  return (
    // Columns come and go with the width of the main pane (see
    // pane-layout.ts), so that on a phone the table fits the screen instead of
    // scrolling sideways inside its card: first the bars, which draw what the
    // average already says, then the address moves in under the name.
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <th className="pb-1.5 pr-3 text-right font-medium">Hop</th>
            <th className="pb-1.5 pr-4 font-medium">Name</th>
            <th className="hidden pb-1.5 pr-4 font-medium @2xl/main:table-cell">IP</th>
            <th className="pb-1.5 pr-4 text-right font-medium">Loss</th>
            <th className="whitespace-nowrap pb-1.5 text-right font-medium @md/main:pr-4">Avg ms</th>
            <th className="hidden pb-1.5 pr-4 text-right font-medium @3xl/main:table-cell">Min</th>
            <th className="hidden pb-1.5 pr-4 text-right font-medium @3xl/main:table-cell">Max</th>
            <th className="hidden whitespace-nowrap pb-1.5 text-right font-mono font-normal normal-case tracking-normal @md/main:table-cell">
              0 – {ms(scale)} ms
            </th>
          </tr>
        </thead>
        <tbody>{trace.hops.map(row)}</tbody>
      </table>
      {dead !== null && (
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing answered from hop {dead} onwards. The fault is at that hop or just beyond the last one that
          replied.
        </p>
      )}
    </div>
  )
}

export function TraceroutePanel({ targetId, refreshKey }: TraceroutePanelProps) {
  const { reportError } = useToast()
  const [traces, setTraces] = useState<Traceroute[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
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
      setTraces((data.traceroutes ?? []).map(parseTrace))
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
        <Button variant="outline" size="sm" onClick={trace} disabled={running} className="h-8 shrink-0">
          <Route className={cn('mr-2 h-3.5 w-3.5', running && 'animate-pulse')} />
          {running ? 'Tracing…' : 'Trace route'}
        </Button>
      </div>

      <div className="px-4 pb-4 pt-3 @2xl/main:px-5">
        {loading ? (
          <div className="h-8 w-56 animate-pulse rounded bg-muted/50" />
        ) : traces.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {running
              ? 'Tracing. A healthy path takes a few seconds; one that goes nowhere can take a minute.'
              : 'No route recorded yet.'}
          </p>
        ) : (
          <ul className="space-y-1">
            {traces.map(item => {
              const open = item.id === openId
              const summary = summarize(item)

              return (
                <li key={item.id} className="rounded-lg border border-border/60">
                  <button
                    type="button"
                    onClick={() => setChosenId(open ? null : item.id)}
                    aria-expanded={open}
                    className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-xs touch:py-3"
                  >
                    {open
                      ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="font-mono text-muted-foreground">
                      {item.timestamp.toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {item.trigger === 'alert' && (
                      <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                        taken on alert
                      </span>
                    )}
                    <span className={cn(summary.tone === 'bad' ? 'text-destructive' : 'text-foreground')}>
                      {summary.text}
                    </span>
                    <span className="ml-auto break-all font-mono text-[11px] text-muted-foreground">{item.address}</span>
                  </button>

                  <AnimatePresence initial={false}>
                    {open && item.hops.length > 0 && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="px-3 pb-3">
                          <HopTable trace={item} />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
