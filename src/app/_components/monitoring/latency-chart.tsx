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
    isOnline: boolean | null
  }>
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
  const latency = Number(data.avg).toFixed(1)
  const jitter = Math.abs((data.max || 0) - (data.min || 0)).toFixed(1)

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
              {latency}ms (avg)
            </motion.span>
          </AnimatePresence>
        </div>
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
      </div>
    </motion.div>
  )
}

export const LatencyChart = memo(function LatencyChart({ data }: LatencyChartProps) {
  const chartData = useMemo(() => {
    // Calculate rolling statistics for smoke effect - optimized for performance
    const windowSize = Math.min(10, Math.max(3, Math.floor(data.length / 50))) // Smaller window for faster updates
    const chartData = data.map((point, index) => {
      const start = Math.max(0, index - windowSize)
      const end = Math.min(data.length, index + windowSize + 1)
      const window = data.slice(start, end)
      
      const windowLatencies = window.filter(d => d.latency !== null).map(d => d.latency as number)
      const windowMax = windowLatencies.length > 0 ? Math.max(...windowLatencies) : 0
      const windowMin = windowLatencies.length > 0 ? Math.min(...windowLatencies) : 0
      const windowAvg = windowLatencies.length > 0 
        ? windowLatencies.reduce((a, b) => a + b, 0) / windowLatencies.length 
        : 0

      // Calculate packet loss for this window - use actual packet loss data
      const windowPacketLosses = window.filter(d => d.packetLoss !== null).map(d => d.packetLoss as number)
      const windowLossPercent = windowPacketLosses.length > 0 
        ? windowPacketLosses.reduce((a, b) => a + b, 0) / windowPacketLosses.length 
        : 0
      const color = getPacketLossColor(windowLossPercent)

      return {
        time: point.timestamp.getTime(),
        latency: point.latency,
        max: windowMax,
        min: windowMin,
        avg: windowAvg,
        isOnline: point.isOnline,
        packetLossPercent: windowLossPercent,
        color,
        // Create separate data points for each loss level (simplified)
        perfect: windowLossPercent === 0 ? windowAvg : null,
        minor: windowLossPercent > 0 && windowLossPercent <= 10 ? windowAvg : null,
        moderate: windowLossPercent > 10 && windowLossPercent <= 50 ? windowAvg : null,
        severe: windowLossPercent > 50 ? windowAvg : null,
      }
    })

    return chartData
  }, [data])

  return (
    <Card className="border rounded-lg">
      <CardHeader className="border-b pb-4">
        <div className="space-y-3">
          <CardTitle>Network Data</CardTitle>
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
              avg: {
                label: 'Average Latency',
                color: 'hsl(var(--chart-1))',
              },
            }}
            className="aspect-auto h-100 w-full"
          >
            <BarChart data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="time"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={formatXAxis}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => `${value}ms`}
              />
              <Tooltip
                cursor={false}
                content={<AnimatedTooltip />}
              />
              <Bar dataKey="avg" radius={[4, 4, 0, 0]} animationDuration={500}>
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color || '#00FF00'} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </motion.div>
      
        <div className="flex items-center justify-center gap-6 mt-4 text-xs pb-2">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#00FF00' }} />
            <span className="text-muted-foreground">Perfect (0% loss)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#00FFFF' }} />
            <span className="text-muted-foreground">Minor loss (1-2 packets)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#FF00FF' }} />
            <span className="text-muted-foreground">Moderate-severe loss</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#FF0000' }} />
            <span className="text-muted-foreground">High loss/failure</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
})
