'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { timeTicks } from '@/lib/charts/time-ticks'
import { inDisplayZone } from '@/lib/time-zone'

/**
 * What the time charts share: how wide they are drawn, how the axes are
 * labelled, and selecting a period to zoom into by dragging across the plot.
 */

const HOUR_MS = 60 * 60 * 1000

/**
 * The width of whatever a chart is placed in, and the ref that measures it.
 *
 * A chart is drawn in its own pixels, so it has to know how many it has. The
 * first measurement is taken as the chart is attached, which React applies
 * before the browser paints. Waiting for the resize observer's first report
 * instead let one frame through at a guessed width: the chart appeared narrow
 * and centred, then snapped out to the full width of the card.
 */
export function useChartWidth(fallback = 880) {
  const [width, setWidth] = useState(fallback)

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return

    const measured = node.getBoundingClientRect().width
    if (measured > 0) setWidth(measured)

    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width
      if (next && next > 0) setWidth(next)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [width, containerRef] as const
}

/** Narrower than this, a chart is on a phone held upright. */
const NARROW_CHART_PX = 480

/**
 * How tall to draw a chart that is `width` wide. At its full height on a phone
 * a chart is taller than it is wide and fills the screen by itself, with the
 * readings it belongs to scrolled out of sight above it.
 */
export function chartHeightFor(width: number, full: number) {
  return width < NARROW_CHART_PX ? Math.min(full, 280) : full
}

/**
 * Where to centre a label `halfWidth` wide either side so that it stays inside
 * a chart `chartWidth` wide. On a chart too narrow to hold it at all, the
 * middle: it overhangs both edges equally instead of one of them entirely.
 */
export function holdInside(centre: number, halfWidth: number, chartWidth: number) {
  if (chartWidth <= halfWidth * 2) return chartWidth / 2
  return Math.min(Math.max(centre, halfWidth), chartWidth - halfWidth)
}

/** The space between the crosshair and the readings beside it. */
const READINGS_GAP_PX = 16

/**
 * Where the box of readings under the pointer goes. Beside the crosshair, on
 * whichever side has more room, and at the top or the bottom of the plot,
 * whichever covers fewer of the points being read: laid across the top it
 * covered the lines that run high, which are the very ones being pointed at.
 * On a phone there is no room beside it, so it is centred on the crosshair
 * and only moves up or down.
 *
 * `pointsY` are the hovered points' heights, `top`/`bottom` the plot's
 * edges and `boxHeight` about how tall the box is, all in the chart's pixels.
 */
export function readingsBoxStyle(
  x: number,
  pointsY: Array<number | null | undefined>,
  chart: { width: number; height: number; top: number; bottom: number; halfWidth: number; boxHeight: number }
): CSSProperties {
  const heights = pointsY.filter((y): y is number => typeof y === 'number' && Number.isFinite(y))
  const margin = 8
  // How many points each place would cover, then how close it comes to the nearest.
  const cost = (from: number, to: number) => {
    const covered = heights.filter(y => y >= from - margin && y <= to + margin).length
    const nearest = Math.min(Infinity, ...heights.map(y => (y < from ? from - y : y > to ? y - to : 0)))
    return covered * 10_000 - Math.min(nearest, 9_999)
  }
  const atTop = cost(chart.top, chart.top + chart.boxHeight)
  const atBottom = cost(chart.bottom - chart.boxHeight, chart.bottom)
  const vertical = atBottom < atTop ? { bottom: chart.height - chart.bottom } : { top: chart.top }

  if (chart.width < NARROW_CHART_PX) {
    return { ...vertical, left: `${(holdInside(x, chart.halfWidth, chart.width) / chart.width) * 100}%`, transform: 'translateX(-50%)' }
  }
  const toRight = x < chart.width / 2
  return {
    ...vertical,
    left: `${(x / chart.width) * 100}%`,
    transform: toRight ? `translateX(${READINGS_GAP_PX}px)` : `translateX(calc(-100% - ${READINGS_GAP_PX}px))`,
  }
}

/**
 * Call `onPress` when something outside `ref` is pressed.
 *
 * A reading brought up by tapping a chart has no pointer to move away and
 * close it, the way a mouse does, so it stays until something else is pressed.
 * `onPress` should be stable (a `useCallback`), or this re-subscribes on every
 * render.
 */
export function useOutsidePress(ref: RefObject<Element | null>, active: boolean, onPress: () => void) {
  useEffect(() => {
    if (!active) return

    const handle = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onPress()
    }
    document.addEventListener('pointerdown', handle)
    return () => document.removeEventListener('pointerdown', handle)
  }, [ref, active, onPress])
}

/**
 * Label a point on the time axis at a precision that suits the span on screen.
 * Chosen from the span rather than the selected range, because zooming can put
 * ten minutes on an axis whose range tab still says a week.
 */
export function formatTick(value: number, spanMs: number) {
  const date = new Date(value)
  if (spanMs > 48 * HOUR_MS) {
    return date.toLocaleDateString('en-US', inDisplayZone({ month: 'short', day: 'numeric' }))
  }
  if (spanMs > 24 * HOUR_MS) {
    return date.toLocaleString('en-US', inDisplayZone({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  }
  return date.toLocaleTimeString('en-US', inDisplayZone({
    hour: '2-digit',
    minute: '2-digit',
    second: spanMs < 10 * 60 * 1000 ? '2-digit' : undefined,
  }))
}

/** The width of one character of an axis label, which is set in 10px mono. */
const AXIS_CHARACTER_PX = 6

interface TimeSpan {
  /** The period drawn across the plot, in epoch milliseconds. */
  start: number
  end: number
  /** Where the plot starts and how wide it is, in chart units. */
  left: number
  width: number
}

/** The marks along a chart's time axis, each with where it falls across the plot. */
function ticksAcross({ start, end, left, width }: TimeSpan) {
  // A single reading is a period with no length, drawn in the middle of the
  // plot. It has no round times in it, but it does have a time.
  if (end === start) return [{ time: start, label: formatTick(start, 0), x: left + width / 2 }]

  return timeTicks(start, end, width).map(tick => ({
    ...tick,
    x: left + ((tick.time - start) / (end - start)) * width,
  }))
}

/**
 * A line down the plot at each mark on the time axis, as on a Smokeping graph:
 * when something happened is read by counting along from a round time, not by
 * guessing at a fraction of the width. Drawn before the readings, so that it
 * sits behind them.
 */
export function TimeGrid({ top, bottom, start, end, left, width }: TimeSpan & { top: number; bottom: number }) {
  // Worked out once for a period and a width, not on every render: the chart
  // renders again on every move of the pointer.
  const ticks = useMemo(() => ticksAcross({ start, end, left, width }), [start, end, left, width])
  return (
    <g className="text-border" pointerEvents="none">
      {ticks.map(tick => (
        <line
          key={tick.time}
          x1={tick.x}
          x2={tick.x}
          y1={top}
          y2={bottom}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 4"
        />
      ))}
    </g>
  )
}

/**
 * The labels under a chart: one at each round time across its period, as many
 * as there is room for. See `timeTicks` for how they are chosen.
 */
export function TimeAxis({ y, ...span }: TimeSpan & { y: number }) {
  const { start, end, left, width } = span
  const ticks = useMemo(() => ticksAcross({ start, end, left, width }), [start, end, left, width])
  return (
    <>
      {ticks.map(tick => {
        // A mark at either end of the plot would centre its label half off the
        // chart. It is held just inside instead, which the margins have room for.
        const half = (tick.label.length * AXIS_CHARACTER_PX) / 2
        const x = Math.min(Math.max(tick.x, span.left - 30 + half), span.left + span.width + 12 - half)
        return (
          <text
            key={tick.time}
            x={x}
            y={y}
            textAnchor="middle"
            className="fill-muted-foreground font-mono"
            fontSize={10}
          >
            {tick.label}
          </text>
        )
      })}
    </>
  )
}

/** One end of a zoomed period, with the date: a zoom is often into yesterday. */
export function formatWindowEdge(time: number) {
  return new Date(time).toLocaleString('en-US', inDisplayZone({
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }))
}

export function formatDuration(ms: number) {
  const minutes = ms / 60_000
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (minutes < 90) return `${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 36) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`
  return `${(hours / 24).toFixed(1)} d`
}

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? mag * 10

  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

/**
 * A latency axis for a set of readings. Padding is proportional to the
 * observed range: a fixed floor swamped it on LAN paths, where a 2-6ms trace
 * was padded to a 0-8ms domain and used under half the panel.
 */
export function latencyDomain(values: number[]): { min: number; max: number } {
  const dataMin = values.length ? Math.min(...values) : 0
  const dataMax = values.length ? Math.max(...values) : 100

  const span = dataMax - dataMin
  const pad = Math.max(span * 0.18, span === 0 ? Math.max(dataMax * 0.1, 0.5) : 0.2)

  return { min: Math.max(0, dataMin - pad), max: dataMax + pad }
}

/** A drag shorter than this is a click that wobbled, not a selection. */
const MIN_BRUSH_PX = 6

interface ChartBrushOptions {
  svgRef: RefObject<SVGSVGElement | null>
  /** Width of the chart in its own units, which is what x positions are in. */
  width: number
  plotLeft: number
  plotWidth: number
  /** The period drawn across the plot, in epoch milliseconds. */
  xMin: number
  xMax: number
  /** Called with the period selected by dragging. Without it nothing can be selected. */
  onZoom?: (start: number, end: number) => void
}

/**
 * Selecting a period by dragging across a chart.
 *
 * The chart keeps its own pointer handlers and passes the events through:
 * `move` reports whether a selection is being dragged, so the chart knows not
 * to treat the same movement as hovering.
 */
export function useChartBrush({ svgRef, width, plotLeft, plotWidth, xMin, xMax, onZoom }: ChartBrushOptions) {
  // The selection being dragged out, as two x positions in chart units.
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null)
  const originRef = useRef<{ pointerId: number; x: number } | null>(null)

  const enabled = !!onZoom && xMax > xMin

  /** Pointer position in chart units, held inside the plot area. */
  const plotX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    const x = ((clientX - rect.left) / rect.width) * width
    return Math.min(plotLeft + plotWidth, Math.max(plotLeft, x))
  }

  const timeAt = (x: number) => xMin + ((x - plotLeft) / plotWidth) * (xMax - xMin)

  const start = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!enabled || event.button !== 0) return
    const x = plotX(event.clientX)
    if (x === null) return

    originRef.current = { pointerId: event.pointerId, x }
    // Capture, so a drag that runs past the edge of the chart keeps selecting
    // (pinned to that edge) instead of being dropped.
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  /** Returns true while this pointer is dragging out a selection. */
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const origin = originRef.current
    if (!origin || origin.pointerId !== event.pointerId) return false

    const to = plotX(event.clientX)
    if (to !== null && (brush || Math.abs(to - origin.x) >= 3)) {
      setBrush({ from: origin.x, to })
    }
    return true
  }

  /** Returns true if the drag ended in a zoom. */
  const end = (event: ReactPointerEvent<SVGSVGElement>, commit: boolean) => {
    const origin = originRef.current
    if (!origin || origin.pointerId !== event.pointerId) return false

    originRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    // Measured from where the pointer was released, not from the box last
    // drawn: a release can arrive before the final move has been rendered,
    // and the selection would then stop short of where the drag ended.
    const to = plotX(event.clientX) ?? brush?.to ?? origin.x
    const zoomed = commit && Math.abs(to - origin.x) >= MIN_BRUSH_PX
    if (zoomed) {
      onZoom?.(timeAt(Math.min(origin.x, to)), timeAt(Math.max(origin.x, to)))
    }
    setBrush(null)
    return zoomed
  }

  const left = brush ? Math.min(brush.from, brush.to) : 0
  const span = brush ? Math.abs(brush.to - brush.from) : 0

  return {
    enabled,
    /** The selection in progress, or null: its extent in chart units and in time. */
    selection: brush
      ? { left, width: span, startTime: timeAt(left), endTime: timeAt(left + span) }
      : null,
    start,
    move,
    end,
  }
}

type BrushSelection = NonNullable<ReturnType<typeof useChartBrush>['selection']>

/** The box drawn over the plot while a period is being selected. */
export function BrushBox({ selection, top, bottom }: { selection: BrushSelection; top: number; bottom: number }) {
  return (
    <g pointerEvents="none">
      <rect x={selection.left} y={top} width={selection.width} height={bottom - top} className="fill-primary/15" />
      {[selection.left, selection.left + selection.width].map((x, i) => (
        <line key={i} x1={x} x2={x} y1={top} y2={bottom} stroke="currentColor" className="text-primary" strokeWidth={1} />
      ))}
    </g>
  )
}

/** The period being selected, and how long it is, floating above the box. */
export function BrushLabel({
  selection,
  chartWidth,
  spanMs,
}: {
  selection: BrushSelection
  chartWidth: number
  /** The span of the whole axis, which sets how precisely the ends are written. */
  spanMs: number
}) {
  const centre = holdInside(selection.left + selection.width / 2, 110, chartWidth)

  return (
    <div
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover/95 px-3 py-1.5 font-mono text-[11px] shadow-lg backdrop-blur-sm"
      style={{ left: `${(centre / chartWidth) * 100}%` }}
    >
      {formatTick(selection.startTime, spanMs)} – {formatTick(selection.endTime, spanMs)}
      <span className="ml-2 text-muted-foreground">{formatDuration(selection.endTime - selection.startTime)}</span>
    </div>
  )
}
