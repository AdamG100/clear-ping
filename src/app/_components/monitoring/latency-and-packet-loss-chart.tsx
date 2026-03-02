'use client'

import { useMemo, memo } from 'react'
import type { ReactElement } from 'react'
import { Line, Area, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Scatter, Customized } from 'recharts'
import { motion, AnimatePresence } from 'framer-motion'
import { ChartContainer } from '@/components/ui/chart'
import { getPacketLossColor } from '@/lib/packet-loss-colors'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface LatencyChartProps {
  data: Array<{
    timestamp: Date
    latency: number | null
    packetLoss: number | null
    jitter: number | null
    isOnline: boolean | null
  }>
  isPolling?: boolean
}

const formatXAxis = (tickValue: string | number) => {
  const numValue = typeof tickValue === 'string' ? parseInt(tickValue) : tickValue
  if (isNaN(numValue)) return ''

  const date = new Date(numValue)
  if (isNaN(date.getTime())) return ''

  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)

  if (diffHours < 24) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type ChartPoint = {
  time: number
  originalLatency?: number | null
  originalJitter?: number | null
  packetLoss?: number | null
  isOnline?: boolean | null
  color?: string
}

interface ChartDataRow extends ChartPoint {
  latency?: number | null
  jitter?: number | null
  latency_lower?: number | null
  jitter_range?: number | null
  packetLoss: number
  isOnline: boolean | null
  color: string
  lossMarker?: number | null
  bucket_excellent?: number | null
  bucket_good?: number | null
  bucket_fair?: number | null
  bucket_poor?: number | null
  bucket_veryPoor?: number | null
  bucket_critical?: number | null
  // legacy per-loss buckets used by multi-line rendering
  bucket_loss_perfect?: number | null
  bucket_loss_minor?: number | null
  bucket_loss_moderate?: number | null
  bucket_loss_critical?: number | null
  originalLatency?: number | null
  originalJitter?: number | null
  time: number
}

const AnimatedTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) => {
  if (!active || !payload || !payload.length) return null
  const data = payload[0].payload

  let latencyLabel: string
  if (data.isOnline === false) latencyLabel = 'Offline'
  else if (data.isOnline === null) latencyLabel = 'No Data'
  else latencyLabel = data.originalLatency !== null && data.originalLatency !== undefined ? `${Number(data.originalLatency).toFixed(1)}ms` : 'No Data'

  const packetLoss = Number(data.packetLoss || 0).toFixed(2)
  const hasJitter = data.isOnline === true && data.originalJitter !== null && data.originalJitter !== undefined
  const jitter = hasJitter ? `${Number(data.originalJitter).toFixed(1)}ms` : null

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="bg-background border border-border rounded-lg shadow-lg p-3"
    >
      <div className="text-sm text-muted-foreground mb-2">
        {new Date(data.time).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: data.color }} />
          <AnimatePresence mode="wait">
            <motion.span
              key={latencyLabel}
              className="font-medium"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
            >
              Latency: {latencyLabel}
            </motion.span>
          </AnimatePresence>
        </div>

        {hasJitter && (
          <AnimatePresence mode="wait">
            <motion.div
              key={jitter}
              className="text-xs text-muted-foreground"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2, delay: 0.05 }}
            >
              Jitter: {jitter}
            </motion.div>
          </AnimatePresence>
        )}

        <AnimatePresence mode="wait">
          <motion.div
            key={packetLoss}
            className="text-xs text-muted-foreground"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.2, delay: 0.1 }}
          >
            Packet Loss: {packetLoss}%
          </motion.div>
        </AnimatePresence>

        <div className="text-xs text-muted-foreground">
          Status: {data.isOnline === true ? 'Online' : data.isOnline === false ? 'Offline' : 'No Data'}
        </div>
      </div>
    </motion.div>
  )
}

export const LatencyChart = memo(function LatencyChart({ data }: LatencyChartProps) {
  const chartData = useMemo(() => {
    // Use last-known latency for offline points; treat full loss as No Data (gap)
    const maxLatency = Math.max(...data.map(p => (p.latency || 0)), 100)
    const sorted = [...data].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

    const reduced = sorted.reduce(
      (acc, point) => {
        const packetLoss = point.isOnline === false ? 100 : (point.packetLoss ?? 0)
        const color = (point.isOnline === false || packetLoss >= 99)
          ? '#ef4444'
          : point.isOnline === null
          ? '#9ca3af'
          : getPacketLossColor(packetLoss)

        let latency: number | null
        if (point.isOnline === null) {
          latency = null
        } else if (point.packetLoss !== null && point.packetLoss !== undefined && point.packetLoss >= 100) {
          // Full loss -> no latency value (gap)
          latency = null
        } else if (point.latency !== null && point.latency !== undefined) {
          // Measured latency
          latency = point.latency
          acc.lastKnownLatency = point.latency
        } else if (packetLoss > 0) {
          // Partial loss but no explicit latency: fall back to last-known latency so the
          // line remains visible and the loss marker can be positioned relative to it.
          latency = acc.lastKnownLatency ?? null
        } else if (point.isOnline === false) {
          // Offline points use last-known latency for context
          latency = acc.lastKnownLatency ?? null
        } else {
          latency = null
        }

        const jitter = point.isOnline === true && point.jitter && point.jitter > 0 ? point.jitter : null
        const lossMarker = packetLoss > 0 && packetLoss < 100
          ? (latency !== null ? latency * (packetLoss / 100) : maxLatency * (packetLoss / 100))
          : null

        // Compute jitter band as a baseline (latency_lower) and range (jitter_range) so we can
        // render a shaded area between latency_lower and latency_lower + jitter_range using stacked Areas.
        let latency_lower: number | null = null
        let jitter_range: number | null = null
        if (latency !== null && jitter !== null) {
          latency_lower = Math.max(0, latency - jitter)
          // upper = latency + jitter
          const upper = latency + jitter
          jitter_range = Math.max(0, upper - latency_lower)
        }

        // Place the latency value into a packet-loss bucket so the line color follows
        // packet-loss severity rather than latency magnitude. This ensures 0% loss shows
        // as green even if latency is high.
        const bucket_loss_perfect = latency !== null && packetLoss === 0 ? latency : null
        const bucket_loss_minor = latency !== null && packetLoss > 0 && packetLoss <= 10 ? latency : null
        const bucket_loss_moderate = latency !== null && packetLoss > 10 && packetLoss <= 50 ? latency : null
        const bucket_loss_critical = latency !== null && packetLoss > 50 ? latency : null

          acc.result.push({
          time: point.timestamp.getTime(),
          latency: latency,
          jitter: jitter,
          latency_lower,
          jitter_range,
          packetLoss: packetLoss,
          isOnline: point.isOnline,
          color,
          lossMarker,
          bucket_loss_perfect,
          bucket_loss_minor,
          bucket_loss_moderate,
          bucket_loss_critical,
          originalLatency: point.latency,
          originalJitter: point.jitter,
        })

        return acc
      },
      { lastKnownLatency: null as number | null, result: [] as ChartDataRow[] }
    )

    return reduced.result
  }, [data])

  // Y-axis domain with breathing room so low-latency lines don't sit on the axis
  const yDomain = useMemo((): [number, number] => {
    const vals = chartData
      .flatMap(d => [d.latency, d.originalLatency])
      .filter((v): v is number => v != null && v > 0)
    if (!vals.length) return [0, 100]
    const dataMin = Math.min(...vals)
    const dataMax = Math.max(...vals)
    const pad = Math.max(dataMax * 0.2, 8)
    return [Math.max(0, Math.floor(dataMin - pad)), Math.ceil(dataMax + pad * 0.5)]
  }, [chartData])

  // Typed shape renderer for loss markers to avoid `any` and JSX casting issues
  const LossMarkerShape = (props: unknown): ReactElement => {
    const p = props as { cx?: number; cy?: number; payload?: { lossMarker?: number | null; color?: string } }
    const { cx = 0, cy = 0, payload } = p || {}
    if (!payload || payload.lossMarker == null) return <g />
    const color = payload.color || '#ef4444'
    return <rect x={cx - 3} y={cy - 3} width={6} height={6} fill={color} rx={1} />
  }

  return (
    <Card className="border rounded-lg">
      <CardHeader className="border-b pb-4">
        <div className="space-y-3">
          <CardTitle>Latency & Packet Loss</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="px-2 pt-0 sm:px-6">
        <motion.div
          initial={{ opacity: 0.5 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <ChartContainer
            config={{
              latency: { label: 'Latency & Packet Loss', color: 'hsl(var(--chart-1))' },
              jitter: { label: 'Jitter', color: '#374151' },
            }}
            className="aspect-auto h-100 w-full"
          >
            <ComposedChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 60, bottom: 20 }}
            >
              <CartesianGrid vertical={false} />
              <Tooltip cursor={false} content={<AnimatedTooltip />} />

              {/* Jitter band (shaded gray area) */}
              <Area type="monotone" dataKey="latency_lower" stroke="none" fillOpacity={0} stackId="jitter" isAnimationActive={false} />
              <Area type="monotone" dataKey="jitter_range" stroke="none" fill="#374151" fillOpacity={0.18} stackId="jitter" isAnimationActive={false} />

              {/* Base latency line (faint) so single-point buckets still sit on a visible line */}
              <Line type="monotone" dataKey="latency" stroke="rgba(156,163,175,0.6)" dot={false} strokeWidth={1} connectNulls={false} isAnimationActive={false} />

              {/* Multi-colored single-path line split by packet-loss severity */}
              <Customized
                component={(chartProps: Record<string, unknown>) => {
                  try {
                    const width = (chartProps.width as number) || 0
                    const height = (chartProps.height as number) || 0
                    const marginLeft = 60
                    const marginRight = 30
                    const marginTop = 20
                    const marginBottom = 20
                    const innerWidth = Math.max(0, width - marginLeft - marginRight)
                    const innerHeight = Math.max(0, height - marginTop - marginBottom)

                    const data = chartData || []
                    if (!data.length) return <g />

                    const xMin = Math.min(...data.map(d => d.time))
                    const xMax = Math.max(...data.map(d => d.time))
                    const [yMin, yMax] = yDomain

                    const xFor = (t: number) => {
                      if (xMax === xMin) return marginLeft + innerWidth / 2
                      return marginLeft + ((t - xMin) / (xMax - xMin)) * innerWidth
                    }
                    const yFor = (v: number) => {
                      if (yMax === yMin) return marginTop + innerHeight / 2
                      return marginTop + (1 - (v - yMin) / (yMax - yMin)) * innerHeight
                    }

                    let lastKnownLocal: number | null = null
                    const dataMaxLatency = yMax
                    const pts: { x: number; y: number; color: string }[] = []

                    for (const d of data) {
                      const explicit = d.latency ?? d.originalLatency ?? null
                      const loss = d.packetLoss ?? 0

                      let latencyVal: number | null = null
                      if (explicit !== null && explicit !== undefined) {
                        latencyVal = explicit as number
                        lastKnownLocal = latencyVal
                      } else if (loss > 0 && lastKnownLocal !== null) {
                        latencyVal = lastKnownLocal
                      } else if (loss > 0) {
                        latencyVal = dataMaxLatency * 0.5
                      }

                      if (latencyVal == null) continue

                      const color =
                        d.isOnline === false || loss >= 99
                          ? '#ef4444'
                          : d.isOnline === null
                            ? '#9ca3af'
                            : getPacketLossColor(loss)

                      pts.push({ x: xFor(d.time), y: yFor(latencyVal), color })
                    }

                    if (!pts.length) return <g />

                    // Single-point: render a short horizontal tick
                    if (pts.length === 1) {
                      const p = pts[0]
                      return (
                        <g>
                          <line x1={p.x - 6} x2={p.x + 6} y1={p.y} y2={p.y} stroke={p.color} strokeWidth={2} strokeLinecap="round" />
                        </g>
                      )
                    }

                    // Build individual colored segments between consecutive points.
                    // Each segment inherits the color of the destination point so the
                    // color transition happens exactly where packet-loss changes.
                    const segments: React.ReactElement[] = []
                    for (let i = 1; i < pts.length; i++) {
                      const prev = pts[i - 1]
                      const cur = pts[i]

                      if (prev.color === cur.color) {
                        // Same color: single segment
                        segments.push(
                          <line
                            key={i}
                            x1={prev.x}
                            y1={prev.y}
                            x2={cur.x}
                            y2={cur.y}
                            stroke={cur.color}
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        )
                      } else {
                        // Color change: split segment at midpoint for a sharp transition
                        const mx = (prev.x + cur.x) / 2
                        const my = (prev.y + cur.y) / 2
                        segments.push(
                          <line
                            key={`${i}a`}
                            x1={prev.x}
                            y1={prev.y}
                            x2={mx}
                            y2={my}
                            stroke={prev.color}
                            strokeWidth={2}
                            strokeLinecap="round"
                          />
                        )
                        segments.push(
                          <line
                            key={`${i}b`}
                            x1={mx}
                            y1={my}
                            x2={cur.x}
                            y2={cur.y}
                            stroke={cur.color}
                            strokeWidth={2}
                            strokeLinecap="round"
                          />
                        )
                      }
                    }

                    return <g>{segments}</g>
                  } catch {
                    return <g />
                  }
                }}
              />

              {/* Small dots to indicate partial packet loss (0<loss<100) */}
              <Scatter
                data={chartData}
                dataKey="lossMarker"
                shape={LossMarkerShape}
              />

              <XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={8} minTickGap={50} tickFormatter={formatXAxis} type="number" scale="time" domain={["dataMin", "dataMax"]} />
              <YAxis tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value) => `${value}ms`} domain={yDomain} />
            </ComposedChart>
          </ChartContainer>
        </motion.div>

        <div className="flex items-center justify-center gap-6 mt-4 text-xs pb-2">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#22c55e' }} />
            <span className="text-muted-foreground">Perfect (0%)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#06b6d4' }} />
            <span className="text-muted-foreground">Minor (≤10%)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#d946ef' }} />
            <span className="text-muted-foreground">Moderate (≤50%)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#dc2626' }} />
            <span className="text-muted-foreground">High ({'>'}50%)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#9ca3af' }} />
            <span className="text-muted-foreground">No Data</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
})
