"use client"

import React, { useState, useEffect } from "react"
import type { TargetStatistics } from "@/types/probe"
import { cn } from "@/lib/utils"
import { getLatencyColor, getPacketLossColor, getPacketLossLabel, isMeaningfulLoss } from "@/lib/packet-loss-colors"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowDown, ArrowUp, Gauge, TrendingUp, FileX, Clock, Zap } from "lucide-react"

function RelativeTime({ timestamp }: { timestamp: Date }) {
  const [relativeTime, setRelativeTime] = useState("")
  const time = timestamp.getTime()

  useEffect(() => {
    const updateRelativeTime = () => {
      const diffMs = Date.now() - time


      // Handle future timestamps (shouldn't happen, but be safe)
      if (diffMs < 0) {
        setRelativeTime("now")
        return
      }
      
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

    // Update immediately
    updateRelativeTime()
    
    // Update every 10 seconds for very responsive display
    const interval = setInterval(updateRelativeTime, 10000)

    return () => clearInterval(interval)
  }, [time])

  return (
    <motion.div
      key={relativeTime}
      className="flex items-center gap-1.5 text-sm text-muted-foreground bg-muted/30 px-2 py-1 rounded-md border border-border/20"
      initial={{ opacity: 0.7 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.1 }}
    >
      <Clock className="h-4 w-4" />
      <span className="font-medium">{relativeTime}</span>
    </motion.div>
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
            // A missing reading is muted, never styled as though it were good.
            value === "—" ? "text-muted-foreground/50"
              : highlight ? "text-foreground font-semibold"
              : variantClasses[variant]
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
  isPolling?: boolean
  isLoading?: boolean
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
  isLoading = false,
}: StatCardProps & { isPolling?: boolean; isLoading?: boolean }) {
  return (
    <div className={cn(
      "group relative overflow-hidden rounded-xl border border-border/50 bg-card p-6 transition-all duration-300 hover:border-border hover:shadow-lg hover:shadow-primary/5"
    )}>
      {/* Subtle glow effect */}
      <div
        className={cn(
          "absolute -right-20 -top-20 h-65 w-65 rounded-full opacity-10 blur-3xl transition-opacity duration-500 group-hover:opacity-20"
          )}
          style={{ backgroundColor: accentColor }}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-lg">
            {/* Pulsing background ring (use opacity style so OKLCH works) */}
            <div
              className="absolute h-10 w-10 rounded-lg custom-ping"
              style={{ backgroundColor: accentColor, opacity: 0.15 }}
            />
            {/* Fixed center icon container with a semi-opaque background layer so the icon stays fully opaque */}
            <div className="relative flex h-10 w-10 items-center justify-center rounded-lg">
              <div className="absolute inset-0 rounded-lg" style={{ backgroundColor: accentColor, opacity: 0.08 }} />
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
            {isLoading ? (
              <motion.div
                key="loading"
                className="h-9 w-32 bg-muted/50 rounded animate-pulse"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
              />
            ) : (
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
            )}
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

export interface CurrentReadings {
  latency: number | null
  packetLoss: number | null
  jitter: number | null
  isOnline: boolean
}

/** "—" for an absent reading, so it is never mistaken for a real zero. */
const ms = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toFixed(1)} ms`
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toFixed(2)}%`

export default function StatsCards({
  statistics,
  current,
  lastUpdated,
}: Readonly<{
  statistics: TargetStatistics | null
  current: CurrentReadings
  lastUpdated?: Date
}>) {
  // "Has data" is a question about sample count, not about values. Checking
  // `avgLatency === 0 && packetLoss === 0` treated a fast, lossless target as
  // having no data and left it reading "Calculating…" forever.
  const hasData = !!statistics && statistics.sampleCount > 0

  const avgLatency = statistics?.avgLatency ?? null
  const medianLatency = statistics?.medianLatency ?? null
  const minLatency = statistics?.minLatency ?? null
  const maxLatency = statistics?.maxLatency ?? null
  const packetLoss = statistics?.packetLoss ?? null
  const minPacketLoss = statistics?.minPacketLoss ?? null
  const maxPacketLoss = statistics?.maxPacketLoss ?? null
  const jitter = statistics?.jitter ?? null
  const minJitter = statistics?.minJitter ?? null
  const maxJitter = statistics?.maxJitter ?? null

  const isCurrentlyOffline = hasData && !current.isOnline

  const latencyTrend = !hasData || avgLatency === null ? "stable" : (isCurrentlyOffline ? "down" :
    avgLatency <= 100 ? "up" :
    avgLatency <= 200 ? "stable" : "down")

  const latencyTrendValue = !hasData ? "Calculating…" : (isCurrentlyOffline ? "Offline" :
    avgLatency === null ? "No replies" :
    avgLatency <= 50 ? "Excellent" :
    avgLatency <= 100 ? "Good" :
    avgLatency <= 200 ? "Fair" :
    avgLatency <= 400 ? "Poor" :
    avgLatency <= 800 ? "Very Poor" : "Critical")

  // Read from the shared bands rather than restating the thresholds. Keeping a
  // second copy here is how the card came to call a single stray packet
  // "Minor Loss" while the rest of the app had moved on.
  const lossTrend = !hasData || packetLoss === null
    ? "stable"
    : isMeaningfulLoss(packetLoss) ? "down" : "up"

  const lossTrendValue = !hasData || packetLoss === null
    ? "Calculating…"
    : getPacketLossLabel(packetLoss)

  const jitterTrend = !hasData || jitter === null ? "stable" : (jitter <= 100 ? "up" : "down")

  const jitterTrendValue = !hasData ? "Calculating…" : (
    jitter === null ? "No data" :
    jitter <= 50 ? "Excellent" :
    jitter <= 100 ? "Good" :
    jitter <= 200 ? "Fair" : "Poor")

  const latencyAccentColor = !hasData ? '#6b7280'
    : isCurrentlyOffline ? getPacketLossColor(100)
    : getLatencyColor(avgLatency ?? 0)
  const packetLossAccentColor = !hasData || packetLoss === null ? '#6b7280' : getPacketLossColor(packetLoss)
  const jitterAccentColor = !hasData || jitter === null ? '#6b7280' : getLatencyColor(jitter)

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* RTT Card — the headline is a true median. It used to be the midrange,
          (min + max) / 2, which a single spike drags far from any reading. */}
      <StatCard
        title="Median RTT"
        icon={<Gauge className="h-5 w-5" />}
        mainValue={ms(medianLatency)}
        mainLabel="Median Round Trip Time"
        accentColor={latencyAccentColor}
        trend={latencyTrend}
        trendValue={latencyTrendValue}
        lastUpdated={lastUpdated}
        isLoading={!hasData}
        stats={[
          { label: "Avg", value: ms(avgLatency), variant: "default" },
          { label: "Max", value: ms(maxLatency), variant: avgLatency !== null && avgLatency > 100 ? "warning" : "default" },
          { label: "Min", value: ms(minLatency), variant: "success" },
          { label: "Now", value: ms(current.latency), variant: "default" },
        ]}
      />

      {/* Packet Loss Card — Min and Max are the real extremes over the window.
          They were previously hardcoded to 0% and to the average. */}
      <StatCard
        title="Packet Loss"
        icon={<FileX className="h-5 w-5" />}
        mainValue={pct(packetLoss)}
        mainLabel={hasData && statistics
          ? `${statistics.uptime.toFixed(1)}% of ${statistics.sampleCount} probes answered`
          : "Average Packet Loss"}
        accentColor={packetLossAccentColor}
        trend={lossTrend}
        trendValue={lossTrendValue}
        lastUpdated={lastUpdated}
        isLoading={!hasData}
        stats={[
          { label: "Avg", value: pct(packetLoss), variant: "default" },
          { label: "Max", value: pct(maxPacketLoss), variant: !isMeaningfulLoss(maxPacketLoss) ? "success" : maxPacketLoss! > 5 ? "danger" : "warning" },
          { label: "Min", value: pct(minPacketLoss), variant: "success" },
          { label: "Now", value: pct(current.packetLoss), variant: !isMeaningfulLoss(current.packetLoss) ? "success" : (current.packetLoss ?? 0) <= 5 ? "warning" : "danger" },
        ]}
      />

      {/* Jitter Card */}
      <StatCard
        title="Jitter"
        icon={<Zap className="h-5 w-5" />}
        mainValue={ms(jitter)}
        mainLabel="Variation between consecutive packets"
        accentColor={jitterAccentColor}
        trend={jitterTrend}
        trendValue={jitterTrendValue}
        lastUpdated={lastUpdated}
        isLoading={!hasData}
        stats={[
          { label: "Avg", value: ms(jitter), variant: "default" },
          { label: "Max", value: ms(maxJitter), variant: jitter !== null && jitter > 100 ? "warning" : "default" },
          { label: "Min", value: ms(minJitter), variant: "success" },
          { label: "Now", value: ms(current.jitter), variant: current.jitter === null || current.jitter <= 50 ? "success" : current.jitter <= 100 ? "warning" : "danger" },
        ]}
      />
    </div>
  )
}
