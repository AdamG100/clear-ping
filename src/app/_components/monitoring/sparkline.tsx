'use client'

import { useMemo } from 'react'
import { getPacketLossVar, isMeaningfulLoss, NO_DATA_COLOR } from '@/lib/packet-loss-colors'
import type { SparklinePoint } from '@/types/probe'

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
}

export function Sparkline({ points, width = 64, height = 18, muted = false }: SparklineProps) {
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
    const failures = usable
      .map((p, i) => ({ p, i }))
      // Only loss worth seeing, so one stray packet does not stripe the trace.
      .filter(({ p }) => p.latency === null || isMeaningfulLoss(p.packetLoss))

    return {
      paths: runs.map(r => `M ${r}`),
      color: usable.every(p => p.latency === null) ? NO_DATA_COLOR : getPacketLossVar(worstLoss),
      failures: failures.map(({ p, i }) => ({
        x: i * stepX,
        color: getPacketLossVar(p.latency === null ? 100 : p.packetLoss),
      })),
    }
  }, [points, width, height])

  if (!geometry) {
    return (
      <span
        className="inline-block shrink-0 rounded-sm bg-muted/40"
        style={{ width, height }}
        aria-hidden="true"
      />
    )
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={muted ? 'shrink-0 opacity-40' : 'shrink-0'}
      aria-hidden="true"
      focusable="false"
    >
      {/* Loss markers sit behind the trace so they never obscure its shape. */}
      {geometry.failures.map((f, i) => (
        <rect
          key={i}
          x={Math.max(0, f.x - 1)}
          y={0}
          width={2}
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
        />
      ))}
    </svg>
  )
}
