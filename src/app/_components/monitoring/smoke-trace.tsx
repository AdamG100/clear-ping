'use client'

import { useMemo, useState, useRef, memo, useCallback } from 'react'
import {
  getPacketLossVar,
  isMeaningfulLoss,
  PACKET_LOSS_BANDS,
  NO_DATA_COLOR,
} from '@/lib/packet-loss-colors'
import type { DataPoint, TimeRange } from '@/types/probe'

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
 * Intervals that lost packets are also striped across the latency panel, so
 * loss is visible without looking away from the trace you are reading.
 */

interface SmokeTraceProps {
  data: DataPoint[]
  timeRange: TimeRange
  height?: number
}

interface Plotted {
  x: number
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
/** Fixed height, so the loss lane reads the same at every chart size. */
const LOSS_LANE = 56
const LANE_GAP = 16

function formatTick(value: number, timeRange: TimeRange) {
  const date = new Date(value)
  if (timeRange === '7d' || timeRange === '30d') {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? mag * 10

  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

export const SmokeTrace = memo(function SmokeTrace({
  data,
  timeRange,
  height = 340,
}: SmokeTraceProps) {
  const [width, setWidth] = useState(880)
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width
      if (next && next > 0) setWidth(next)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const plotW = Math.max(120, width - PAD.left - PAD.right)
  const plotH = Math.max(140, height - PAD.top - PAD.bottom)
  const traceH = plotH - LOSS_LANE - LANE_GAP
  const traceBottom = PAD.top + traceH
  const lossTop = traceBottom + LANE_GAP
  const lossBottom = lossTop + LOSS_LANE

  const { plotted, yTicks, yMin, yMax, xMin, xMax, barWidth, worstLoss } = useMemo(() => {
    const values: number[] = []

    for (const point of data) {
      for (const v of [point.latency, point.minLatency, point.maxLatency]) {
        if (v !== null && v !== undefined && Number.isFinite(v)) values.push(v)
      }
    }

    const dataMin = values.length ? Math.min(...values) : 0
    const dataMax = values.length ? Math.max(...values) : 100

    // Padding is proportional to the observed range. A fixed 2ms floor swamped
    // it on LAN paths: a 2-6ms trace was padded to a 0-8ms domain and used
    // under half the panel.
    const span = dataMax - dataMin
    const pad = Math.max(span * 0.18, span === 0 ? Math.max(dataMax * 0.1, 0.5) : 0.2)

    const lo = Math.max(0, dataMin - pad)
    const hi = dataMax + pad

    const times = data.map(d => d.timestamp.getTime())
    const tMin = times.length ? Math.min(...times) : 0
    const tMax = times.length ? Math.max(...times) : 1

    const xFor = (t: number) =>
      PAD.left + (tMax === tMin ? plotW / 2 : ((t - tMin) / (tMax - tMin)) * plotW)
    const yFor = (v: number) =>
      PAD.top + (hi === lo ? traceH / 2 : (1 - (v - lo) / (hi - lo)) * traceH)

    const rows: Plotted[] = data.map((point, i) => {
      // The trace line is the median. Using the mean put the line outside its
      // own quartile band on any skewed distribution: one 18ms straggler among
      // 4ms packets drags the mean to 7.6ms while p75 sits at 6ms.
      // Rows written before the median was stored fall back to the mean.
      const median = point.p50Latency ?? point.latency
      const at = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v) ? null : yFor(v)

      return {
        x: xFor(point.timestamp.getTime()),
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

    const spacing = rows.length > 1 ? plotW / (rows.length - 1) : plotW
    return {
      plotted: rows,
      yTicks: niceTicks(lo, hi),
      yMin: lo,
      yMax: hi,
      xMin: tMin,
      xMax: tMax,
      barWidth: Math.min(14, Math.max(3, spacing * 0.65)),
      worstLoss: rows.reduce((max, r) => Math.max(max, r.loss), 0),
    }
  }, [data, plotW, traceH])

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

  const bandPath = (
    run: Plotted[],
    lower: (typeof SMOKE_BANDS)[number]['lower'],
    upper: (typeof SMOKE_BANDS)[number]['upper']
  ) => {
    const usable = run.filter(p => p[lower] !== null && p[upper] !== null)
    if (usable.length < 2) return null
    const top = usable.map(p => `${p.x},${p[upper] as number}`).join(' L ')
    const bottom = [...usable].reverse().map(p => `${p.x},${p[lower] as number}`).join(' L ')
    return `M ${top} L ${bottom} Z`
  }

  const active = hover !== null ? plotted[hover] : null
  // Stripes flag trouble, so they use the noise floor. The lane below is
  // quantitative and still plots any non-zero reading.
  const lossy = plotted.filter(p => isMeaningfulLoss(p.loss))

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || plotted.length === 0) return

    const x = ((event.clientX - rect.left) / rect.width) * width
    let nearest = 0
    let best = Infinity
    for (const p of plotted) {
      const d = Math.abs(p.x - x)
      if (d < best) {
        best = d
        nearest = p.index
      }
    }
    setHover(nearest)
  }

  const tooltipLeft = active ? Math.min(Math.max(active.x, 100), width - 100) : 0

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Latency and packet loss over the last ${timeRange}. Worst packet loss ${worstLoss.toFixed(1)} percent.`}
        className="overflow-visible"
      >
        {/* Loss stripes run the full height of the latency panel, so a lossy
            interval is visible while reading the trace rather than only in the
            lane below. */}
        {lossy.map(p => (
          <rect
            key={`stripe-${p.index}`}
            x={p.x - barWidth / 2}
            y={PAD.top}
            width={barWidth}
            height={traceH}
            fill={p.color}
            opacity={0.07 + (p.loss / 100) * 0.16}
          />
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

        {/* Layer 3 — the median, one segment per interval so colour changes
            exactly where loss changes */}
        {runs.map((run, runIndex) =>
          run.slice(1).map((p, i) => (
            <line
              key={`seg-${runIndex}-${i}`}
              x1={run[i].x}
              y1={run[i].median as number}
              x2={p.x}
              y2={p.median as number}
              stroke={p.color}
              strokeWidth={2}
              strokeLinecap="round"
            />
          ))
        )}

        {runs
          .filter(run => run.length === 1)
          .map((run, i) => (
            <circle key={`solo-${i}`} cx={run[0].x} cy={run[0].median as number} r={2.5} fill={run[0].color} />
          ))}

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
              x={p.x - barWidth / 2}
              y={lossBottom - h}
              width={barWidth}
              height={h}
              fill={p.color}
              rx={1}
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
            No packet loss in this window
          </text>
        )}

        {/* Time axis */}
        {[xMin, (xMin + xMax) / 2, xMax].map((t, i) => (
          <text
            key={`x-${i}`}
            x={PAD.left + (i * plotW) / 2}
            y={height - 8}
            textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
            className="fill-muted-foreground font-mono"
            fontSize={10}
          >
            {formatTick(t, timeRange)}
          </text>
        ))}

        {active && (
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

      {active && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm"
          style={{ left: `${(tooltipLeft / width) * 100}%` }}
        >
          <p className="font-mono text-[11px] text-muted-foreground">
            {active.point.timestamp.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
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
      </div>
    </div>
  )
})
