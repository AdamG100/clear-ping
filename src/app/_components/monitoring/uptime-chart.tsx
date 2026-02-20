 'use client'

import { useMemo, memo } from 'react'
import type { DataPoint, TimeRange } from '@/types/probe'
import { cn } from '@/lib/utils'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts'
import { motion } from 'framer-motion'
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart'

interface UptimeChartProps {
  data: DataPoint[]
  timeRange: TimeRange
}

export const UptimeChart = memo(function UptimeChart({ data, timeRange }: UptimeChartProps) {
  const uptimeBlocks = useMemo(() => {
    // Create ~90 blocks for the heatmap
    const blockCount = 90
    const blockSize = Math.ceil(data.length / blockCount)
    const blocks: { isOnline: boolean; uptime: number; start: Date; end: Date }[] = []

    for (let i = 0; i < data.length; i += blockSize) {
      const block = data.slice(i, i + blockSize)
      const onlineCount = block.filter(d => d.isOnline).length
      const uptime = (onlineCount / block.length) * 100
      blocks.push({
        isOnline: uptime > 50,
        uptime,
        start: block[0].timestamp,
        end: block[block.length - 1].timestamp,
      })
    }

    return blocks
  }, [data])

  const chartData = useMemo(() => {
    return uptimeBlocks.map((b) => ({ start: b.start.getTime(), end: b.end.getTime(), uptime: b.uptime }))
  }, [uptimeBlocks])

  const totalUptime = useMemo(() => {
    const onlineCount = data.filter(d => d.isOnline).length
    return (onlineCount / data.length) * 100
  }, [data])

  const getBlockColor = (uptime: number) => {
    if (uptime === 100) return '#16a34a'
    if (uptime >= 99) return '#22c55e'
    if (uptime >= 95) return '#f59e0b'
    if (uptime >= 50) return '#f97316'
    return '#ef4444'
  }

  const formatDate = (date: Date) => {
    if (timeRange === '1h' || timeRange === '3h' || timeRange === '6h' || timeRange === '24h') {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <motion.div
      className="bg-card rounded-xl border border-border p-4"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-card-foreground">Uptime</h3>
          <p className="text-sm text-muted-foreground">Availability over period</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-muted-foreground">Total Uptime</p>
          <p className={cn(
            'text-lg font-semibold tabular-nums',
            totalUptime >= 99.9 ? 'text-success' : totalUptime >= 99 ? 'text-warning' : 'text-destructive'
          )}>
            {totalUptime.toFixed(2)}%
          </p>
        </div>
      </div>
      
      <div className="h-28">
        <ChartContainer
          config={{ uptime: { label: 'Uptime', color: 'oklch(0.6 0.2 120)' } }}
          className="h-full w-full"
        >
          <BarChart data={chartData} margin={{ top: 6, right: 8, left: 0, bottom: 6 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="start"
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => new Date(v).toLocaleString()}
              minTickGap={20}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${Math.round(Number(v))}%`}
              width={60}
              domain={[0, 100]}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => {
                    const idx = chartData.findIndex((d) => d.start === label)
                    if (idx === -1) return ''
                    const d = uptimeBlocks[idx]
                    return `${formatDate(d.start)} - ${formatDate(d.end)}`
                  }}
                  formatter={(value) => [
                    <span key="v" className="font-mono text-foreground">{Number(value).toFixed(2)}%</span>,
                    <span key="n" className="text-muted-foreground">Uptime</span>,
                  ]}
                />
              }
            />
            <Bar dataKey="uptime" radius={[2, 2, 0, 0]} animationDuration={500}>
              {chartData.map((entry, idx) => (
                <Cell key={idx} fill={getBlockColor(entry.uptime)} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </div>

      <div className="flex items-center justify-between mt-4 text-xs text-muted-foreground">
        <span>{formatDate(data[0]?.timestamp || new Date())}</span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 rounded-sm bg-success" />
            <span>100%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 rounded-sm bg-warning" />
            <span>95-99%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 rounded-sm bg-destructive" />
            <span>{'<95%'}</span>
          </div>
        </div>
        <span>{formatDate(data[data.length - 1]?.timestamp || new Date())}</span>
      </div>
    </motion.div>
  )
})
