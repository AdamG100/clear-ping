'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
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
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { ErrorBoundary } from '@/components/error-boundary'
import { cn } from '@/lib/utils'
import { FAMILY_LABEL } from '@/lib/probes/host'
import { targetAddressLabel } from '@/lib/probes/config'
import { buildSeries, comparisonPointsPer, MAX_COMPARED_TARGETS } from '@/lib/charts/series'
import { formatWindowEdge } from './chart-brush'
import { CompareTrace, type CompareLine } from './compare-trace'
import { LossFigure } from './loss-figure'
import { LossKey } from './loss-key'
import { TraceSkeleton } from '../dashboard/skeleton'
import { Masked } from '../privacy/masked'
import { useMask } from '../privacy/use-privacy'

/**
 * A comparison chart with its legend: the lines, and under them a table that
 * says what each line is and how it did over the period.
 *
 * Used for a group of targets, for the two address families of a single
 * target that is probed over both, and for the resolvers of a DNS target that
 * asks several.
 */

/** How many lines have a colour of the palette's: the `--line-*` tokens in `globals.css`. */
const PALETTE_SIZE = 16

/**
 * A line's colour: no two lines share one. The first sixteen come from the
 * palette; after it, each line gets a hue of its own, stepped round the
 * wheel by the golden angle so that consecutive lines land far apart, at
 * three lightnesses in turn. Past a dozen lines, though, it is picking a line
 * out (pointing at it, or unticking the others) that says which is which.
 */
function seriesColor(index: number): string {
  if (index < PALETTE_SIZE) return `var(--line-${index + 1})`
  const step = index - PALETTE_SIZE
  const hue = (step * 137.508 + 20) % 360
  const lift = [0, -0.08, 0.08][step % 3]
  return `oklch(calc(var(--line-l) + ${lift}) 0.15 ${hue.toFixed(1)})`
}

interface LoadedSeries {
  key: string
  targetId: string
  /** The probe it was measured from, when the comparison asks for more than each monitor's first. */
  probe?: string
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
  splitFamily?: AddressFamily,
  /** 'all' draws a line for each probe of each monitor; a probe id moves every monitor to that probe. */
  probes?: string,
  /** Exactly these lines, as `monitor:probe,…`, in place of one for each monitor: a saved comparison's. */
  drawn?: string
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
    const cacheKey = `${owner}|${split ?? ''}${splitFamily ?? ''}${named}|${probes ?? ''}|${drawn ?? ''}|${timeRange}|${zoom ? `${zoom.start}-${zoom.end}` : 'all'}`
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
      const by =
        (split ? `&split=${split}${splitFamily ? `&family=${splitFamily}` : ''}` : '') +
        (probes === 'all' ? '&probes=all' : probes ? `&probe=${encodeURIComponent(probes)}` : '')
      const ids = [...intervals.keys()].slice(0, MAX_COMPARED_TARGETS)
      const asked = drawn ? `series=${encodeURIComponent(drawn)}` : `targets=${ids.join(',')}`
      const response = await fetch(`/api/compare?${asked}&${period}${by}&maxPoints=${comparisonPointsPer(drawn ? drawn.split(',').length : ids.length)}`)
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
          key: `${item.targetId}:${item.probe ?? ''}:${item.family ?? 'all'}:${item.resolver ?? ''}`,
          targetId: item.targetId,
          probe: item.probe,
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
  }, [owner, timeRange, zoom, reportError, split, splitFamily, named, probes, drawn])

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    loadRef.current()
  }, [owner, timeRange, zoom, refreshKey, splitFamily, named, probes, drawn])

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
  nameSeries?: (target: Target, family: AddressFamily | null, resolver?: string, probeName?: string) => string
  /** Draw a DNS target's resolvers as a line each, where it asks several. */
  split?: 'resolver'
  /** With `split`, on a target probed over both families: which one's lookups. */
  splitFamily?: AddressFamily
  /** 'all': a line for each probe of each monitor. A probe id: every monitor measured from that probe. */
  probes?: string
  /** Exactly these lines, as `monitor:probe,…`: a saved comparison's. Each is named for its probe. */
  drawn?: string
  /** What each probe is called, for the lines' names. */
  probeNames?: ReadonlyMap<string, string>
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

/** Every line drawn: one set for all, so a render that hides nothing changes nothing. */
const NONE_HIDDEN: ReadonlySet<string> = new Set()

/** More lines than this are too many to start with all of them drawn. */
const CROWDED = 12

/** How many of a crowded comparison's lines are drawn to begin with. */
const DRAWN_AT_FIRST = 8

/**
 * The lines a comparison starts with off the chart: none, unless there are
 * too many to read, when all but the ones that lost the most, then the
 * slowest, are left for the viewer to tick. Those are the ones worth a look.
 */
function hiddenAtFirst(rows: Array<{ line: CompareLine; statistics: TargetStatistics | null }>): ReadonlySet<string> {
  if (rows.length <= CROWDED) return new Set()
  const worstFirst = [...rows].sort(
    (a, b) =>
      (b.statistics?.packetLoss ?? 0) - (a.statistics?.packetLoss ?? 0) ||
      (b.statistics?.medianLatency ?? 0) - (a.statistics?.medianLatency ?? 0)
  )
  return new Set(worstFirst.slice(DRAWN_AT_FIRST).map(row => row.line.key))
}

const defaultName = (target: Target, family: AddressFamily | null, resolver?: string, probeName?: string) =>
  [target.name, probeName, resolver ?? (family ? FAMILY_LABEL[family] : undefined)].filter(Boolean).join(' · ')

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
  probes,
  drawn,
  probeNames,
  lossLabel = 'Loss',
  note,
  showAddress = true,
  onSelectTarget,
  reportError,
}: ComparePanelProps) {
  const { snapshot, pending, initialLoad } = useComparison(targets, timeRange, zoom, refreshKey, reportError, split, splitFamily, probes, drawn)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const mask = useMask()

  const rows = useMemo(() => {
    if (!snapshot) return []
    const byId = new Map(targets.map(target => [target.id, target]))

    return snapshot.series.flatMap((series, index) => {
      const target = byId.get(series.targetId)
      if (!target) return []

      // Coloured by place among all the lines, not the ones shown, so hiding
      // one does not repaint the rest.
      const line: CompareLine = {
        key: series.key,
        label: mask.text(nameSeries(target, series.family, series.resolver, (probes === 'all' || drawn) && series.probe ? probeNames?.get(series.probe) ?? series.probe : undefined)),
        color: seriesColor(index),
        points: series.points,
      }
      return [{ line, target, statistics: series.statistics, now: latestReading(series.points) }]
    })
  }, [snapshot, targets, nameSeries, mask, probes, drawn, probeNames])

  // Lines taken off the chart from the legend. The rest are rescaled to fill
  // it, so hiding the slow one shows the fast ones in detail. Held for one set
  // of targets: another group starts afresh, and a crowded one starts with
  // only its worst few drawn. Settled once, when that set's first lines
  // arrive, so a refresh never swaps lines in or out on its own.
  const owner = snapshot?.owner ?? null
  // Until the viewer ticks something, a change in how many lines there are
  // (a resolver added to the list) settles it again.
  const [choice, setChoice] = useState<{ owner: string; count: number; hidden: ReadonlySet<string>; untouched: boolean } | null>(null)
  if (owner !== null && rows.length > 0 && (choice?.owner !== owner || (choice.untouched && choice.count !== rows.length))) {
    setChoice({ owner, count: rows.length, hidden: hiddenAtFirst(rows), untouched: true })
  }
  const hidden = choice?.owner === owner ? choice.hidden : NONE_HIDDEN
  const setHidden = (next: ReadonlySet<string>) => {
    if (owner !== null) setChoice({ owner, count: rows.length, hidden: next, untouched: false })
  }

  const toggleLine = (key: string) => {
    const next = new Set(hidden)
    if (!next.delete(key)) next.add(key)
    setHidden(next)
  }


  const lines = useMemo(() => rows.map(row => row.line).filter(line => !hidden.has(line.key)), [rows, hidden])
  const hiddenCount = rows.length - lines.length
  const hasMeasurements = rows.some(row => (row.statistics?.sampleCount ?? 0) > 0)

  return (
    <section className="min-h-[26rem] rounded-3xl border border-border bg-card p-4 @2xl/main:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          {targets.length > MAX_COMPARED_TARGETS && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              The first {MAX_COMPARED_TARGETS} of its {targets.length} targets are compared: more than that is a group to split.
            </p>
          )}
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
                : 'Lines appear here as soon as these monitors have been probed. Pick a wider time range to look further back.'}
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
              {lines.length > 0 ? (
                <CompareTrace
                  lines={lines}
                  start={snapshot.start}
                  end={snapshot.end}
                  zoomed={snapshot.window !== null}
                  highlighted={highlighted}
                  onZoom={onZoom}
                  onResetZoom={onResetZoom}
                />
              ) : (
                <div className="flex h-[20rem] flex-col items-center justify-center gap-2 text-center">
                  <p className="text-sm text-foreground">Every line is hidden</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Tick a line in the table below to put it back on the chart.
                  </p>
                </div>
              )}
            </motion.div>

            {/* What the colours in the loss strips mean. */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
              <span className="text-muted-foreground">{lossLabel} in the strips:</span>
              <LossKey withClear={false} />
            </div>

            {/* Which lines are drawn, said where the boxes that choose them
                are, so it is plain that ticking them is how. One box ticks or
                unticks them all, lined up over the rows' own: comparing two
                lines among twenty starts from none, then the two ticked. */}
            {rows.length > 1 && (
              <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-1">
                <Checkbox
                  label="All lines"
                  checked={hiddenCount === 0 ? true : hiddenCount === rows.length ? false : 'indeterminate'}
                  onCheckedChange={() => setHidden(hiddenCount === 0 ? new Set(rows.map(row => row.line.key)) : new Set())}
                />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {hiddenCount === 0 ? `All ${rows.length} shown` : `${lines.length} of ${rows.length} shown`}
                  </span>
                  {' · '}
                  {rows.length > CROWDED && choice?.untouched
                    ? `With this many, the chart starts with the ${DRAWN_AT_FIRST} that lost the most, or else the slowest. Tick others to add them.`
                    : 'Tick or untick a line to show or hide it.'}
                </p>
              </div>
            )}

            {/* The legend. Smokeping prints each line's figures beside its
                colour; here that is a table, so the lines can be compared by
                number as well as by eye. */}
            {/* The columns a narrow pane has no room for are left out, least
                telling first, so that the ones that remain fit without the
                table having to be scrolled sideways: the extremes go first,
                then the two that say again what the median and the loss do. */}
            <div className={rows.length > 1 ? 'mt-2' : 'mt-4'}>
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
                    render: (_, { line, target }) => {
                      const off = hidden.has(line.key)
                      return (
                        <span
                          className="flex items-center gap-2"
                          onMouseEnter={() => { if (!off) setHighlighted(line.key) }}
                          onMouseLeave={() => setHighlighted(null)}
                        >
                          {/* Whether the line is drawn: a box filled with the
                              line's own colour, so it is the line's key too.
                              Held to the row's height; its hit area is the
                              full 44px all the same. */}
                          <span className="-my-3 -ml-3 -mr-1 flex shrink-0">
                            <Checkbox
                              checked={!off}
                              onCheckedChange={() => {
                                toggleLine(line.key)
                                setHighlighted(null)
                              }}
                              aria-label={`Show ${line.label} on the chart`}
                              style={{ '--control-on': line.color, '--control-glyph': 'var(--surface)' } as CSSProperties}
                            />
                          </span>
                          {onSelectTarget ? (
                            <Tooltip content={`Open ${target.name}`}>
                              <button
                                type="button"
                                onClick={() => onSelectTarget(target.id)}
                                onFocus={() => setHighlighted(line.key)}
                                onBlur={() => setHighlighted(null)}
                                className={cn(
                                  'min-w-0 cursor-pointer truncate text-left font-medium underline-offset-2 hover:underline',
                                  off ? 'text-muted-foreground' : 'text-foreground'
                                )}
                              >
                                {line.label}
                              </button>
                            </Tooltip>
                          ) : (
                            <span className={cn('min-w-0 truncate font-medium', off ? 'text-muted-foreground' : 'text-foreground')}>
                              {line.label}
                            </span>
                          )}
                          {showAddress && (
                            <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground @4xl/main:inline">
                              <Masked text value={targetAddressLabel(target)} />
                            </span>
                          )}
                        </span>
                      )
                    },
                  },
                  {
                    key: 'now',
                    label: 'Now',
                    numeric: true,
                    render: value =>
                      value === null ? (
                        <span className="text-faint">—</span>
                      ) : value === -1 ? (
                        <LossFigure loss={100}>no reply</LossFigure>
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
                    render: value => (value === null ? <span className="text-faint">—</span> : <LossFigure loss={value as number} />),
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
                  {rows.length > 2 && 'Point at a line or its loss strip to pick it out. '}
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
