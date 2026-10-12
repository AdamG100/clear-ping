'use client'

import { useCallback, useMemo, useState, useRef, memo } from 'react'
import { getPacketLossVar, isMeaningfulLoss } from '@/lib/packet-loss-colors'
import type { DataPoint } from '@/types/probe'
import {
  BrushBox,
  BrushLabel,
  TimeAxis,
  TimeGrid,
  chartHeightFor,
  holdInside,
  latencyDomain,
  niceTicks,
  useChartBrush,
  useChartWidth,
  useOutsidePress,
} from './chart-brush'

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
 */

export interface CompareLine {
  key: string
  label: string
  color: string
  /** Drawn dashed: how the palette is stretched once it has gone round once. */
  dashed?: boolean
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
  height?: number
  onZoom?: (start: number, end: number) => void
  onResetZoom?: () => void
}

const PAD = { top: 14, right: 16, bottom: 26, left: 54 }
const LANE_GAP = 18
const STRIP_GAP = 2

interface PlottedPoint {
  x: number
  /** Pixel position of the median; null where there is no reading. */
  y: number | null
  loss: number
  point: DataPoint
}

interface PlottedLine extends CompareLine {
  plotted: PlottedPoint[]
  /** Width of one loss cell, from how closely this line's points are spaced. */
  cellWidth: number
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
 * What a line read at a moment: the nearer of the readings either side of it.
 *
 * Between two readings the line is drawn straight through, so there is a value
 * to report however far apart they are. A target probed every five minutes has
 * a reading every seventy pixels of a one-hour chart, and holding it to a
 * fixed few pixels left most of the chart reporting nothing for it. Only past
 * the end of a run, where no line is drawn, does a reading have to be close.
 */
function readingAt(line: PlottedLine, x: number): PlottedPoint | null {
  let before: PlottedPoint | null = null
  let after: PlottedPoint | null = null
  for (const p of line.plotted) {
    if (p.x > x) {
      after = p
      break
    }
    before = p
  }

  // A row with no samples is the marker for a break in probing.
  const measured = (p: PlottedPoint | null): p is PlottedPoint => p !== null && p.point.sampleCount > 0
  if (measured(before) && measured(after)) return x - before.x <= after.x - x ? before : after

  const nearest = measured(before) ? before : measured(after) ? after : null
  const reach = Math.max(10, line.cellWidth * 1.2)
  return nearest && Math.abs(nearest.x - x) <= reach ? nearest : null
}

export const CompareTrace = memo(function CompareTrace({
  lines,
  start,
  end,
  zoomed = false,
  highlighted = null,
  height: fullHeight = 340,
  onZoom,
  onResetZoom,
}: CompareTraceProps) {
  const [width, containerRef] = useChartWidth()
  const height = chartHeightFor(width, fullHeight)
  // The moment under the pointer, as an x position in chart units.
  const [hoverX, setHoverX] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const clearHover = useCallback(() => setHoverX(null), [])
  useOutsidePress(svgRef, hoverX !== null, clearHover)

  // Strips thin out as lines are added, so two lines get a readable lane and
  // twenty do not push the chart off the screen.
  const stripHeight = lines.length <= 4 ? 9 : lines.length <= 10 ? 6 : 4
  const laneHeight = lines.length * (stripHeight + STRIP_GAP) - STRIP_GAP

  const plotW = Math.max(120, width - PAD.left - PAD.right)
  const traceH = Math.max(120, height - PAD.top - PAD.bottom - LANE_GAP - laneHeight)
  const traceBottom = PAD.top + traceH
  const lossTop = traceBottom + LANE_GAP
  const lossBottom = lossTop + laneHeight
  const totalHeight = lossBottom + PAD.bottom

  const { plottedLines, yTicks, yMin, yMax } = useMemo(() => {
    const values: number[] = []
    for (const line of lines) {
      for (const point of line.points) {
        const value = medianOf(point)
        if (value !== null && Number.isFinite(value)) values.push(value)
      }
    }

    const { min: lo, max: hi } = latencyDomain(values)

    const xFor = (t: number) => PAD.left + (end === start ? plotW / 2 : ((t - start) / (end - start)) * plotW)
    const yFor = (v: number) => PAD.top + (hi === lo ? traceH / 2 : (1 - (v - lo) / (hi - lo)) * traceH)

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
      return { ...line, plotted, cellWidth: Math.min(14, Math.max(3, spacing * 0.65)) }
    })

    return { plottedLines: result, yTicks: niceTicks(lo, hi), yMin: lo, yMax: hi }
  }, [lines, start, end, plotW, traceH])

  const yPos = (v: number) =>
    PAD.top + (yMax === yMin ? traceH / 2 : (1 - (v - yMin) / (yMax - yMin)) * traceH)

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

  /** A point on the screen as an x position in chart units, or null outside the plot. */
  const plotX = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    const x = ((clientX - rect.left) / rect.width) * width
    return x >= PAD.left && x <= PAD.left + plotW ? x : null
  }

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (brush.move(event)) return
    setHoverX(plotX(event.clientX))
  }

  const handleUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (brush.end(event, true)) {
      setHoverX(null)
      return
    }
    // A finger does not hover, so on a touchscreen the readings are asked for
    // by tapping. They show on release, not on the press: a press is also how
    // a scroll of the page begins.
    if (event.pointerType === 'touch') setHoverX(plotX(event.clientX))
  }

  // Lines probe at their own intervals, so each is read on its own rather
  // than at one shared index.
  const readings = useMemo(() => {
    if (hoverX === null) return null
    return plottedLines.map(line => ({ line, at: readingAt(line, hoverX) }))
  }, [hoverX, plottedLines])

  const spanMs = end - start
  const hoverTime = hoverX === null ? null : start + ((hoverX - PAD.left) / plotW) * spanMs
  const tooltipLeft = hoverX === null ? 0 : holdInside(hoverX, 130, width)
  const dimmed = (key: string) => highlighted !== null && highlighted !== key

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
        onPointerLeave={event => { if (event.pointerType !== 'touch') setHoverX(null) }}
        onDoubleClick={() => { if (zoomed) onResetZoom?.() }}
        role="img"
        aria-label={`Median latency of ${lines.length} series on one chart: ${lines.map(line => line.label).join(', ')}.`}
        className={`overflow-visible select-none touch-pan-y ${brush.enabled ? 'cursor-crosshair' : ''}`}
      >
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
        <TimeGrid start={start} end={end} left={PAD.left} width={plotW} top={PAD.top} bottom={lossBottom} />

        {/* One median line per series. The highlighted one is drawn last, so
            it sits on top of the lines it crosses. */}
        {[...plottedLines]
          .sort((a, b) => Number(a.key === highlighted) - Number(b.key === highlighted))
          .map(line => {
            const { paths, solos } = linePaths(line.plotted)
            return (
              <g
                key={line.key}
                opacity={dimmed(line.key) ? 0.18 : 1}
                className="transition-opacity duration-150"
              >
                {paths.map((d, i) => (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke={line.color}
                    strokeWidth={line.key === highlighted ? 2.5 : 1.75}
                    strokeDasharray={line.dashed ? '5 3' : undefined}
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

        {/* ── Loss strips, one per series ─────────────────────────────────── */}
        <text x={4} y={lossTop - 6} className="fill-muted-foreground/70 font-mono" fontSize={9}>
          loss
        </text>

        {plottedLines.map((line, row) => {
          const y = lossTop + row * (stripHeight + STRIP_GAP)
          return (
            <g key={line.key} opacity={dimmed(line.key) ? 0.25 : 1} className="transition-opacity duration-150">
              {/* Which line this strip belongs to. */}
              <rect x={PAD.left - 12} y={y} width={6} height={stripHeight} rx={1.5} fill={line.color} />
              <rect x={PAD.left} y={y} width={plotW} height={stripHeight} className="fill-muted" opacity={0.3} rx={1} />
              {line.plotted.map((p, i) =>
                p.loss > 0 ? (
                  <rect
                    key={i}
                    x={Math.max(PAD.left, p.x - line.cellWidth / 2)}
                    y={y}
                    width={line.cellWidth}
                    height={stripHeight}
                    fill={getPacketLossVar(p.loss)}
                    // Loss below the noise floor is still marked, but faintly:
                    // it is a reading, not yet a problem.
                    opacity={isMeaningfulLoss(p.loss) ? 1 : 0.45}
                    rx={1}
                  />
                ) : null
              )}
            </g>
          )
        })}

        <TimeAxis start={start} end={end} left={PAD.left} width={plotW} y={totalHeight - 8} />

        {selection && <BrushBox selection={selection} top={PAD.top} bottom={lossBottom} />}

        {hoverX !== null && readings && !selection && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
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
                  cy={at.y}
                  r={3.5}
                  fill={line.color}
                  opacity={dimmed(line.key) ? 0.25 : 1}
                />
              ) : null
            )}
          </g>
        )}
      </svg>

      {selection && <BrushLabel selection={selection} chartWidth={width} spanMs={spanMs} />}

      {hoverTime !== null && readings && !selection && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-max max-w-64 -translate-x-1/2 rounded-md border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm"
          style={{ left: `${(tooltipLeft / width) * 100}%` }}
        >
          <p className="font-mono text-[11px] text-muted-foreground">
            {new Date(hoverTime).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
          <dl className="mt-1.5 space-y-0.5 text-xs">
            {readings.map(({ line, at }) => {
              const value = at ? medianOf(at.point) : null
              return (
                <div key={line.key} className="flex items-baseline gap-2">
                  <span
                    className="h-2 w-2 shrink-0 translate-y-px rounded-full"
                    style={{ backgroundColor: line.color }}
                    aria-hidden="true"
                  />
                  <dt className="min-w-0 flex-1 truncate text-muted-foreground">{line.label}</dt>
                  <dd className="shrink-0 font-mono">
                    {!at ? (
                      <span className="text-muted-foreground/60">—</span>
                    ) : value === null ? (
                      <span style={{ color: getPacketLossVar(100) }}>no reply</span>
                    ) : (
                      <>
                        {value.toFixed(1)} ms
                        {at.loss > 0 && (
                          <span className="ml-1.5" style={{ color: getPacketLossVar(at.loss) }}>
                            {at.loss.toFixed(0)}%
                          </span>
                        )}
                      </>
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        </div>
      )}
    </div>
  )
})
