'use client'

import { useCallback, useMemo, useState, useRef, memo } from 'react'
import {
  getPacketLossVar,
  isMeaningfulLoss,
  PACKET_LOSS_BANDS,
  NO_DATA_COLOR,
} from '@/lib/charts/packet-loss-colors'
import type { DataPoint, TimeRange, TimeWindow } from '@/types/probe'
import type { ProbeAgentOutage } from '@/types/probe-agent'
import { inDisplayZone } from '@/lib/time-zone'
import {
  BrushBox,
  BrushLabel,
  TimeAxis,
  TimeGrid,
  chartHeightFor,
  readingsBoxStyle,
  latencyDomain,
  niceTicks,
  useChartBrush,
  useChartWidth,
  useOutsidePress,
} from './chart-brush'

/**
 * The smoke trace.
 *
 * Smokeping's defining idea is that a latency *average* hides what you need to
 * know. A path whose round trips scatter between 8ms and 400ms averages out
 * looking similar to one that sits steadily at 200ms, and only the first is
 * unusable for anything interactive. So the spread is drawn as translucent
 * smoke around the median, and the width of the smoke is the diagnosis.
 *
 * Two stacked panels sharing one time axis:
 *
 *   Latency — nested percentile bands (min-max, p10-p90, p25-p75) around the
 *             median, so density shows where packets actually landed.
 *   Loss    — its own 0-100% lane, because loss is a different quantity and a
 *             position on a millisecond axis would mean nothing.
 *
 * It is drawn the way Smokeping draws it: each interval is a column of its
 * own, flat across the top, with its median a short dash in the colour of its
 * loss. Nothing is joined to its neighbour. A line sloping from one reading to
 * the next would be drawing latencies that were never measured, and it is the
 * steps that make a sudden change look sudden.
 *
 * Intervals that lost packets are also striped across the latency panel, so
 * loss is visible without looking away from the trace you are reading.
 *
 * Dragging across either panel selects a period to zoom into; the parent
 * refetches that period, so the zoomed view is drawn from finer-grained data
 * rather than a stretched copy of what was already on screen.
 */

interface SmokeTraceProps {
  data: DataPoint[]
  timeRange: TimeRange
  height?: number
  /**
   * The zoomed period being shown. When set, the time axis spans exactly this
   * window rather than the extent of the data, so what was selected is what is
   * drawn even if probes are missing at either end.
   */
  window?: TimeWindow | null
  /** Called with the period selected by dragging, in epoch milliseconds. */
  onZoom?: (start: number, end: number) => void
  onResetZoom?: () => void
  /** Text for the loss lane when nothing was lost. */
  noLossLabel?: string
  /**
   * When the target's probe agent could not be reached. No readings were
   * taken then, and the stretch is shaded and labelled as the agent's, so the
   * gap is never read as the target being down.
   */
  agentOutages?: ProbeAgentOutage[]
}

interface Plotted {
  x: number
  /** The edges of this interval's column. */
  left: number
  right: number
  /** Pixel positions; null where the interval has no reading. */
  median: number | null
  low: number | null
  high: number | null
  p10: number | null
  p25: number | null
  p75: number | null
  p90: number | null
  loss: number
  color: string
  point: DataPoint
  index: number
}

/**
 * Nested bands, widest first. Opacities are chosen to accumulate: the middle of
 * the distribution is covered by all three and so reads as solid, while the
 * outer excursion stays a faint haze.
 */
const SMOKE_BANDS = [
  { key: 'minmax', lower: 'low', upper: 'high', opacity: 0.07 },
  { key: 'p10p90', lower: 'p10', upper: 'p90', opacity: 0.11 },
  { key: 'p25p75', lower: 'p25', upper: 'p75', opacity: 0.16 },
] as const

const PAD = { top: 14, right: 16, bottom: 26, left: 54 }
const NO_OUTAGES: ProbeAgentOutage[] = []
/** Fixed height, so the loss lane reads the same at every chart size. */
const LOSS_LANE = 56
const LANE_GAP = 16
/** How wide a column is when it is the only one, and so has no neighbour to measure against. */
const LONE_COLUMN = 12
/** Narrower than this, a column of loss is too thin to find. */
const MIN_LOSS_WIDTH = 3

export const SmokeTrace = memo(function SmokeTrace({
  data,
  timeRange,
  height: fullHeight = 340,
  window: zoomWindow = null,
  onZoom,
  onResetZoom,
  noLossLabel = 'No packet loss in this window',
  agentOutages = NO_OUTAGES,
}: SmokeTraceProps) {
  const [width, containerRef] = useChartWidth()
  const height = chartHeightFor(width, fullHeight)
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const clearHover = useCallback(() => setHover(null), [])
  useOutsidePress(svgRef, hover !== null, clearHover)

  const plotW = Math.max(120, width - PAD.left - PAD.right)
  const plotH = Math.max(140, height - PAD.top - PAD.bottom)
  const traceH = plotH - LOSS_LANE - LANE_GAP
  const traceBottom = PAD.top + traceH
  const lossTop = traceBottom + LANE_GAP
  const lossBottom = lossTop + LOSS_LANE

  const { plotted, yTicks, yMin, yMax, xMin, xMax, worstLoss } = useMemo(() => {
    const values: number[] = []

    for (const point of data) {
      for (const v of [point.latency, point.minLatency, point.maxLatency]) {
        if (v !== null && v !== undefined && Number.isFinite(v)) values.push(v)
      }
    }

    const { min: lo, max: hi } = latencyDomain(values)

    const times = data.map(d => d.timestamp.getTime())
    const tMin = zoomWindow?.start ?? (times.length ? Math.min(...times) : 0)
    // A probe agent still down took no readings since it went, so the
    // readings alone would end the axis where the outage starts and hide it.
    // The axis runs on to where the outage is now.
    const lastOutageEnd = Math.max(0, ...agentOutages.map(outage => outage.end ?? Date.now()))
    const tMax = zoomWindow?.end ?? Math.max(times.length ? Math.max(...times) : 1, times.length ? lastOutageEnd : 0)

    const xFor = (t: number) =>
      PAD.left + (tMax === tMin ? plotW / 2 : ((t - tMin) / (tMax - tMin)) * plotW)
    const yFor = (v: number) =>
      PAD.top + (hi === lo ? traceH / 2 : (1 - (v - lo) / (hi - lo)) * traceH)

    // Readings come one to an interval, evenly spaced, so the gap between two
    // neighbours is the width of a column.
    const xs = times.map(xFor)
    let column = Infinity
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1]
      if (gap > 0 && gap < column) column = gap
    }
    if (!Number.isFinite(column)) column = LONE_COLUMN

    const rows: Plotted[] = data.map((point, i) => {
      // The trace line is the median. Using the mean put the line outside its
      // own quartile band on any skewed distribution: one 18ms straggler among
      // 4ms packets drags the mean to 7.6ms while p75 sits at 6ms.
      // Rows written before the median was stored fall back to the mean.
      const median = point.p50Latency ?? point.latency
      const at = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v) ? null : yFor(v)

      return {
        x: xs[i],
        // The first and last intervals sit on the edges of the plot, and
        // keep the half of their column that is inside it.
        left: Math.max(PAD.left, xs[i] - column / 2),
        right: Math.min(PAD.left + plotW, xs[i] + column / 2),
        median: at(median),
        low: at(point.minLatency),
        high: at(point.maxLatency),
        p10: at(point.p10Latency),
        p25: at(point.p25Latency),
        p75: at(point.p75Latency),
        p90: at(point.p90Latency),
        loss: point.sampleCount === 0 ? 0 : point.packetLoss ?? 0,
        color: point.sampleCount === 0 ? NO_DATA_COLOR : getPacketLossVar(point.packetLoss ?? 0),
        point,
        index: i,
      }
    })

    return {
      plotted: rows,
      yTicks: niceTicks(lo, hi),
      yMin: lo,
      yMax: hi,
      xMin: tMin,
      xMax: tMax,
      worstLoss: rows.reduce((max, r) => Math.max(max, r.loss), 0),
    }
  }, [data, plotW, traceH, zoomWindow, agentOutages])

  // The stretches a probe agent was down, where they fall on this axis.
  const outageBands = useMemo(() => {
    if (xMax <= xMin) return []
    const xOf = (t: number) => PAD.left + ((t - xMin) / (xMax - xMin)) * plotW
    return agentOutages
      .map(outage => {
        const start = Math.max(xMin, outage.start)
        const end = Math.min(xMax, outage.end ?? Date.now())
        return end > start ? { key: outage.start, x: xOf(start), width: Math.max(2, xOf(end) - xOf(start)) } : null
      })
      .filter(band => band !== null)
  }, [agentOutages, xMin, xMax, plotW])

  const yPos = (v: number) =>
    PAD.top + (yMax === yMin ? traceH / 2 : (1 - (v - yMin) / (yMax - yMin)) * traceH)

  /** Contiguous runs of readings; a break is a period with no data. */
  const runs = useMemo(() => {
    const out: Plotted[][] = []
    let run: Plotted[] = []
    for (const p of plotted) {
      if (p.median === null) {
        if (run.length) out.push(run)
        run = []
      } else {
        run.push(p)
      }
    }
    if (run.length) out.push(run)
    return out
  }, [plotted])

  /**
   * One band of the smoke across a run of readings, as columns: along the tops
   * from left to right, stepping at each column's edge, and back along the
   * bottoms. One outline for the whole run rather than a rectangle for each
   * column, so that no seam shows where two columns meet.
   */
  const bandPath = (
    run: Plotted[],
    lower: (typeof SMOKE_BANDS)[number]['lower'],
    upper: (typeof SMOKE_BANDS)[number]['upper']
  ) => {
    let d = ''
    let piece: Plotted[] = []

    const close = () => {
      if (piece.length === 0) return
      d += `M ${piece[0].left},${piece[0][upper]}`
      for (const p of piece) d += ` V ${p[upper]} H ${p.right}`
      for (const p of [...piece].reverse()) d += ` V ${p[lower]} H ${p.left}`
      d += ' Z '
      piece = []
    }

    for (const p of run) {
      // Rows from before the percentiles were stored have a median and no
      // band; the band stops there and starts again after them.
      if (p[lower] === null || p[upper] === null) close()
      else piece.push(p)
    }
    close()

    return d || null
  }

  /** Where a column of loss is drawn: its interval's, widened if that is too thin to find. */
  const lossColumn = (p: Plotted) => {
    const width = Math.max(MIN_LOSS_WIDTH, p.right - p.left)
    return { x: (p.left + p.right) / 2 - width / 2, width }
  }

  const active = hover !== null ? plotted[hover] : null
  // Stripes flag trouble, so they use the noise floor. The lane below is
  // quantitative and still plots any non-zero reading.
  const lossy = plotted.filter(p => isMeaningfulLoss(p.loss))

  const brush = useChartBrush({
    svgRef,
    width,
    plotLeft: PAD.left,
    plotWidth: plotW,
    xMin,
    xMax,
    onZoom,
  })
  const canZoom = brush.enabled
  const selection = brush.selection

  /** The interval drawn nearest to a point on the screen. */
  const nearestTo = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || plotted.length === 0) return null

    const x = ((clientX - rect.left) / rect.width) * width
    let nearest = 0
    let best = Infinity
    for (const p of plotted) {
      const d = Math.abs(p.x - x)
      if (d < best) {
        best = d
        nearest = p.index
      }
    }
    return nearest
  }

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (plotted.length === 0 || brush.move(event)) return
    setHover(nearestTo(event.clientX))
  }

  const endBrush = (event: React.PointerEvent<SVGSVGElement>, commit: boolean) => {
    if (brush.end(event, commit)) {
      setHover(null)
      return
    }
    // A finger does not hover, so on a touchscreen a reading is asked for by
    // tapping. It shows on release, not on the press: a press is also how a
    // scroll of the page begins.
    if (commit && event.pointerType === 'touch') setHover(nearestTo(event.clientX))
  }

  const readingsBox = active
    ? readingsBoxStyle(active.x, [active.median, active.low, active.high], { width, height, top: PAD.top, bottom: traceBottom, halfWidth: 100, boxHeight: 150 })
    : undefined

  const spanMs = xMax - xMin

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        onPointerDown={brush.start}
        onPointerMove={handleMove}
        onPointerUp={event => endBrush(event, true)}
        onPointerCancel={event => endBrush(event, false)}
        // A finger "leaves" the moment it lifts, which would close the reading
        // its tap had just opened; that one is closed by pressing elsewhere.
        onPointerLeave={event => { if (event.pointerType !== 'touch') setHover(null) }}
        onDoubleClick={() => { if (zoomWindow) onResetZoom?.() }}
        role="img"
        aria-label={`Latency and packet loss over the last ${timeRange}. Worst packet loss ${worstLoss.toFixed(1)} percent.`}
        // `touch-pan-y` leaves vertical scrolling to the page while a sideways
        // drag selects; `select-none` stops that drag highlighting axis labels.
        className={`overflow-visible select-none touch-pan-y ${canZoom ? 'cursor-crosshair' : ''}`}
      >
        {/* Loss stripes run the full height of the latency panel, so a lossy
            interval is visible while reading the trace rather than only in the
            lane below. */}
        {lossy.map(p => (
          <rect
            key={`stripe-${p.index}`}
            {...lossColumn(p)}
            y={PAD.top}
            height={traceH}
            fill={p.color}
            opacity={0.07 + (p.loss / 100) * 0.16}
          />
        ))}

        {/* Where the probe agent was down: no readings, and not the target's fault. */}
        {outageBands.map(band => (
          <g key={`outage-${band.key}`}>
            <rect x={band.x} y={PAD.top} width={band.width} height={lossBottom - PAD.top} fill="var(--warning)" opacity={0.12} />
            {band.width > 90 && (
              <text
                x={band.x + band.width / 2}
                y={PAD.top + 12}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={10}
              >
                Probe agent offline: no readings
              </text>
            )}
          </g>
        ))}

        {/* Latency scale */}
        {yTicks.map(tick => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={yPos(tick)}
              y2={yPos(tick)}
              stroke="currentColor"
              className="text-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={yPos(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground font-mono"
              fontSize={10}
            >
              {tick}
            </text>
          </g>
        ))}
        {/* Unit captions sit above their panel's first gridline, left-aligned
            into the margin, so they cannot collide with a tick value. */}
        <text
          x={4}
          y={PAD.top - 3}
          className="fill-muted-foreground/70 font-mono"
          fontSize={9}
        >
          ms
        </text>

        <TimeGrid start={xMin} end={xMax} left={PAD.left} width={plotW} top={PAD.top} bottom={lossBottom} />

        {/* The smoke: nested percentile bands, faintest at the extremes and
            densest around the middle. Overlaying them builds up opacity where
            the packets actually clustered, which is what gives a Smokeping
            graph its characteristic fog — a single min-to-max ribbon only ever
            draws the outline. */}
        <g className="text-[var(--trace)]">
          {SMOKE_BANDS.map(band =>
            runs.map((run, i) => {
              const d = bandPath(run, band.lower, band.upper)
              return d ? (
                <path key={`${band.key}-${i}`} d={d} fill="currentColor" fillOpacity={band.opacity} />
              ) : null
            })
          )}
        </g>

        {/* The median: a dash across each interval's column, in the colour of
            that interval's loss. Not joined to the next one, so the colour
            changes exactly where the loss does and a jump stays a jump. */}
        {plotted.map(p =>
          p.median === null ? null : (
            <line
              key={`median-${p.index}`}
              x1={p.left}
              x2={p.right}
              y1={p.median}
              y2={p.median}
              stroke={p.color}
              strokeWidth={2}
            />
          )
        )}

        {/* ── Packet loss lane ────────────────────────────────────────────── */}
        <rect
          x={PAD.left}
          y={lossTop}
          width={plotW}
          height={LOSS_LANE}
          className="fill-muted"
          opacity={0.25}
          rx={2}
        />

        {[0, 50, 100].map(tick => {
          const y = lossBottom - (tick / 100) * LOSS_LANE
          return (
            <g key={`loss-tick-${tick}`}>
              {tick > 0 && (
                <line
                  x1={PAD.left}
                  x2={PAD.left + plotW}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  opacity={0.7}
                />
              )}
              {tick < 100 && (
                <text
                  x={PAD.left - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-muted-foreground font-mono"
                  fontSize={9}
                >
                  {tick}
                </text>
              )}
            </g>
          )
        })}

        <text
          x={4}
          y={lossTop - 5}
          className="fill-muted-foreground/70 font-mono"
          fontSize={9}
        >
          loss %
        </text>

        {/* Columns. A non-zero loss always gets at least 3px, so a 1% blip is
            still findable rather than rounding away to nothing. */}
        {plotted.map(p => {
          if (p.loss <= 0) return null
          const h = Math.max(3, (p.loss / 100) * LOSS_LANE)
          return (
            <rect
              key={`loss-${p.index}`}
              {...lossColumn(p)}
              y={lossBottom - h}
              height={h}
              fill={p.color}
            />
          )
        })}

        <line
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={lossBottom}
          y2={lossBottom}
          stroke="currentColor"
          className="text-border"
          strokeWidth={1}
        />

        {/* An empty lane should say why it is empty, rather than reading as a
            rendering failure. */}
        {worstLoss === 0 && (
          <text
            x={PAD.left + plotW / 2}
            y={lossTop + LOSS_LANE / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-muted-foreground"
            fontSize={10}
          >
            {noLossLabel}
          </text>
        )}

        <TimeAxis start={xMin} end={xMax} left={PAD.left} width={plotW} y={height - 8} />

        {/* The period being selected, across both panels: the loss lane is
            usually what prompted the zoom, so it has to be inside the box. */}
        {selection && <BrushBox selection={selection} top={PAD.top} bottom={lossBottom} />}

        {active && !selection && (
          <g>
            <line
              x1={active.x}
              x2={active.x}
              y1={PAD.top}
              y2={lossBottom}
              stroke="currentColor"
              className="text-muted-foreground"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.6}
            />
            {active.median !== null && (
              <circle cx={active.x} cy={active.median} r={3.5} fill={active.color} />
            )}
          </g>
        )}
      </svg>

      {selection && <BrushLabel selection={selection} chartWidth={width} spanMs={spanMs} />}

      {active && !selection && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-64 rounded-md border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm"
          style={readingsBox}
        >
          <p className="font-mono text-[11px] text-muted-foreground">
            {active.point.timestamp.toLocaleString('en-US', inDisplayZone({
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }))}
          </p>

          {active.point.sampleCount === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No probe ran in this interval</p>
          ) : (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground">Loss</dt>
              <dd className="font-mono font-medium" style={{ color: active.color }}>
                {(active.point.packetLoss ?? 0).toFixed(1)}%
              </dd>

              <dt className="text-muted-foreground">Median</dt>
              <dd className="font-mono">
                {active.point.p50Latency != null
                  ? `${active.point.p50Latency.toFixed(1)} ms`
                  : active.point.latency === null
                    ? 'no reply'
                    : `${active.point.latency.toFixed(1)} ms`}
              </dd>

              {active.point.p50Latency != null && active.point.latency !== null && (
                <>
                  <dt className="text-muted-foreground">Mean</dt>
                  <dd className="font-mono">{active.point.latency.toFixed(1)} ms</dd>
                </>
              )}

              {active.point.minLatency !== null && active.point.maxLatency !== null && (
                <>
                  <dt className="text-muted-foreground">Range</dt>
                  <dd className="font-mono">
                    {active.point.minLatency.toFixed(1)}–{active.point.maxLatency.toFixed(1)} ms
                  </dd>
                </>
              )}

              {active.point.p25Latency !== null && active.point.p75Latency !== null && (
                <>
                  <dt className="text-muted-foreground">Middle 50%</dt>
                  <dd className="font-mono">
                    {active.point.p25Latency.toFixed(1)}–{active.point.p75Latency.toFixed(1)} ms
                  </dd>
                </>
              )}

              {active.point.jitter !== null && (
                <>
                  <dt className="text-muted-foreground">Jitter</dt>
                  <dd className="font-mono">{active.point.jitter.toFixed(1)} ms</dd>
                </>
              )}

              <dt className="text-muted-foreground">Probes</dt>
              <dd className="font-mono">{active.point.sampleCount}</dd>
            </dl>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
        {PACKET_LOSS_BANDS.map(band => (
          <span key={band.label} className="flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm" style={{ backgroundColor: band.cssVar }} />
            <span className="text-muted-foreground">
              {band.label} <span className="font-mono">{band.range}</span>
            </span>
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-[var(--trace)] opacity-25" />
          <span className="text-muted-foreground">Latency distribution</span>
        </span>
        {outageBands.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm opacity-40" style={{ backgroundColor: 'var(--warning)' }} />
            <span className="text-muted-foreground">Probe agent offline: no readings</span>
          </span>
        )}
        {canZoom && (
          <span className="ml-auto text-muted-foreground/70">
            <span className="touch:hidden">
              {zoomWindow ? 'Drag to zoom further · double-click to reset' : 'Drag across the chart to zoom in'}
            </span>
            <span className="hidden touch:inline">
              {zoomWindow ? 'Tap for a reading · drag sideways to zoom further' : 'Tap for a reading · drag sideways to zoom in'}
            </span>
          </span>
        )}
      </div>
    </div>
  )
})
