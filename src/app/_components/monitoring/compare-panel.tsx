'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type {
  AddressFamily,
  ComparisonSeries,
  DataPoint,
  Target,
  TargetStatistics,
  TimeRange,
  TimeWindow,
} from '@/types/probe'
import { TIME_RANGE_CONFIG } from '@/types/probe'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { cn } from '@/lib/utils'
import { FAMILY_LABEL } from '@/lib/host'
import { getPacketLossVar, isMeaningfulLoss } from '@/lib/packet-loss-colors'
import { targetAddressLabel } from '@/lib/probe-config'
import { buildSeries } from '@/lib/series'
import { formatWindowEdge } from './chart-brush'
import { CompareTrace, type CompareLine } from './compare-trace'
import { TraceSkeleton } from './skeleton'

/**
 * A comparison chart with its legend: the lines, and under them a table that
 * says what each line is and how it did over the period.
 *
 * Used for a group of targets, and for the two address families of a single
 * target that is probed over both.
 */

/**
 * Line colours. Evenly lit and spread around the hue wheel so neighbours in
 * the legend are easy to tell apart, and none of them the red or amber that
 * means packet loss everywhere else in the app.
 */
const SERIES_COLORS = [
  'oklch(0.74 0.13 215)',
  'oklch(0.76 0.15 300)',
  'oklch(0.80 0.15 130)',
  'oklch(0.74 0.16 345)',
  'oklch(0.78 0.12 180)',
  'oklch(0.70 0.16 265)',
  'oklch(0.83 0.13 100)',
  'oklch(0.72 0.14 320)',
  'oklch(0.76 0.10 240)',
  'oklch(0.80 0.13 160)',
]

interface LoadedSeries {
  key: string
  targetId: string
  family: AddressFamily | null
  points: DataPoint[]
  statistics: TargetStatistics | null
}

interface Snapshot {
  /** The set of targets this was fetched for. */
  owner: string
  series: LoadedSeries[]
  start: number
  end: number
  /** The zoom window this was fetched for, or null for the whole range. */
  window: TimeWindow | null
}

type ComparisonResponse = {
  series: ComparisonSeries[]
  bucketMs: number
  start: number
  end: number
}

/**
 * Load the same window of several targets.
 *
 * As with a single target's chart, changing the range or zooming keeps what
 * is on screen until the new data arrives, and a window already seen is
 * served from cache while it is revalidated.
 */
function useComparison(
  targets: Target[],
  timeRange: TimeRange,
  zoom: TimeWindow | null,
  refreshKey: number | undefined,
  reportError: (title: string, error?: unknown) => void
) {
  // Which targets, and how often each is probed: everything about them that
  // the result depends on, as a value that only changes when one of those does.
  const owner = targets.map(target => `${target.id}:${target.interval}`).join(',')

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [pending, setPending] = useState(false)
  const cacheRef = useRef(new Map<string, Snapshot>())
  // Only the newest request may write state.
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!owner) {
      setSnapshot(null)
      return
    }

    const requestId = ++requestIdRef.current
    const cacheKey = `${owner}|${timeRange}|${zoom ? `${zoom.start}-${zoom.end}` : 'all'}`
    const cached = cacheRef.current.get(cacheKey)

    if (cached) {
      setSnapshot(cached)
      setPending(false)
    } else {
      setPending(true)
    }

    try {
      const intervals = new Map(
        owner.split(',').map(entry => {
          const [id, seconds] = entry.split(':')
          return [id, Number(seconds)] as const
        })
      )
      const period = zoom
        ? `start=${zoom.start}&end=${zoom.end}`
        : `hours=${TIME_RANGE_CONFIG[timeRange].hours}`
      const response = await fetch(`/api/compare?targets=${[...intervals.keys()].join(',')}&${period}`)
      if (!response.ok) {
        reportError('Could not load the comparison', `Server responded ${response.status}`)
        return
      }

      const result: ComparisonResponse = await response.json()
      const next: Snapshot = {
        owner,
        start: result.start,
        end: result.end,
        window: zoom,
        series: result.series.map(item => ({
          key: `${item.targetId}:${item.family ?? 'all'}`,
          targetId: item.targetId,
          family: item.family,
          points: buildSeries(item.buckets, intervals.get(item.targetId) ?? 300, result.bucketMs),
          statistics: item.statistics,
        })),
      }

      if (cacheRef.current.size >= 20) {
        cacheRef.current.delete(cacheRef.current.keys().next().value!)
      }
      cacheRef.current.set(cacheKey, next)
      if (requestId === requestIdRef.current) setSnapshot(next)
    } catch (error) {
      reportError('Could not load the comparison', error)
    } finally {
      if (requestId === requestIdRef.current) setPending(false)
    }
  }, [owner, timeRange, zoom, reportError])

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    loadRef.current()
  }, [owner, timeRange, zoom, refreshKey])

  const current = snapshot !== null && snapshot.owner === owner ? snapshot : null

  return {
    snapshot: current,
    /** A fetch is in flight with nothing cached to show for this window. */
    pending,
    /** True only before the first result for these targets has arrived. */
    initialLoad: current === null,
  }
}

/** The newest reading a line has. */
function latestReading(points: DataPoint[]): DataPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].sampleCount > 0) return points[i]
  }
  return null
}

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toFixed(value < 10 ? 2 : 1)

interface ComparePanelProps {
  /** The targets to compare, in the order their lines are listed. */
  targets: Target[]
  timeRange: TimeRange
  zoom: TimeWindow | null
  onZoom: (start: number, end: number) => void
  onResetZoom: () => void
  /** Changes whenever a new measurement lands, so the chart keeps up. */
  refreshKey?: number
  title: string
  description: string
  /**
   * What a line is called. Defaults to the target's name, with the address
   * family added for a target that contributes one line per family.
   */
  nameSeries?: (target: Target, family: AddressFamily | null) => string
  /** Whether each row also shows the target's address. */
  showAddress?: boolean
  /** When given, a row's name opens that target's own page. */
  onSelectTarget?: (id: string) => void
  reportError: (title: string, error?: unknown) => void
}

const defaultName = (target: Target, family: AddressFamily | null) =>
  family ? `${target.name} · ${FAMILY_LABEL[family]}` : target.name

export function ComparePanel({
  targets,
  timeRange,
  zoom,
  onZoom,
  onResetZoom,
  refreshKey,
  title,
  description,
  nameSeries = defaultName,
  showAddress = true,
  onSelectTarget,
  reportError,
}: ComparePanelProps) {
  const { snapshot, pending, initialLoad } = useComparison(targets, timeRange, zoom, refreshKey, reportError)
  const [highlighted, setHighlighted] = useState<string | null>(null)

  const rows = useMemo(() => {
    if (!snapshot) return []
    const byId = new Map(targets.map(target => [target.id, target]))

    return snapshot.series.flatMap((series, index) => {
      const target = byId.get(series.targetId)
      if (!target) return []

      const line: CompareLine = {
        key: series.key,
        label: nameSeries(target, series.family),
        color: SERIES_COLORS[index % SERIES_COLORS.length],
        dashed: index >= SERIES_COLORS.length,
        points: series.points,
      }
      return [{ line, target, statistics: series.statistics, now: latestReading(series.points) }]
    })
  }, [snapshot, targets, nameSeries])

  const lines = useMemo(() => rows.map(row => row.line), [rows])
  const hasMeasurements = rows.some(row => (row.statistics?.sampleCount ?? 0) > 0)

  return (
    <section className="min-h-[26rem] rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        {zoom && (
          <p className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span>
              {formatWindowEdge(zoom.start)} – {formatWindowEdge(zoom.end)}
            </span>
            <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onResetZoom}>
              Reset zoom
            </Button>
          </p>
        )}
      </div>

      <div
        className={cn(
          'transition-opacity duration-200 motion-reduce:transition-none',
          pending && !initialLoad ? 'pointer-events-none opacity-50' : 'opacity-100'
        )}
        aria-busy={pending}
      >
        {initialLoad ? (
          <TraceSkeleton />
        ) : !hasMeasurements || !snapshot ? (
          <div className="flex h-[20rem] flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-foreground">Nothing measured in this window yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {zoom
                ? 'No probe ran in the period you selected. Reset the zoom to return to the full range.'
                : 'Lines appear here as soon as these targets have been probed. Pick a wider time range to look further back.'}
            </p>
          </div>
        ) : (
          <ErrorBoundary label="Comparison">
            <motion.div
              key={snapshot.window ? `${snapshot.window.start}-${snapshot.window.end}` : 'all'}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <CompareTrace
                lines={lines}
                start={snapshot.start}
                end={snapshot.end}
                zoomed={snapshot.window !== null}
                highlighted={highlighted}
                onZoom={onZoom}
                onResetZoom={onResetZoom}
              />
            </motion.div>

            {/* The legend. Smokeping prints each line's figures beside its
                colour; here that is a table, so the lines can be compared by
                number as well as by eye. */}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    <th className="pb-1.5 pr-4 font-medium">Line</th>
                    <th className="pb-1.5 pr-4 text-right font-medium">Now</th>
                    <th className="pb-1.5 pr-4 text-right font-medium">Median</th>
                    <th className="pb-1.5 pr-4 text-right font-medium">Avg</th>
                    <th className="hidden pb-1.5 pr-4 text-right font-medium md:table-cell">Min</th>
                    <th className="hidden pb-1.5 pr-4 text-right font-medium md:table-cell">Max</th>
                    <th className="pb-1.5 pr-4 text-right font-medium">Loss</th>
                    <th className="pb-1.5 text-right font-medium">Uptime</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ line, target, statistics, now }) => {
                    const loss = statistics?.packetLoss ?? 0
                    const nowValue = now ? now.p50Latency ?? now.latency : null

                    return (
                      <tr
                        key={line.key}
                        onMouseEnter={() => setHighlighted(line.key)}
                        onMouseLeave={() => setHighlighted(null)}
                        className={cn(
                          'border-t border-border/50 transition-colors',
                          highlighted === line.key && 'bg-muted/40'
                        )}
                      >
                        <td className="max-w-72 py-1.5 pr-4">
                          <div className="flex items-center gap-2">
                            <svg viewBox="0 0 16 6" className="h-1.5 w-4 shrink-0" aria-hidden="true">
                              <line
                                x1={1}
                                x2={15}
                                y1={3}
                                y2={3}
                                stroke={line.color}
                                strokeWidth={2.5}
                                strokeLinecap="round"
                                strokeDasharray={line.dashed ? '5 3' : undefined}
                              />
                            </svg>
                            {onSelectTarget ? (
                              <button
                                type="button"
                                onClick={() => onSelectTarget(target.id)}
                                onFocus={() => setHighlighted(line.key)}
                                onBlur={() => setHighlighted(null)}
                                className="min-w-0 cursor-pointer truncate text-left font-medium text-foreground underline-offset-2 hover:underline"
                                title={`Open ${target.name}`}
                              >
                                {line.label}
                              </button>
                            ) : (
                              <span className="min-w-0 truncate font-medium text-foreground">{line.label}</span>
                            )}
                            {showAddress && (
                              <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground lg:inline">
                                {targetAddressLabel(target)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono">
                          {!now ? (
                            <span className="text-muted-foreground/60">—</span>
                          ) : nowValue === null ? (
                            <span style={{ color: getPacketLossVar(100) }}>no reply</span>
                          ) : (
                            `${ms(nowValue)} ms`
                          )}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono">{ms(statistics?.medianLatency)}</td>
                        <td className="py-1.5 pr-4 text-right font-mono text-muted-foreground">
                          {ms(statistics?.avgLatency)}
                        </td>
                        <td className="hidden py-1.5 pr-4 text-right font-mono text-muted-foreground md:table-cell">
                          {ms(statistics?.minLatency)}
                        </td>
                        <td className="hidden py-1.5 pr-4 text-right font-mono text-muted-foreground md:table-cell">
                          {ms(statistics?.maxLatency)}
                        </td>
                        <td
                          className="py-1.5 pr-4 text-right font-mono"
                          style={statistics && isMeaningfulLoss(loss) ? { color: getPacketLossVar(loss) } : undefined}
                        >
                          {statistics ? `${loss.toFixed(loss > 0 && loss < 10 ? 1 : 0)}%` : '—'}
                        </td>
                        <td className="py-1.5 text-right font-mono text-muted-foreground">
                          {statistics ? `${statistics.uptime.toFixed(statistics.uptime < 100 ? 1 : 0)}%` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-[11px] text-muted-foreground/70">
                Latency columns are in milliseconds, over the period shown.{' '}
                {zoom ? 'Drag to zoom further · double-click the chart to reset.' : 'Drag across the chart to zoom in.'}
              </p>
            </div>
          </ErrorBoundary>
        )}
      </div>
    </section>
  )
}
