'use client'

import { useMemo } from 'react'
import { getPacketLossVar, isMeaningfulLoss, NO_DATA_COLOR } from '@/lib/charts/packet-loss-colors'
import type { SparklinePoint } from '@/types/probe'
import { cn } from '@/lib/utils'

/**
 * A target's recent history, small enough to sit in a list row.
 *
 * The sidebar used to be a list of names with a single status dot each, which
 * told you the state of the last probe and nothing about how it got there. A
 * path that has been flapping all afternoon looked identical to one that has
 * been solid for a week. These traces make the whole network scannable in one
 * pass, which is the sidebar's actual job.
 *
 * Deliberately unlabelled: at this size the shape is the information, and axes
 * would cost more room than they earn.
 */

interface SparklineProps {
  points: SparklinePoint[]
  width?: number
  height?: number
  /** Dims the trace for a paused target without changing its shape. */
  muted?: boolean
  /**
   * Fill the width of whatever it is placed in, instead of being `width`
   * pixels wide. `width` then only sets how finely the trace is drawn.
   */
  stretch?: boolean
}

export function Sparkline({ points, width = 64, height = 18, muted = false, stretch = false }: SparklineProps) {
  const geometry = useMemo(() => {
    const usable = points.filter(p => Number.isFinite(p.timestamp))
    if (usable.length < 2) return null

    const latencies = usable.map(p => p.latency).filter((v): v is number => v !== null)
    if (latencies.length === 0) return null

    const min = Math.min(...latencies)
    const max = Math.max(...latencies)
    // A flat trace should sit mid-height rather than collapse onto the floor.
    const span = max - min || Math.max(max, 1)

    const stepX = width / (usable.length - 1)
    const yFor = (v: number) => height - 1 - ((v - min) / span) * (height - 2)

    // Split into runs so a failed probe leaves a break rather than a line
    // dropping to zero and back, which would read as a latency spike.
    const runs: string[] = []
    let current: string[] = []

    usable.forEach((point, i) => {
      if (point.latency === null) {
        if (current.length > 1) runs.push(current.join(' L '))
        current = []
        return
      }
      current.push(`${(i * stepX).toFixed(1)},${yFor(point.latency).toFixed(1)}`)
    })
    if (current.length > 1) runs.push(current.join(' L '))

    const worstLoss = Math.max(...usable.map(p => p.packetLoss))

    // Readings in a row that failed the same way are marked as one band. As a
    // stripe each, a long failure on a wide trace is a comb that hides the
    // line it is drawn behind.
    const failures: { from: number; to: number; color: string }[] = []
    usable.forEach((point, i) => {
      // Only loss worth seeing, so one stray packet does not stripe the trace.
      if (point.latency !== null && !isMeaningfulLoss(point.packetLoss)) return

      const color = getPacketLossVar(point.latency === null ? 100 : point.packetLoss)
      const last = failures[failures.length - 1]
      if (last && last.to === i - 1 && last.color === color) last.to = i
      else failures.push({ from: i, to: i, color })
    })

    return {
      paths: runs.map(r => `M ${r}`),
      color: usable.every(p => p.latency === null) ? NO_DATA_COLOR : getPacketLossVar(worstLoss),
      failures: failures.map(({ from, to, color }) => ({
        x: Math.max(0, from * stepX - 1),
        width: (to - from) * stepX + 2,
        color,
      })),
    }
  }, [points, width, height])

  if (!geometry) {
    return (
      <span
        className={stretch ? 'block rounded-sm bg-muted/40' : 'inline-block shrink-0 rounded-sm bg-muted/40'}
        style={{ width: stretch ? '100%' : width, height }}
        aria-hidden="true"
      />
    )
  }

  return (
    <svg
      width={stretch ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={stretch ? 'none' : undefined}
      className={cn('shrink-0', stretch && 'block', muted && 'opacity-40')}
      aria-hidden="true"
      focusable="false"
    >
      {/* Loss markers sit behind the trace so they never obscure its shape. */}
      {geometry.failures.map((f, i) => (
        <rect
          key={i}
          x={f.x}
          y={0}
          width={f.width}
          height={height}
          fill={f.color}
          opacity={0.35}
          rx={1}
        />
      ))}

      {geometry.paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={geometry.color}
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          // Stretched, the drawing is scaled sideways; the line must not be.
          vectorEffect={stretch ? 'non-scaling-stroke' : undefined}
        />
      ))}
    </svg>
  )
}
