'use client'

import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

/**
 * What the time charts share: how the axes are labelled, and selecting a
 * period to zoom into by dragging across the plot.
 */

const HOUR_MS = 60 * 60 * 1000

/**
 * Label a point on the time axis at a precision that suits the span on screen.
 * Chosen from the span rather than the selected range, because zooming can put
 * ten minutes on an axis whose range tab still says a week.
 */
export function formatTick(value: number, spanMs: number) {
  const date = new Date(value)
  if (spanMs > 48 * HOUR_MS) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  if (spanMs > 24 * HOUR_MS) {
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: spanMs < 10 * 60 * 1000 ? '2-digit' : undefined,
  })
}

/** One end of a zoomed period, with the date: a zoom is often into yesterday. */
export function formatWindowEdge(time: number) {
  return new Date(time).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
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
  const centre = Math.min(Math.max(selection.left + selection.width / 2, 110), chartWidth - 110)

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
