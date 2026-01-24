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
  const latency = Number(data.latency).toFixed(1)
  const packetLoss = Number(data.packetLoss || 0).toFixed(2)

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
              {latency}ms
            </motion.span>
          </AnimatePresence>
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key={packetLoss}
            className="text-xs text-muted-foreground"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.2, delay: 0.05 }}
          >
            Packet Loss: {packetLoss}%
          </motion.div>
        </AnimatePresence>
        <div className="text-xs text-muted-foreground">
          Status: {data.isOnline ? 'Online' : 'Offline'}
        </div>
      </div>
    </motion.div>
  )
}

export const LatencyChart = memo(function LatencyChart({ data }: LatencyChartProps) {
  const chartData = useMemo(() => {
    // Show actual measurement data points, not rolling averages
    return data
      .filter(point => point.latency !== null) // Only show points with actual measurements
      .map((point) => {
        const color = point.isOnline 
          ? getPacketLossColor(point.packetLoss || 0)
          : '#ef4444' // Red for offline

        return {
          time: point.timestamp.getTime(),
          latency: point.latency,
          packetLoss: point.packetLoss,
          isOnline: point.isOnline,
          color,
        }
      })
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
              latency: {
                label: 'Latency',
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
              <Bar dataKey="latency" radius={[4, 4, 0, 0]} animationDuration={500}>
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
