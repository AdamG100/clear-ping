'use client'

import { useCallback, useId, useMemo, useState, useRef, memo } from 'react'
import { getPacketLossVar, isMeaningfulLoss } from '@/lib/charts/packet-loss-colors'
import { spikeCeiling } from '@/lib/charts/spikes'
import type { DataPoint } from '@/types/probe'
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
import { LossFigure } from './loss-figure'

/**
 * Several targets on one chart: Smokeping's multi-host graph.
 *
 * One target's page asks "is this path healthy". This asks the question that
 * needs more than one of them: is it this resolver or all of them, this site
 * or the uplink, IPv6 or both families. So every line shares one time axis and
 * one latency scale, and the answer is whether the lines move together.
 *
 * Only the median is drawn. The smoke that surrounds it on a single target's
 * chart would bury a dozen overlapping lines, and it is one click away on the
 * target's own page.
 *
 * Loss is not a latency, so it gets a strip per line underneath rather than a
 * position on the millisecond axis. Stacked in the same order as the legend,
 * the strips show at a glance whether loss hit one line or all of them at the
 * same moment.
 *
 * Past a handful of lines, colour alone cannot say which is which, so the line
 * under the pointer (or the strip) is picked out and the rest dimmed, and the
 * readings beside it put it first.
 */

export interface CompareLine {
  key: string
  label: string
  /** Its own: no two lines on a chart share one. */
  color: string
  points: DataPoint[]
}

interface CompareTraceProps {
  lines: CompareLine[]
  /** The period the chart spans, in epoch milliseconds. */
  start: number
  end: number
  /** Whether that period is a zoom into a wider one. */
  zoomed?: boolean
  /** The line picked out from the legend, if any; the rest are dimmed. */
  highlighted?: string | null
  /** Height of the latency plot with its axis; the loss strips go beneath it. */
  height?: number
  onZoom?: (start: number, end: number) => void
  onResetZoom?: () => void
}

const PAD = { top: 14, right: 16, bottom: 26, left: 54 }

/**
 * The share of the plot's height given to spikes, at the top, when there are
 * any: their own squeezed scale from where the usual readings end to the
 * highest spike, so a spike stays on the chart with its height in ms beside
 * it, and the usual readings still get most of the height.
 */
const SPIKE_BAND = 0.2
const LANE_GAP = 18
const STRIP_GAP = 2

/** How near the pointer a line has to pass to be the one picked out, in pixels. */
const PICK_PX = 14

/** More readings than this make a box taller than the chart. */
const MAX_READINGS = 10

interface PlottedPoint {
  x: number
  /** Pixel position of the median; null where there is no reading. */
  y: number | null
  loss: number
  point: DataPoint
}

interface PlottedLine extends CompareLine {
  plotted: PlottedPoint[]
  /** How far apart this line's readings are, in pixels. */
  spacing: number
}

const medianOf = (point: DataPoint) => point.p50Latency ?? point.latency

/** Runs of consecutive readings, as SVG path data; a break is a period with no reading. */
function linePaths(plotted: PlottedPoint[]): { paths: string[]; solos: PlottedPoint[] } {
  const paths: string[] = []
  const solos: PlottedPoint[] = []
  let run: PlottedPoint[] = []

  const flush = () => {
    if (run.length === 1) solos.push(run[0])
    else if (run.length > 1) paths.push('M ' + run.map(p => `${p.x.toFixed(1)},${(p.y as number).toFixed(1)}`).join(' L '))
    run = []
  }

  for (const p of plotted) {
    if (p.y === null) flush()
    else run.push(p)
  }
  flush()

  return { paths, solos }
}

/**
 * The stretch of a strip each reading with loss colours: out to halfway to
 * the readings either side, so a run of lossy readings is one solid bar
 * rather than a row of slivers. A reading beside a gap reaches no further
 * than it would beside another reading.
 *
 * Loss below the noise floor is left out, as it is from the smoke trace's
 * stripes: across a month of twenty lines it was a scatter of specks that
 * buried the loss worth seeing. The table still gives it as a figure.
 */
function lossCells(line: PlottedLine, plotLeft: number, plotRight: number) {
  const reach = Math.max(1.25, line.spacing / 2)
  const cells: Array<{ x: number; width: number; loss: number }> = []

  line.plotted.forEach((p, i) => {
    if (!isMeaningfulLoss(p.loss)) return
    const before = line.plotted[i - 1]
    const after = line.plotted[i + 1]
    let left = Math.max(plotLeft, before ? (before.x + p.x) / 2 : p.x - reach, p.x - reach)
    let right = Math.min(plotRight, after ? (after.x + p.x) / 2 : p.x + reach, p.x + reach)
    // Thinner than this, a single lossy reading in a month disappears.
    if (right - left < 2.5) {
      left = p.x - 1.25
      right = p.x + 1.25
    }
    cells.push({ x: left, width: right - left, loss: p.loss })
  })

  return cells
}

/** The readings either side of a moment. */
function around(line: PlottedLine, x: number) {
  let before: PlottedPoint | null = null
  let after: PlottedPoint | null = null
  for (const p of line.plotted) {
    if (p.x > x) {
      after = p
      break
    }
    before = p
  }
  return { before, after }
}

// A row with no samples is the marker for a break in probing.
const measured = (p: PlottedPoint | null): p is PlottedPoint => p !== null && p.point.sampleCount > 0

/**
 * What a line read at a moment: the nearer of the readings either side of it.
 *
 * Between two readings the line is drawn straight through, so there is a value
 * to report however far apart they are. A target probed every five minutes has
 * a reading every seventy pixels of a one-hour chart, and holding it to a
 * fixed few pixels left most of the chart reporting nothing for it. Only past
 * the end of a run, where no line is drawn, does a reading have to be close.
 */
function readingAt(line: PlottedLine, x: number): PlottedPoint | null {
  const { before, after } = around(line, x)
  if (measured(before) && measured(after)) return x - before.x <= after.x - x ? before : after

  const nearest = measured(before) ? before : measured(after) ? after : null
  const reach = Math.max(10, Math.min(17, line.spacing * 0.8))
  return nearest && Math.abs(nearest.x - x) <= reach ? nearest : null
}

/** Where the drawn line crosses a moment, in pixels: between readings, on the straight line joining them. */
function lineHeightAt(line: PlottedLine, x: number, top: number): number | null {
  const { before, after } = around(line, x)
  if (before?.y != null && after?.y != null && after.x > before.x) {
    const y = before.y + ((after.y - before.y) * (x - before.x)) / (after.x - before.x)
    return Math.max(top, y)
  }
  const at = readingAt(line, x)
  return at?.y == null ? null : Math.max(top, at.y)
}

export const CompareTrace = memo(function CompareTrace({
  lines,
  start,
  end,
  zoomed = false,
  highlighted = null,
  height: fullHeight = 320,
  onZoom,
  onResetZoom,
}: CompareTraceProps) {
  const [width, containerRef] = useChartWidth()
  // The point under the pointer, in chart units.
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const clipId = useId()
  const clearHover = useCallback(() => setHover(null), [])
  useOutsidePress(svgRef, hover !== null, clearHover)

  // The latency plot keeps its height however many lines there are; their
  // loss strips are added beneath it. Squeezing both into one fixed height
  // left twenty lines a plot a hundred pixels tall.
  const stripHeight = lines.length <= 4 ? 12 : lines.length <= 10 ? 9 : 7
  const laneHeight = Math.max(0, lines.length * (stripHeight + STRIP_GAP) - STRIP_GAP)

  const plotW = Math.max(120, width - PAD.left - PAD.right)
  const traceH = Math.max(120, chartHeightFor(width, fullHeight) - PAD.top - PAD.bottom)
  const traceBottom = PAD.top + traceH
  const lossTop = traceBottom + LANE_GAP
  const lossBottom = lossTop + laneHeight
  const totalHeight = lossBottom + PAD.bottom

  const { plottedLines, yTicks, yFor, spikes } = useMemo(() => {
    const values: number[] = []
    for (const line of lines) {
      for (const point of line.points) {
        const value = medianOf(point)
        if (value !== null && Number.isFinite(value)) values.push(value)
      }
    }

    // Spikes run off the top rather than flatten everything else.
    const ceiling = spikeCeiling(values)
    const { min: lo, max: hi } = latencyDomain(ceiling === null ? values : values.filter(v => v <= ceiling))

    const peak = values.length > 0 ? Math.max(...values) : hi
    const band = ceiling !== null && peak > hi ? Math.max(28, Math.round(traceH * SPIKE_BAND)) : 0
    const usualH = traceH - band

    const xFor = (t: number) => PAD.left + (end === start ? plotW / 2 : ((t - start) / (end - start)) * plotW)
    const yFor = (v: number) => {
      // Above the usual readings: squeezed into the band at the top.
      if (band > 0 && v > hi) return PAD.top + band - ((Math.min(v, peak) - hi) / (peak - hi)) * band
      return PAD.top + band + (hi === lo ? usualH / 2 : (1 - (v - lo) / (hi - lo)) * usualH)
    }

    const result: PlottedLine[] = lines.map(line => {
      const plotted = line.points.map(point => {
        const value = medianOf(point)
        return {
          x: xFor(point.timestamp.getTime()),
          y: value === null || !Number.isFinite(value) ? null : yFor(value),
          loss: point.sampleCount === 0 ? 0 : point.packetLoss ?? 0,
          point,
        }
      })
      const spacing = plotted.length > 1 ? plotW / (plotted.length - 1) : plotW
      return { ...line, plotted, spacing }
    })

    return {
      plottedLines: result,
      yTicks: niceTicks(lo, hi),
      yFor,
      spikes: band > 0 ? { from: hi, peak, edge: PAD.top + band } : null,
    }
  }, [lines, start, end, plotW, traceH])

  const yPos = yFor

  const brush = useChartBrush({
    svgRef,
    width,
    plotLeft: PAD.left,
    plotWidth: plotW,
    xMin: start,
    xMax: end,
    onZoom,
  })
  const selection = brush.selection

  /** A point on the screen in chart units, or null outside the plot. */
  const plotPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    const x = ((clientX - rect.left) / rect.width) * width
    const y = ((clientY - rect.top) / rect.height) * totalHeight
    return x >= PAD.left && x <= PAD.left + plotW ? { x, y } : null
  }

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (brush.move(event)) return
    setHover(plotPoint(event.clientX, event.clientY))
  }

  const handleUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (brush.end(event, true)) {
      setHover(null)
      return
    }
    // A finger does not hover, so on a touchscreen the readings are asked for
    // by tapping. They show on release, not on the press: a press is also how
    // a scroll of the page begins.
    if (event.pointerType === 'touch') setHover(plotPoint(event.clientX, event.clientY))
  }

  // Lines probe at their own intervals, so each is read on its own rather
  // than at one shared index.
  const readings = useMemo(() => {
    if (hover === null) return null
    return plottedLines.map(line => ({ line, at: readingAt(line, hover.x) }))
  }, [hover, plottedLines])

  // The line the pointer is on: the strip it is over, or the line passing
  // nearest it in the plot.
  const pointed = useMemo(() => {
    if (hover === null) return null
    if (hover.y >= lossTop - STRIP_GAP && hover.y <= lossBottom) {
      const row = Math.floor((hover.y - lossTop) / (stripHeight + STRIP_GAP))
      return plottedLines[Math.max(0, row)]?.key ?? null
    }
    let nearest: string | null = null
    let distance = PICK_PX
    for (const line of plottedLines) {
      const y = lineHeightAt(line, hover.x, PAD.top)
      if (y !== null && Math.abs(y - hover.y) < distance) {
        nearest = line.key
        distance = Math.abs(y - hover.y)
      }
    }
    return nearest
  }, [hover, plottedLines, lossTop, lossBottom, stripHeight])

  const focus = pointed ?? highlighted

  // Highest first, the order the lines are in on the chart. Past what a box
  // can hold, the ones nearest the pointer, and always the one picked out.
  const shown = useMemo(() => {
    if (!readings || hover === null) return null
    const valueOf = (at: PlottedPoint | null) => (at ? medianOf(at.point) ?? Infinity : -Infinity)
    let list = readings
    if (list.length > MAX_READINGS) {
      const distance = ({ line, at }: (typeof readings)[number]) =>
        line.key === focus ? -1 : at?.y == null ? Infinity : Math.abs(Math.max(PAD.top, at.y) - hover.y)
      list = readings.filter(({ at }) => at).sort((a, b) => distance(a) - distance(b)).slice(0, MAX_READINGS)
    }
    return { list: [...list].sort((a, b) => valueOf(b.at) - valueOf(a.at)), more: readings.length - list.length }
  }, [readings, hover, focus])

  const spanMs = end - start
  const hoverTime = hover === null ? null : start + ((hover.x - PAD.left) / plotW) * spanMs
  const readingsBox = hover === null || !shown
    ? undefined
    : readingsBoxStyle(hover.x, shown.list.map(({ at }) => at?.y), {
        width,
        height: totalHeight,
        top: PAD.top,
        bottom: traceBottom,
        halfWidth: 130,
        boxHeight: 34 + 18 * shown.list.length + (shown.more > 0 ? 18 : 0),
      })
  const dimmed = (key: string) => focus !== null && focus !== key

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${totalHeight}`}
        width="100%"
        height={totalHeight}
        onPointerDown={brush.start}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={event => brush.end(event, false)}
        // A finger "leaves" the moment it lifts, which would close the readings
        // its tap had just opened; those are closed by pressing elsewhere.
        onPointerLeave={event => { if (event.pointerType !== 'touch') setHover(null) }}
        onDoubleClick={() => { if (zoomed) onResetZoom?.() }}
        role="img"
        aria-label={`Median latency of ${lines.length} series on one chart: ${lines.map(line => line.label).join(', ')}.`}
        className={`overflow-visible select-none touch-pan-y ${brush.enabled ? 'cursor-crosshair' : ''}`}
      >
        <defs>
          {/* What runs above the scale is cut off at the top of the plot. */}
          <clipPath id={clipId}>
            <rect x={PAD.left - 4} y={PAD.top - 2} width={plotW + 8} height={traceH + 4} />
          </clipPath>
        </defs>

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
        <text x={4} y={PAD.top - 3} className="fill-muted-foreground/70 font-mono" fontSize={9}>
          ms
        </text>
        {spikes && (
          <g>
            {/* The highest spike, at the top of its band. */}
            <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top} y2={PAD.top} stroke="currentColor" className="text-border" strokeWidth={1} />
            <text x={PAD.left - 8} y={PAD.top} textAnchor="end" dominantBaseline="middle" className="fill-signal-critical font-mono" fontSize={10}>
              {Math.round(spikes.peak)}
            </text>
            {/* Where the scale changes: dashed across, and a break in the axis. */}
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={spikes.edge}
              y2={spikes.edge}
              stroke="currentColor"
              className="text-muted-foreground/50"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <path
              d={`M ${PAD.left - 5} ${spikes.edge + 3} l 4 -3 l 2 3 l 4 -3`}
              fill="none"
              stroke="currentColor"
              className="text-muted-foreground"
              strokeWidth={1}
            />
            <text x={PAD.left + plotW} y={PAD.top - 4} textAnchor="end" className="fill-muted-foreground font-mono" fontSize={9}>
              scale squeezed above {Math.round(spikes.from)} ms
            </text>
          </g>
        )}
        <TimeGrid start={start} end={end} left={PAD.left} width={plotW} top={PAD.top} bottom={lossBottom} />

        {/* One median line per series. The one picked out is drawn last, so
            it sits on top of the lines it crosses. */}
        <g clipPath={`url(#${clipId})`}>
          {[...plottedLines]
            .sort((a, b) => Number(a.key === focus) - Number(b.key === focus))
            .map(line => {
              const { paths, solos } = linePaths(line.plotted)
              return (
                <g
                  key={line.key}
                  opacity={dimmed(line.key) ? 0.15 : 1}
                  className="transition-opacity duration-150 motion-reduce:transition-none"
                >
                  {paths.map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      fill="none"
                      stroke={line.color}
                      strokeWidth={line.key === focus ? 3 : 2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ))}
                  {solos.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y as number} r={2.5} fill={line.color} />
                  ))}
                </g>
              )
            })}
        </g>

        {/* ── Loss strips, one per series ─────────────────────────────────── */}
        <text x={4} y={lossTop - 6} className="fill-muted-foreground/70 font-mono" fontSize={9}>
          loss
        </text>

        {plottedLines.map((line, row) => {
          const y = lossTop + row * (stripHeight + STRIP_GAP)
          return (
            <g
              key={line.key}
              opacity={dimmed(line.key) ? 0.3 : 1}
              className="transition-opacity duration-150 motion-reduce:transition-none"
            >
              {/* Which line this strip belongs to. */}
              <line
                x1={PAD.left - 24}
                x2={PAD.left - 8}
                y1={y + stripHeight / 2}
                y2={y + stripHeight / 2}
                stroke={line.color}
                strokeWidth={line.key === focus ? 3.5 : 2.5}
                strokeLinecap="round"
              />
              <rect
                x={PAD.left}
                y={y}
                width={plotW}
                height={stripHeight}
                className="fill-muted"
                opacity={line.key === focus ? 0.7 : 0.35}
                rx={Math.min(3, stripHeight / 2)}
              />
              {lossCells(line, PAD.left, PAD.left + plotW).map((cell, i) => (
                <rect
                  key={i}
                  x={cell.x}
                  y={y}
                  width={cell.width}
                  height={stripHeight}
                  fill={getPacketLossVar(cell.loss)}
                  rx={Math.min(1.5, cell.width / 2)}
                />
              ))}
            </g>
          )
        })}

        <TimeAxis start={start} end={end} left={PAD.left} width={plotW} y={totalHeight - 8} />

        {selection && <BrushBox selection={selection} top={PAD.top} bottom={lossBottom} />}

        {hover !== null && readings && !selection && (
          <g pointerEvents="none">
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={lossBottom}
              stroke="currentColor"
              className="text-muted-foreground"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.6}
            />
            {readings.map(({ line, at }) =>
              at && at.y !== null ? (
                <circle
                  key={line.key}
                  cx={at.x}
                  cy={Math.max(PAD.top, at.y)}
                  r={line.key === focus ? 4.5 : 3.5}
                  fill={line.color}
                  className="stroke-card"
                  strokeWidth={line.key === focus ? 2 : 0}
                  opacity={dimmed(line.key) ? 0.25 : 1}
                />
              ) : null
            )}
          </g>
        )}
      </svg>

      {selection && <BrushLabel selection={selection} chartWidth={width} spanMs={spanMs} />}

      {hoverTime !== null && shown && !selection && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-64 rounded-md border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm"
          style={readingsBox}
        >
          <p className="font-mono text-[11px] text-muted-foreground">
            {new Date(hoverTime).toLocaleString('en-US', inDisplayZone({
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }))}
          </p>
          <dl className="mt-1.5 space-y-0.5 text-xs">
            {shown.list.map(({ line, at }) => {
              const value = at ? medianOf(at.point) : null
              const picked = line.key === focus
              return (
                <div key={line.key} className={`flex items-baseline gap-2 ${dimmed(line.key) ? 'opacity-60' : ''}`}>
                  <span
                    className="h-2 w-2 shrink-0 translate-y-px rounded-full"
                    style={{ backgroundColor: line.color }}
                    aria-hidden="true"
                  />
                  <dt className={`min-w-0 flex-1 truncate ${picked ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                    {line.label}
                  </dt>
                  <dd className="shrink-0 font-mono">
                    {!at ? (
                      <span className="text-muted-foreground/60">—</span>
                    ) : value === null ? (
                      <LossFigure loss={100}>no reply</LossFigure>
                    ) : (
                      <>
                        {value.toFixed(1)} ms
                        {isMeaningfulLoss(at.loss) && <LossFigure loss={at.loss} className="ml-2" />}
                      </>
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
          {shown.more > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {shown.more} more {shown.more === 1 ? 'line' : 'lines'}: point nearer them to read them
            </p>
          )}
        </div>
      )}
    </div>
  )
})
