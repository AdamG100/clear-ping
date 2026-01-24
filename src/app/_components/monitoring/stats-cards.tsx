"use client"

import React, { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { getLatencyColor, getPacketLossColor } from "@/lib/packet-loss-colors"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowDown, ArrowUp, Gauge, TrendingUp, FileX, Clock } from "lucide-react"

function RelativeTime({ timestamp }: { timestamp: Date }) {
  const [relativeTime, setRelativeTime] = useState("")

  useEffect(() => {
    const updateRelativeTime = () => {
      const now = new Date()
      const diffMs = now.getTime() - timestamp.getTime()
      const diffSeconds = Math.floor(diffMs / 1000)
      const diffMinutes = Math.floor(diffSeconds / 60)
      const diffHours = Math.floor(diffMinutes / 60)
      const diffDays = Math.floor(diffHours / 24)

      let newRelativeTime = ""
      if (diffSeconds < 60) {
        newRelativeTime = "now"
      } else if (diffMinutes < 60) {
        newRelativeTime = `${diffMinutes}m ago`
      } else if (diffHours < 24) {
        newRelativeTime = `${diffHours}h ago`
      } else {
        newRelativeTime = `${diffDays}d ago`
      }

      setRelativeTime(newRelativeTime)
    }

    updateRelativeTime()
    const interval = setInterval(updateRelativeTime, 60000) // Update every minute

    return () => clearInterval(interval)
  }, [timestamp])

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={relativeTime}
        className="flex items-center gap-1.5 text-sm text-muted-foreground bg-muted/30 px-2 py-1 rounded-md border border-border/20"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        <Clock className="h-4 w-4" />
        <span className="font-medium">{relativeTime}</span>
      </motion.div>
    </AnimatePresence>
  )
}

interface StatItemProps {
  label: string
  value: string
  highlight?: boolean
  variant?: "default" | "success" | "warning" | "danger"
}

function StatItem({ label, value, highlight = false, variant = "default" }: StatItemProps) {
  const variantClasses = {
    default: "text-muted-foreground",
    success: "text-green-600",
    warning: "text-amber-400",
    danger: "text-rose-400",
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <AnimatePresence mode="wait">
        <motion.span
          key={value}
          className={cn(
            "text-sm font-mono tabular-nums",
            highlight ? "text-foreground font-semibold" : variantClasses[variant]
          )}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

interface StatCardProps {
  title: string
  icon: React.ReactNode
  mainValue: string
  mainLabel: string
  stats: Array<{
    label: string
    value: string
    variant?: "default" | "success" | "warning" | "danger"
  }>
  trend?: "up" | "down" | "stable"
  trendValue?: string
  accentColor?: string
  lastUpdated?: Date
}

function StatCard({
  title,
  icon,
  mainValue,
  mainLabel,
  stats,
  trend,
  trendValue,
  accentColor = "#4fd1c5",
  lastUpdated,
}: StatCardProps) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/50 bg-card p-6 transition-all duration-300 hover:border-border hover:shadow-lg hover:shadow-primary/5">
      {/* Subtle glow effect */}
      <div
        className="absolute -right-20 -top-20 h-65 w-65 rounded-full opacity-10 blur-3xl transition-opacity duration-500 group-hover:opacity-20"
        style={{ backgroundColor: accentColor }}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-lg">
            {/* Pulsing background ring */}
            <div
              className="absolute h-10 w-10 rounded-lg custom-ping opacity-75"
              style={{ backgroundColor: `${accentColor}15` }}
            />
            {/* Fixed center icon container */}
            <div
              className="relative flex h-10 w-10 items-center justify-center rounded-lg"
              style={{ backgroundColor: `${accentColor}15` }}
            >
              <span style={{ color: accentColor }}>{icon}</span>
            </div>
          </div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
        <AnimatePresence mode="wait">
          {trend && (
            <motion.div
              key={`${trend}-${trendValue}`}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors duration-500"
              style={{
                backgroundColor: `${accentColor}20`,
                color: accentColor
              }}
              initial={{ opacity: 0, scale: 0.8, x: 10 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.8, x: -10 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            >
              {trend === "up" && <ArrowUp className="h-3 w-3" />}
              {trend === "down" && <ArrowDown className="h-3 w-3" />}
              {trend === "stable" && <TrendingUp className="h-3 w-3" />}
              <AnimatePresence mode="wait">
                <motion.span
                  key={trendValue}
                  initial={{ opacity: 0, x: 5 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -5 }}
                  transition={{ duration: 0.2, delay: 0.1 }}
                >
                  {trendValue}
                </motion.span>
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Main Value */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <AnimatePresence mode="wait">
            <motion.p
              key={mainValue}
              className="text-3xl font-bold tracking-tight text-foreground"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            >
              {mainValue}
            </motion.p>
          </AnimatePresence>
          {lastUpdated && <RelativeTime timestamp={lastUpdated} />}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{mainLabel}</p>
      </div>

      {/* Stats Grid */}
      <div className="mt-6 grid grid-cols-4 gap-4 border-t border-border/50 pt-4">
        {stats.map((stat, index) => (
          <StatItem key={index} label={stat.label} value={stat.value} variant={stat.variant} />
        ))}
      </div>
    </div>
  )
}

export default function StatsCards({
  avgLatency,
  minLatency,
  maxLatency,
  packetLoss,
  currentLatency,
  currentPacketLoss,
  lastUpdated,
}: Readonly<{
  avgLatency: number
  minLatency: number
  maxLatency: number
  packetLoss: number
  currentLatency: number
  currentPacketLoss: number
  lastUpdated?: Date
}>) {
  // Calculate median (simple approximation)
  const medianLatency = (minLatency + maxLatency) / 2

  // Determine latency trend - show offline when current measurement shows complete failure
  const isCurrentlyOffline = currentPacketLoss === 100
  const latencyTrend = isCurrentlyOffline ? "down" : 
    avgLatency <= 10 ? "up" : 
    avgLatency <= 30 ? "up" : 
    avgLatency <= 50 ? "up" : 
    avgLatency <= 75 ? "stable" : 
    avgLatency <= 100 ? "stable" : 
    avgLatency <= 150 ? "down" : 
    avgLatency <= 200 ? "down" : "down"
  
  const latencyTrendValue = isCurrentlyOffline ? "Offline" : 
    avgLatency <= 10 ? "Excellent" : 
    avgLatency <= 30 ? "Very Good" : 
    avgLatency <= 50 ? "Good" : 
    avgLatency <= 75 ? "Acceptable" : 
    avgLatency <= 100 ? "Fair" : 
    avgLatency <= 150 ? "Degraded" : 
    avgLatency <= 200 ? "Poor" : "Critical"

  // Determine packet loss trend matching packet-loss-colors.ts thresholds
  const lossTrend = packetLoss === 0 ? "up" : 
    packetLoss <= 10 ? "stable" : 
    packetLoss <= 50 ? "down" : "down"
  
  const lossTrendValue = packetLoss === 0 ? "Perfect" : 
    packetLoss <= 10 ? "Minor Loss" : 
    packetLoss <= 50 ? "Moderate-Severe" : "High Loss/Failure"

  // Get dynamic accent colors based on current values
  const latencyAccentColor = isCurrentlyOffline ? '#ef4444' : getLatencyColor(avgLatency) // Red when offline
  const packetLossAccentColor = getPacketLossColor(packetLoss)

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* RTT Card */}
      <StatCard
        title="Median RTT"
        icon={<Gauge className="h-5 w-5" />}
        mainValue={`${medianLatency.toFixed(1)} ms`}
        mainLabel="Average Round Trip Time"
        accentColor={latencyAccentColor}
        trend={latencyTrend}
        trendValue={latencyTrendValue}
        lastUpdated={lastUpdated}
        stats={[
          { label: "Avg", value: `${avgLatency.toFixed(1)} ms`, variant: "default" },
          { label: "Max", value: `${maxLatency.toFixed(1)} ms`, variant: avgLatency > 100 ? "warning" : "default" },
          { label: "Min", value: `${minLatency.toFixed(1)} ms`, variant: "success" },
          { label: "Now", value: `${currentLatency.toFixed(1)} ms`, variant: "default" },
        ]}
      />

      {/* Packet Loss Card */}
      <StatCard
        title="Packet Loss"
        icon={<FileX className="h-5 w-5" />}
        mainValue={`${packetLoss.toFixed(2)}%`}
        mainLabel="Average Packet Loss"
        accentColor={packetLossAccentColor}
        trend={lossTrend}
        trendValue={lossTrendValue}
        stats={[
          { label: "Avg", value: `${packetLoss.toFixed(2)}%`, variant: "default" },
          { label: "Max", value: `${packetLoss.toFixed(2)}%`, variant: packetLoss > 10 ? "danger" : packetLoss > 0 ? "warning" : "success" },
          { label: "Min", value: "0.00%", variant: "success" },
          { label: "Now", value: `${currentPacketLoss.toFixed(2)}%`, variant: currentPacketLoss === 0 ? "success" : currentPacketLoss <= 10 ? "warning" : "danger" },
        ]}
      />
    </div>
  )
}
