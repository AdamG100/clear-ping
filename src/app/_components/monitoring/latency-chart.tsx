 'use client'

import { useMemo, memo } from 'react'
import { Bar, BarChart, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChartContainer,
} from '@/components/ui/chart'
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
  
  if (diffHours < 1) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  } else if (diffHours < 24) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
}

const AnimatedTooltip = ({ active, payload }: { active?: boolean; payload?: unknown[] }) => {
  if (!active || !payload || !payload.length) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (payload[0] as any).payload
  // Build friendly labels: avoid appending 'ms' to 'Offline' / 'No Data'
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
      transition={{ duration: 0.2, ease: "easeOut" }}
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
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: data.color }}
          />
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

export const LatencyChart = memo(function LatencyChart({ data, isPolling = false }: LatencyChartProps) {
  const chartData = useMemo(() => {
    // Show all measurement data points, including offline ones.
    // Use last-known latency for offline points so the red bar reflects prior RTT.
    const maxLatency = Math.max(...data.map(p => (p.latency || 0)), 100)
    const sorted = [...data].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    let lastKnownLatency: number | null = null

    return sorted.map((point) => {
      const packetLoss = point.isOnline === false ? 100 : (point.packetLoss || 0)
      // Force red color for full loss or explicit offline, otherwise map via packet-loss utility
      const color = (point.isOnline === false || packetLoss >= 99)
        ? '#ef4444' // Red for offline / total loss
        : point.isOnline === null
        ? '#9ca3af' // Gray for missing data
        : getPacketLossColor(packetLoss)

      // For stacked chart, provide latency baseline and jitter stacked on top
      // Rules:
      // - If sample is explicitly missing (`isOnline === null`) -> No Data (latency = null)
      // - If packetLoss >= 100 or explicit offline -> No Data (latency = null)
      // - Otherwise use real latency and update lastKnownLatency
      let latency: number | null
      if (point.isOnline === null) {
        latency = null
      } else if (point.packetLoss !== undefined && point.packetLoss >= 100) {
        // Treat full loss as No Data (blank gap)
        latency = null
      } else if (point.latency !== null && point.latency !== undefined) {
        latency = point.latency
        lastKnownLatency = point.latency
      } else if (point.isOnline === false) {
        // If offline but we have a last-known latency, use it for visuals of partial loss;
        // otherwise treat as No Data
        latency = lastKnownLatency ?? null
      } else {
        latency = null
      }

      const jitter = point.isOnline === false ? 0 : (point.jitter && point.jitter > 0 ? point.jitter : 0)

      // lossMarker is a small visual indicator for partial packet loss (0<loss<100)
      const lossMarker = packetLoss > 0 && packetLoss < 100 ? maxLatency * (packetLoss / 100) : null

      return {
        time: point.timestamp.getTime(),
        latency: latency,
        jitter: jitter,
        packetLoss: packetLoss,
        isOnline: point.isOnline,
        color,
        lossMarker,
        originalLatency: point.latency, // Keep original for tooltip
        originalJitter: point.jitter, // Keep original for tooltip
      }
    })
  }, [data])

  return (
    <Card className={`border rounded-lg ${isPolling ? 'animate-pulse border-orange-500/50 shadow-lg shadow-orange-500/20' : ''}`}>
      <CardHeader className="border-b pb-4">
        <div className="space-y-3">
          <CardTitle>Latency</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="px-2 pt-0 sm:px-6">
        <motion.div
          initial={{ opacity: 0.5 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <ChartContainer
            config={{
              latency: {
                label: 'Latency',
                color: 'hsl(var(--chart-1))',
              },
              jitter: {
                label: 'Jitter',
                color: '#374151', // Dark gray smoky color
              },
            }}
            className="aspect-auto h-100 w-full"
          >
            <BarChart 
              data={chartData}
              margin={{ top: 20, right: 30, left: 60, bottom: 20 }}
            >
              <CartesianGrid vertical={false} />
              <Tooltip
                cursor={false}
                content={<AnimatedTooltip />}
              />
              <Bar
                dataKey="latency"
                stackId="1"
                animationDuration={500}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Bar>
              <Bar
                dataKey="lossMarker"
                stackId="1"
                barSize={6}
                animationDuration={200}
              >
                {chartData.map((entry, index) => (
                  <Cell
                    key={`loss-${index}`}
                    fill={entry.lossMarker ? entry.color : 'transparent'}
                  />
                ))}
              </Bar>
              <Bar
                dataKey="jitter"
                stackId="1"
                fill="#374151"
                animationDuration={500}
              />
              <XAxis
                dataKey="time"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={50}
                tickFormatter={formatXAxis}
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => `${value}ms`}
              />
            </BarChart>
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
