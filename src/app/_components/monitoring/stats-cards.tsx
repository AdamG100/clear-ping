"use client"

import React, { useState, useEffect } from "react"
import type { TargetStatistics } from "@/types/probe"
import type { ProbeVocabulary } from "@/lib/probe-labels"
import { cn } from "@/lib/utils"
import { getLatencyColor, getPacketLossLabel, getPacketLossVar, isMeaningfulLoss, NO_DATA_COLOR } from "@/lib/packet-loss-colors"
import { AnimatePresence, motion } from "motion/react"
import { ArrowDown, ArrowUp, Clock, FileX, Gauge, TrendingUp, Zap } from "lucide-react"
import { AnimatedCounter } from "@/components/arc/animated-counter/animated-counter"

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
  // one on the first render and whenever the timestamp changes.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(interval)
  }, [])

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
      {/* A time, in the face every other time on the page is set in. */}
      <span className="font-mono">{describeAge(now - timestamp.getTime())}</span>
    </span>
  )
}

type Variant = "default" | "success" | "warning" | "danger"

const VARIANT_TEXT: Record<Variant, string> = {
  default: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
}

function StatItem({ label, value, variant = "default" }: { label: string; value: string; variant?: Variant }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {/* A missing reading is muted, never styled as though it were good. */}
      <span className={cn("font-mono text-sm tabular-nums", value === "—" ? "text-faint" : VARIANT_TEXT[variant])}>{value}</span>
    </div>
  )
}

interface StatCardProps {
  title: string
  icon: React.ReactNode
  /** The reading the card is for: null when the period has none. */
  main: { value: number | null; suffix: string; decimals: number }
  mainLabel: string
  stats: Array<{ label: string; value: string; variant?: Variant }>
  trend?: "up" | "down" | "stable"
  trendValue?: string
  /** How the reading stands, in the colour it is drawn in on the chart: the card's glow, icon and verdict. */
  accentColor?: string
  lastUpdated?: Date
  /** No pulsing ring: nothing is being measured, so nothing should look live. */
  still?: boolean
  className?: string
}

function StatCard({ title, icon, main, mainLabel, stats, trend, trendValue, accentColor = "var(--accent)", lastUpdated, still = false, className }: StatCardProps) {
  return (
    // A container, so the four figures along the bottom can be laid out from
    // the card's own width: it is narrowest on a mid-sized screen, three
    // abreast, and wide again on a phone, where it has a row to itself.
    <section
      className={cn("group @container/card relative overflow-hidden rounded-3xl border border-border bg-card p-4 transition-colors duration-300 hover:border-border-strong @2xl/main:p-6", className)}
      aria-label={title}
    >
      {/* The card's glow, in the colour of how the reading stands, so the
          state of all three can be taken in before any figure is read. */}
      <div
        className="pointer-events-none absolute -right-20 -top-20 h-65 w-65 rounded-full opacity-10 blur-3xl transition-[opacity,background-color] duration-500 group-hover:opacity-20"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />

      {/* Header. The verdict drops under the title where the card is too
          narrow for both, instead of squeezing the title onto three lines. */}
      <div className="relative flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl" aria-hidden="true">
            {/* The pulse starts no brighter than the ring is at rest, so the
                icon never blinks out against a solid square of its colour. */}
            <div
              className={cn("absolute inset-0 rounded-xl", !still && "custom-ping")}
              style={{ backgroundColor: accentColor, opacity: 0.15, "--ping-peak": 0.15 } as React.CSSProperties}
            />
            <div className="absolute inset-0 rounded-xl" style={{ backgroundColor: accentColor, opacity: 0.08 }} />
            <span className="relative" style={{ color: accentColor }}>{icon}</span>
          </div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {trendValue && (
            <motion.span
              key={`${trend}-${trendValue}`}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
              // Mixed rather than given an alpha suffix: the colour is as
              // often a `var(--…)` as a hex code.
              style={{ backgroundColor: `color-mix(in oklab, ${accentColor} 14%, transparent)`, color: accentColor }}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {trend === "up" && <ArrowUp size={12} aria-hidden="true" />}
              {trend === "down" && <ArrowDown size={12} aria-hidden="true" />}
              {trend === "stable" && <TrendingUp size={12} aria-hidden="true" />}
              {trendValue}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="relative mt-4 @2xl/main:mt-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {/* A period with no readings says so with a dash, never a zero. */}
          <div className="font-mono text-3xl font-medium tabular-nums text-foreground">
            {main.value === null ? (
              <span className="text-faint">—</span>
            ) : (
              <AnimatedCounter value={main.value} suffix={main.suffix} decimals={main.decimals} label={title} />
            )}
          </div>
          {lastUpdated && <RelativeTime timestamp={lastUpdated} />}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{mainLabel}</p>
      </div>

      {/* Four across needs room for four figures the width of "123.4 ms"; in
          a card without it they overlapped, so there they go two by two. */}
      <div className="relative mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 @2xs/card:grid-cols-4 @2xl/main:mt-6">
        {stats.map((stat, index) => (
          <StatItem key={index} label={stat.label} value={stat.value} variant={stat.variant} />
        ))}
      </div>
    </section>
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
        icon={<Gauge size={20} strokeWidth={1.75} />}
        main={{ value: hasData ? medianLatency : null, suffix: " ms", decimals: 1 }}
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
        icon={<FileX size={20} strokeWidth={1.75} />}
        main={{ value: hasData ? packetLoss : null, suffix: "%", decimals: 2 }}
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
        icon={<Zap size={20} strokeWidth={1.75} />}
        main={{ value: hasData ? jitter : null, suffix: " ms", decimals: 1 }}
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
