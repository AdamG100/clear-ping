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
  const latency = data.isOnline === false ? 'Offline' : data.isOnline === null ? 'No Data' : Number(data.originalLatency).toFixed(1)
  const packetLoss = Number(data.packetLoss || 0).toFixed(2)
  const hasJitter = data.isOnline === true && data.originalJitter !== null && data.originalJitter !== undefined
  const jitter = hasJitter ? Number(data.originalJitter).toFixed(1) : null

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
              key={latency}
              className="font-medium"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
            >
              Latency: {latency}ms
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
              Jitter: {jitter}ms
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
    // Show all measurement data points, including offline ones
    return data
      .map((point) => {
        const packetLoss = point.isOnline === false ? 100 : (point.packetLoss || 0)
        const color = point.isOnline === false
          ? '#ef4444' // Red for offline
          : point.isOnline === null
          ? '#9ca3af' // Gray for missing data
          : getPacketLossColor(packetLoss)
        
        // For stacked area chart, we need latency as base and jitter stacked on top
        const latency = point.isOnline === false ? 0 : (point.latency || 0)
        const jitter = point.isOnline === false ? 0 : (point.jitter && point.jitter > 0 ? point.jitter : 0)

        return {
          time: point.timestamp.getTime(),
          latency: latency,
          jitter: jitter,
          packetLoss: packetLoss,
          isOnline: point.isOnline,
          color,
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
