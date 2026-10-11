"use client"

import React, { useState, useEffect } from "react"
import type { TargetStatistics } from "@/types/probe"
import type { ProbeVocabulary } from "@/lib/probe-labels"
import { cn } from "@/lib/utils"
import { getLatencyColor, getPacketLossLabel, getPacketLossVar, isMeaningfulLoss, NO_DATA_COLOR } from "@/lib/packet-loss-colors"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowDown, ArrowUp, Gauge, TrendingUp, FileX, Clock, Zap } from "lucide-react"

/** How long ago something was, to the coarsest unit that says anything. */
function describeAge(diffMs: number): string {
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  // Also covers a timestamp in the future (shouldn't happen, but be safe).
  if (diffSeconds < 60) return "now"
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}

function RelativeTime({ timestamp }: { timestamp: Date }) {
  // The clock is the state and the label is worked out from it, so there is
  // one on the first render and whenever the timestamp changes. Starting blank
  // and filling in from an effect drew an empty pill on every card for a frame.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Update every 10 seconds for very responsive display
    const interval = setInterval(() => setNow(Date.now()), 10000)

    return () => clearInterval(interval)
  }, [])

  const relativeTime = describeAge(now - timestamp.getTime())

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
  /** No pulsing ring: nothing is being measured, so nothing should look live. */
  still?: boolean
  className?: string
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
  still = false,
  className,
}: StatCardProps) {
  return (
    // A container, so the four figures along the bottom can be laid out from
    // the card's own width: it is narrowest on a mid-sized screen, three
    // abreast, and wide again on a phone, where it has a row to itself.
    <div className={cn(
      "group @container/card relative overflow-hidden rounded-xl border border-border/50 bg-card p-4 transition-all duration-300 hover:border-border hover:shadow-lg hover:shadow-primary/5 @2xl/main:p-6",
      className
    )}>
      {/* Subtle glow effect */}
      <div
        className={cn(
          "absolute -right-20 -top-20 h-65 w-65 rounded-full opacity-10 blur-3xl transition-opacity duration-500 group-hover:opacity-20"
          )}
          style={{ backgroundColor: accentColor }}
      />

      {/* Header. The verdict drops under the title where the card is too
          narrow for both, instead of squeezing the title onto three lines. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            {/* Pulsing background ring (use opacity style so OKLCH works) */}
            {/* The pulse starts no brighter than the ring is at rest. At the
                animation's usual strength the ring began each cycle as a
                near-solid square of the icon's own colour, and the icon
                blinked out against it every two seconds. */}
            <div
              className={cn('absolute h-10 w-10 rounded-lg', !still && 'custom-ping')}
              style={{ backgroundColor: accentColor, opacity: 0.15, '--ping-peak': 0.15 } as React.CSSProperties}
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
              // Mixed rather than given an alpha suffix: the accent is as
              // often a `var(--…)` as a hex code, and `var(--…)20` is not a
              // colour, which left those pills with no background at all.
              style={{
                backgroundColor: `color-mix(in oklab, ${accentColor} 13%, transparent)`,
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
      <div className="mt-4 @2xl/main:mt-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {/* A period with no readings says so with a dash. It used to show a
              pulsing placeholder here, which is the sign for "loading" and
              never stopped: the cards are only drawn once loading is over. */}
          <AnimatePresence mode="wait">
            <motion.p
              key={mainValue}
              className={cn(
                "text-3xl font-bold tracking-tight",
                mainValue === "—" ? "text-muted-foreground/50" : "text-foreground"
              )}
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

      {/* Stats Grid. Four across needs room for four figures the width of
          "123.4 ms"; in a card without it they overlapped, so there they go
          two by two. */}
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/50 pt-4 @2xs/card:grid-cols-4 @2xl/main:mt-6">
        {stats.map((stat, index) => (
          <StatItem key={index} label={stat.label} value={stat.value} variant={stat.variant} />
        ))}
      </div>
    </div>
  )
}

/**
 * How the three cards are arranged, sized from the main pane (see
 * pane-layout.ts). Shared with their placeholder, which has to hold the same
 * shape or the page jumps when the figures arrive.
 */
export const STAT_GRID = "grid gap-4 @2xl/main:grid-cols-2 @2xl/main:gap-6 @5xl/main:grid-cols-3"
/** The first of the three, which spans both columns while there are only two. */
export const STAT_GRID_LEAD = "@2xl/main:col-span-2 @5xl/main:col-span-1"

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
  vocabulary,
  paused = false,
}: Readonly<{
  statistics: TargetStatistics | null
  current: CurrentReadings
  lastUpdated?: Date
  /**
   * The target is not being probed. The figures still describe the period on
   * screen, but the cards go grey and stop pulsing, and none of them passes
   * judgement on a state nobody has measured since.
   */
  paused?: boolean
  /** Names for the readings, which differ between ping and DNS targets. */
  vocabulary: ProbeVocabulary
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

  // With no readings the cards say "No data". They said "Calculating…", but
  // nothing is being calculated: by the time they are drawn the period has
  // been loaded and found empty.
  const latencyTrendValue = !hasData ? "No data" : (isCurrentlyOffline ? "Offline" :
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
    ? "No data"
    : getPacketLossLabel(packetLoss)

  const jitterTrend = !hasData || jitter === null ? "stable" : (jitter <= 100 ? "up" : "down")

  const jitterTrendValue = !hasData ? "No data" : (
    jitter === null ? "No data" :
    jitter <= 50 ? "Excellent" :
    jitter <= 100 ? "Good" :
    jitter <= 200 ? "Fair" : "Poor")

  // All from the theme's signal colours, so the three cards agree with each
  // other and with the chart underneath in either theme.
  const latencyAccentColor = !hasData || paused ? NO_DATA_COLOR
    : isCurrentlyOffline ? getPacketLossVar(100)
    : getLatencyColor(avgLatency ?? 0)
  const packetLossAccentColor = !hasData || paused || packetLoss === null ? NO_DATA_COLOR : getPacketLossVar(packetLoss)
  const jitterAccentColor = !hasData || paused || jitter === null ? NO_DATA_COLOR : getLatencyColor(jitter)

  return (
    // One card to a row on a phone, three abreast where each still has room
    // for its figures. Between the two, the latency card takes a row to itself
    // and the other two share the next: three in two columns leaves a hole.
    <div className={cn(STAT_GRID, paused && "grayscale")}>
      {/* RTT Card — the headline is a true median. It used to be the midrange,
          (min + max) / 2, which a single spike drags far from any reading. */}
      <StatCard
        className={STAT_GRID_LEAD}
        title={vocabulary.latencyTitle}
        icon={<Gauge className="h-5 w-5" />}
        mainValue={ms(medianLatency)}
        mainLabel={vocabulary.latencyLabel}
        accentColor={latencyAccentColor}
        trend={paused ? 'stable' : latencyTrend}
        trendValue={paused ? 'Paused' : latencyTrendValue}
        still={paused}
        lastUpdated={lastUpdated}
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
        title={vocabulary.lossTitle}
        icon={<FileX className="h-5 w-5" />}
        mainValue={pct(packetLoss)}
        mainLabel={hasData && statistics
          ? `${statistics.uptime.toFixed(1)}% of ${statistics.sampleCount} probes answered`
          : vocabulary.lossLabel}
        accentColor={packetLossAccentColor}
        trend={paused ? 'stable' : lossTrend}
        trendValue={paused ? 'Paused' : lossTrendValue}
        still={paused}
        lastUpdated={lastUpdated}
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
        mainLabel={vocabulary.jitterLabel}
        accentColor={jitterAccentColor}
        trend={paused ? 'stable' : jitterTrend}
        trendValue={paused ? 'Paused' : jitterTrendValue}
        still={paused}
        lastUpdated={lastUpdated}
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
