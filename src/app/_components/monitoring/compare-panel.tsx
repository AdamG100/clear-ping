'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
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
import { Button } from '@/components/arc/button/button'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { ErrorBoundary } from '@/components/error-boundary'
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
 * Used for a group of targets, for the two address families of a single
 * target that is probed over both, and for the resolvers of a DNS target that
 * asks several.
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
  /** The resolver this line is, when the lines are a DNS target's resolvers. */
  resolver?: string
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
  reportError: (title: string, error?: unknown) => void,
  split?: 'resolver',
  splitFamily?: AddressFamily
) {
  // Which targets, and how often each is probed: everything about them that
  // the result depends on, as a value that only changes when one of those does.
  const owner = targets.map(target => `${target.id}:${target.interval}`).join(',')
  // Resolvers' lines are named by the server from the target's list as it is
  // now, so a resolver renamed or taken off is a reason to ask again.
  const named = split ? JSON.stringify(targets.map(target => target.probeConfig?.resolvers ?? [])) : ''

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
    const cacheKey = `${owner}|${split ?? ''}${splitFamily ?? ''}${named}|${timeRange}|${zoom ? `${zoom.start}-${zoom.end}` : 'all'}`
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
      const by = split ? `&split=${split}${splitFamily ? `&family=${splitFamily}` : ''}` : ''
      const response = await fetch(`/api/compare?targets=${[...intervals.keys()].join(',')}&${period}${by}`)
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
          key: `${item.targetId}:${item.family ?? 'all'}:${item.resolver ?? ''}`,
          targetId: item.targetId,
          family: item.family,
          resolver: item.resolver,
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
  }, [owner, timeRange, zoom, reportError, split, splitFamily, named])

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    loadRef.current()
  }, [owner, timeRange, zoom, refreshKey, splitFamily, named])

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
  nameSeries?: (target: Target, family: AddressFamily | null, resolver?: string) => string
  /** Draw a DNS target's resolvers as a line each, where it asks several. */
  split?: 'resolver'
  /** With `split`, on a target probed over both families: which one's lookups. */
  splitFamily?: AddressFamily
  /** What the column of failures is called for these lines. "Loss" unless said. */
  lossLabel?: string
  /** What the figures in the table are figures of, where that needs saying. */
  note?: string
  /** Whether each row also shows the target's address. */
  showAddress?: boolean
  /** When given, a row's name opens that target's own page. */
  onSelectTarget?: (id: string) => void
  reportError: (title: string, error?: unknown) => void
}

const defaultName = (target: Target, family: AddressFamily | null, resolver?: string) =>
  resolver ? `${target.name} · ${resolver}` : family ? `${target.name} · ${FAMILY_LABEL[family]}` : target.name

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
  split,
  splitFamily,
  lossLabel = 'Loss',
  note,
  showAddress = true,
  onSelectTarget,
  reportError,
}: ComparePanelProps) {
  const { snapshot, pending, initialLoad } = useComparison(targets, timeRange, zoom, refreshKey, reportError, split, splitFamily)
  const [highlighted, setHighlighted] = useState<string | null>(null)

  const rows = useMemo(() => {
    if (!snapshot) return []
    const byId = new Map(targets.map(target => [target.id, target]))

    return snapshot.series.flatMap((series, index) => {
      const target = byId.get(series.targetId)
      if (!target) return []

      const line: CompareLine = {
        key: series.key,
        label: nameSeries(target, series.family, series.resolver),
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
    <section className="min-h-[26rem] rounded-3xl border border-border bg-card p-4 @2xl/main:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        {zoom && (
          <p className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span>
              {formatWindowEdge(zoom.start)} – {formatWindowEdge(zoom.end)}
            </span>
            <Button variant="secondary" size="sm" onClick={onResetZoom}>
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
            {/* The columns a narrow pane has no room for are left out, least
                telling first, so that the ones that remain fit without the
                table having to be scrolled sideways: the extremes go first,
                then the two that say again what the median and the loss do. */}
            <div className="mt-4">
              <SortableDataTable
                caption="The lines on the chart"
                itemName={{ one: 'line', other: 'lines' }}
                rowKey="key"
                rows={rows.map(({ line, target, statistics, now }) => ({
                  key: line.key,
                  label: line.label,
                  now: now ? now.p50Latency ?? now.latency ?? -1 : null,
                  median: statistics?.medianLatency ?? null,
                  avg: statistics?.avgLatency ?? null,
                  min: statistics?.minLatency ?? null,
                  max: statistics?.maxLatency ?? null,
                  loss: statistics ? statistics.packetLoss ?? 0 : null,
                  uptime: statistics ? statistics.uptime : null,
                  line,
                  target,
                }))}
                columns={[
                  {
                    key: 'label',
                    label: 'Line',
                    render: (_, { line, target }) => (
                      <span
                        className="flex items-center gap-2"
                        onMouseEnter={() => setHighlighted(line.key)}
                        onMouseLeave={() => setHighlighted(null)}
                      >
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
                          <Tooltip content={`Open ${target.name}`}>
                            <button
                              type="button"
                              onClick={() => onSelectTarget(target.id)}
                              onFocus={() => setHighlighted(line.key)}
                              onBlur={() => setHighlighted(null)}
                              className="min-w-0 cursor-pointer truncate text-left font-medium text-foreground underline-offset-2 hover:underline"
                            >
                              {line.label}
                            </button>
                          </Tooltip>
                        ) : (
                          <span className="min-w-0 truncate font-medium text-foreground">{line.label}</span>
                        )}
                        {showAddress && (
                          <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground @4xl/main:inline">
                            {targetAddressLabel(target)}
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'now',
                    label: 'Now',
                    numeric: true,
                    render: value =>
                      value === null ? (
                        <span className="text-faint">—</span>
                      ) : value === -1 ? (
                        <span style={{ color: getPacketLossVar(100) }}>no reply</span>
                      ) : (
                        <span className="font-mono">{ms(value as number)} ms</span>
                      ),
                  },
                  { key: 'median', label: 'Median', numeric: true, render: value => <span className="font-mono">{ms(value as number | null)}</span> },
                  { key: 'avg', label: 'Avg', numeric: true, render: value => <span className="font-mono text-muted-foreground">{ms(value as number | null)}</span> },
                  { key: 'min', label: 'Min', numeric: true, render: value => <span className="font-mono text-muted-foreground">{ms(value as number | null)}</span> },
                  { key: 'max', label: 'Max', numeric: true, render: value => <span className="font-mono text-muted-foreground">{ms(value as number | null)}</span> },
                  {
                    key: 'loss',
                    label: lossLabel,
                    numeric: true,
                    render: value => {
                      if (value === null) return <span className="text-faint">—</span>
                      const loss = value as number
                      return (
                        <span className="font-mono" style={isMeaningfulLoss(loss) ? { color: getPacketLossVar(loss) } : undefined}>
                          {loss.toFixed(loss > 0 && loss < 10 ? 1 : 0)}%
                        </span>
                      )
                    },
                  },
                  {
                    key: 'uptime',
                    label: 'Uptime',
                    numeric: true,
                    render: value =>
                      value === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <span className="font-mono text-muted-foreground">{(value as number).toFixed((value as number) < 100 ? 1 : 0)}%</span>
                      ),
                  },
                ]}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                {note && <>{note} </>}
                Latency columns are in milliseconds, over the period shown.{' '}
                <span className="touch:hidden">
                  {zoom ? 'Drag to zoom further · double-click the chart to reset.' : 'Drag across the chart to zoom in.'}
                </span>
                <span className="hidden touch:inline">
                  {zoom
                    ? 'Tap the chart for readings · drag sideways to zoom further.'
                    : 'Tap the chart for readings · drag sideways to zoom in.'}
                </span>
              </p>
            </div>
          </ErrorBoundary>
        )}
      </div>
    </section>
  )
}
