'use client'

import { useMemo, memo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { motion } from 'framer-motion'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { DataPoint, TimeRange } from '@/types/probe'
import { getPacketLossColorOKLCH, getPacketLossColorInfo } from '@/lib/packet-loss-colors'

interface PacketLossChartProps {
  data: DataPoint[]
  timeRange: TimeRange
}

export const PacketLossChart = memo(function PacketLossChart({ data, timeRange }: PacketLossChartProps) {
  const chartData = useMemo(() => {
    // Aggregate data into buckets for better visualization
    const bucketCount = Math.min(60, data.length)
    const bucketSize = Math.ceil(data.length / bucketCount)
    const buckets: { time: number; packetLoss: number }[] = []

    for (let i = 0; i < data.length; i += bucketSize) {
      const bucket = data.slice(i, i + bucketSize).filter(d => d.packetLoss !== null)
      if (bucket.length === 0) continue
      const avgLoss = bucket.reduce((acc, d) => acc + (d.packetLoss || 0), 0) / bucket.length
      buckets.push({
        time: bucket[0].timestamp.getTime(),
        packetLoss: Math.round(avgLoss * 100) / 100,
      })
    }

    return buckets
  }, [data])

  const totalLoss = useMemo(() => {
    const validData = data.filter(d => d.packetLoss !== null)
    if (validData.length === 0) return 0
    const total = validData.reduce((acc, d) => acc + (d.packetLoss || 0), 0) / validData.length
    return Math.round(total * 100) / 100
  }, [data])

  const formatXAxis = (timestamp: number) => {
    const date = new Date(timestamp)
    if (timeRange === '1h' || timeRange === '3h' || timeRange === '5h' || timeRange === '24h') {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    if (timeRange === '7d') {
      return date.toLocaleDateString('en-US', { weekday: 'short' })
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const getBarColor = (loss: number) => getPacketLossColorOKLCH(loss)

  return (
    <motion.div
      className="bg-card rounded-xl border border-border p-4"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-card-foreground">Packet Loss</h3>
          <p className="text-sm text-muted-foreground">Lost packets percentage</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-muted-foreground">Average</p>
          <p className="text-lg font-semibold tabular-nums" style={{ color: getPacketLossColorOKLCH(totalLoss) }}>
            {totalLoss.toFixed(2)}%
          </p>
          <p className="text-xs text-muted-foreground">{getPacketLossColorInfo(totalLoss).label}</p>
        </div>
      </div>
      <ChartContainer
        config={{
          packetLoss: {
            label: 'Packet Loss',
            color: 'oklch(0.60 0.20 25)',
          },
        }}
        className="h-50"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.28 0.01 260)" vertical={false} />
            <XAxis
              dataKey="time"
              tickFormatter={formatXAxis}
              stroke="oklch(0.65 0 0)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={50}
            />
            <YAxis
              stroke="oklch(0.65 0 0)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              tickFormatter={value => `${value}%`}
              width={50}
              domain={[0, 'auto']}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name) => [
                    <span key="value" className="font-mono text-foreground">
                      {Number(value).toFixed(2)}%
                    </span>,
                    <span key="name" className="text-muted-foreground">Packet Loss</span>,
                  ]}
                  labelFormatter={label => {
                    const date = new Date(label as number)
                    return date.toLocaleString()
                  }}
                />
              }
            />
            <Bar dataKey="packetLoss" radius={[2, 2, 0, 0]} animationDuration={500}>
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={getBarColor(entry.packetLoss)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
    </motion.div>
  )
})
