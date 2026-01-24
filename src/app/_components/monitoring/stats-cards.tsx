"use client"

import React from "react"
import { cn } from "@/lib/utils"
import { getLatencyColor, getPacketLossColor } from "@/lib/packet-loss-colors"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowDown, ArrowUp, Gauge, TrendingUp, FileX } from "lucide-react"

interface StatItemProps {
  label: string
  value: string
  highlight?: boolean
  variant?: "default" | "success" | "warning" | "danger"
}

function StatItem({ label, value, highlight = false, variant = "default" }: StatItemProps) {
  const variantClasses = {
    default: "text-muted-foreground",
    success: "text-emerald-400",
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
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${accentColor}15` }}
          >
            <span style={{ color: accentColor }}>{icon}</span>
          </div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
        {trend && (
          <div
            className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium"
            style={{
              backgroundColor: `${accentColor}20`,
              color: accentColor
            }}
          >
            {trend === "up" && <ArrowUp className="h-3 w-3" />}
            {trend === "down" && <ArrowDown className="h-3 w-3" />}
            {trend === "stable" && <TrendingUp className="h-3 w-3" />}
            {trendValue}
          </div>
        )}
      </div>

      {/* Main Value */}
      <div className="mt-6">
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
  currentIsOnline = true
}: Readonly<{
  avgLatency: number
  minLatency: number
  maxLatency: number
  packetLoss: number
  currentLatency: number
  currentPacketLoss: number
  currentIsOnline?: boolean
}>) {
  // Calculate median (simple approximation)
  const medianLatency = (minLatency + maxLatency) / 2

  // Determine latency trend
  const latencyTrend = !currentIsOnline ? "down" : avgLatency < 50 ? "up" : avgLatency < 100 ? "stable" : "down"
  const latencyTrendValue = !currentIsOnline ? "Offline" : avgLatency < 50 ? "Normal" : avgLatency < 100 ? "Fair" : "High"

  // Determine packet loss trend
  const lossTrend = packetLoss === 0 ? "up" : packetLoss <= 10 ? "stable" : packetLoss <= 50 ? "down" : "down"
  const lossTrendValue = packetLoss === 0 ? "Perfect" : packetLoss <= 10 ? "Minor loss" : packetLoss <= 50 ? "Moderate-severe loss" : "High loss/failure"

  // Get dynamic accent colors based on current values
  const latencyAccentColor = currentIsOnline ? getLatencyColor(avgLatency) : '#ef4444' // Red when offline
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
