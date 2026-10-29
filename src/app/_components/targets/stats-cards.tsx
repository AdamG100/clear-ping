"use client"

import React, { useState, useEffect } from "react"
import type { TargetStatistics } from "@/types/probe"
import type { ProbeVocabulary } from "@/lib/probes/labels"
import { cn } from "@/lib/utils"
import { getLatencyColor, getPacketLossLabel, getPacketLossVar, isMeaningfulLoss, NO_DATA_COLOR, NO_REPLY_COLOR, PACKET_LOSS_BANDS } from "@/lib/charts/packet-loss-colors"
import { AnimatePresence, motion } from "motion/react"
import { ArrowDown, ArrowUp, Clock, FileX, Gauge, TrendingUp, Zap } from "lucide-react"
import { AnimatedCounter } from "@/components/arc/animated-counter/animated-counter"
import { Tooltip } from "@/components/arc/tooltip/tooltip"
import { LossFigure } from "../charts/loss-figure"

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
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
}

interface Figure {
  label: string
  value: string
  variant?: Variant
  /** For a figure of loss: the share lost, which colours it as loss is coloured everywhere. */
  loss?: number | null
}

/** The figures along the bottom of a card, each under its label. */
function Figures({ figures }: { figures: Figure[] }) {
  return (
    // Four across needs room for four figures the width of "123.4 ms"; in a
    // card without it they go two by two.
    <dl className={cn("grid grid-cols-2 gap-3", figures.length === 4 ? "@2xs/card:grid-cols-4" : "@2xs/card:grid-cols-3")}>
      {figures.map(figure => (
        <div key={figure.label} className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs text-muted-foreground">{figure.label}</dt>
          {/* A missing reading is muted, never styled as though it were good. */}
          <dd className={cn("truncate font-mono text-sm tabular-nums", figure.value === "—" ? "text-faint" : VARIANT_TEXT[figure.variant ?? "default"])}>
            {figure.value !== "—" && typeof figure.loss === "number" ? <LossFigure loss={figure.loss}>{figure.value}</LossFigure> : figure.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

interface Spread {
  min: number | null
  low: number | null
  middle: number | null
  high: number | null
  max: number | null
  now: number | null
}

/**
 * Where a period's readings lay, from the lowest to the highest: the band is
 * where eight in ten of them were, the tick their median and the dot the
 * newest. On a square-root scale, so the spikes a path has now and then do
 * not squash the usual readings into the first sliver of the bar, while the
 * figures underneath stay exact.
 */
/** One line of a tooltip: what it is, and the figure. */
function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex justify-between gap-4 whitespace-nowrap text-xs">
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  )
}

function SpreadBar({ spread, color, describe, what }: {
  spread: Spread
  color: string
  describe: (value: number) => string
  /** What the readings are, for the tooltip: "RTT", "jitter". */
  what: string
}) {
  const { min, max } = spread
  if (min === null || max === null) {
    return (
      <div className="space-y-1.5" aria-hidden="true">
        <div className="flex h-5 items-center"><div className="h-1.5 w-full rounded-full bg-muted" /></div>
        <div className="h-3.5" />
      </div>
    )
  }
  const at = (value: number | null) =>
    value === null || max <= min ? 0 : Math.sqrt(Math.min(1, Math.max(0, (value - min) / (max - min)))) * 100
  const range = spread.low !== null && spread.high !== null ? usual(spread.low, spread.high) : null
  const mixed = `color-mix(in oklab, ${color} 55%, transparent)`

  const tip = (
    <span className="block space-y-1 text-left">
      <span className="block font-medium">Spread of {what}</span>
      <TipRow label="Lowest" value={describe(min)} />
      {range && <TipRow label="Usually" value={range} />}
      {spread.middle !== null && <TipRow label="Median" value={describe(spread.middle)} />}
      <TipRow label="Highest" value={describe(max)} />
      {spread.now !== null && <TipRow label="Latest" value={describe(spread.now)} />}
      {range && <span className="block pt-1 text-xs opacity-70">Typical range: where 8 in 10 readings fell</span>}
    </span>
  )

  return (
    <div className="space-y-1.5">
      <Tooltip content={tip}>
        <div
          tabIndex={0}
          aria-label={[
            `${what} from ${describe(min)} to ${describe(max)}`,
            range && `usually ${range}`,
            spread.middle !== null && `median ${describe(spread.middle)}`,
            spread.now !== null && `latest ${describe(spread.now)}`,
          ].filter(Boolean).join(", ")}
          className="relative h-5 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-(--focus-color)"
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
          {spread.low !== null && spread.high !== null && (
            <div
              className="absolute top-1/2 h-1.5 min-w-1.5 -translate-y-1/2 rounded-full"
              style={{ left: `${at(spread.low)}%`, width: `${at(spread.high) - at(spread.low)}%`, backgroundColor: mixed }}
            />
          )}
          {spread.middle !== null && (
            <div
              className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${at(spread.middle)}%`, backgroundColor: color }}
            />
          )}
          {spread.now !== null && (
            <div
              className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card"
              style={{ left: `${at(spread.now)}%` }}
            />
          )}
        </div>
      </Tooltip>
      {/* The ends of the bar, and what its marks are. */}
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground" aria-hidden="true">
        <span className="font-mono">{describe(min)}</span>
        <span className="hidden items-center gap-2.5 @2xs/card:flex">
          <span className="flex items-center gap-1"><span className="h-1.5 w-3 rounded-full" style={{ backgroundColor: mixed }} />usually</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-0.5 rounded-full" style={{ backgroundColor: color }} />median</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-foreground" />latest</span>
        </span>
        <span className="font-mono">{describe(max)}</span>
      </div>
    </div>
  )
}

/**
 * Every probe in the period by how much it lost, in the colours of the
 * chart's loss lane. A band any probe fell into keeps a sliver however few
 * did, so the one bad minute in a thousand good ones can still be seen.
 */
function LossBar({ bands, unit }: { bands: number[]; unit: string }) {
  const total = bands.reduce((sum, count) => sum + count, 0)
  const shown = PACKET_LOSS_BANDS.map((band, index) => ({ ...band, count: bands[index] ?? 0 })).filter(band => band.count > 0)
  const share = (count: number) => {
    const value = (count / total) * 100
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`
  }
  const probes = (count: number) => `${count.toLocaleString()} probe${count === 1 ? "" : "s"}`

  return (
    <div className="space-y-2">
      <div className="flex h-2.5 gap-px overflow-hidden rounded-full bg-muted">
        {total > 0 && shown.map(band => (
          <Tooltip
            key={band.label}
            content={
              <span className="block space-y-1 text-left">
                <span className="block font-medium">{band.label} loss: {band.range} of {unit}</span>
                <TipRow label="Probes" value={probes(band.count)} />
                <TipRow label="Of all probes" value={share(band.count)} />
                <span className="block pt-1 text-xs opacity-70">{band.description}</span>
              </span>
            }
          >
            <div
              tabIndex={0}
              aria-label={`${band.label}, ${band.range} of ${unit} lost: ${probes(band.count)}, ${share(band.count)} of all`}
              className="h-full min-w-1.5 cursor-default outline-none hover:brightness-125 focus-visible:brightness-125"
              style={{ flexGrow: band.count, flexBasis: 0, backgroundColor: band.cssVar }}
            />
          </Tooltip>
        ))}
      </div>
      {/* Probes counted by how much of what they sent was lost: a probe of 20
          packets that lost one is in "Minor", at 5%. */}
      <p className="text-[11px] text-muted-foreground">
        {total > 0 ? `Probes by the share of their ${unit} lost` : `No ${unit} sent`}
      </p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
        {shown.map(band => (
          <li key={band.label} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: band.cssVar }} />
            {band.label}
            <span className="text-faint">{band.range}</span>
            <span className="font-mono tabular-nums text-foreground">{band.count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface StatCardProps {
  title: string
  icon: React.ReactNode
  /** The reading the card is for: null when the period has none. */
  main: { value: number | null; suffix: string; decimals: number }
  mainLabel: string
  /** How the period's readings were spread: a bar drawn under the headline. */
  visual: React.ReactNode
  figures: Figure[]
  trend?: "up" | "down" | "stable"
  trendValue?: string
  /** How the reading stands, in the colour it is drawn in on the chart: the card's glow, icon and verdict. */
  accentColor?: string
  lastUpdated?: Date
  /** No pulsing ring: nothing is being measured, so nothing should look live. */
  still?: boolean
  className?: string
}

function StatCard({ title, icon, main, mainLabel, visual, figures, trend, trendValue, accentColor = "var(--accent)", lastUpdated, still = false, className }: StatCardProps) {
  return (
    // A container, so the figures along the bottom can be laid out from the
    // card's own width: it is narrowest on a mid-sized screen, three abreast,
    // and wide again on a phone, where it has a row to itself.
    <section
      className={cn("group @container/card relative flex flex-col overflow-hidden rounded-3xl border border-border bg-card p-4 transition-colors duration-300 hover:border-border-strong @2xl/main:p-6", className)}
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

      <div className="relative mt-4 @2xl/main:mt-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {/* A period with no readings says so with a dash, never a zero. */}
          <div className="font-mono text-3xl font-medium tabular-nums text-foreground">
            {main.value === null ? (
              <span className="text-faint">—</span>
            ) : (
              <AnimatedCounter value={main.value} suffix={main.suffix} decimals={main.decimals} />
            )}
          </div>
          {lastUpdated && <RelativeTime timestamp={lastUpdated} />}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{mainLabel}</p>
      </div>

      {/* Pushed to the bottom, so the bars of the three cards line up
          whichever of them has the longer line above. */}
      <div className="relative mt-auto space-y-4 pt-4 @2xl/main:pt-5">
        {visual}
        <div className="border-t border-border pt-4">
          <Figures figures={figures} />
        </div>
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
/** Where most readings were: "3.0–4.1 ms". */
const usual = (low: number | null | undefined, high: number | null | undefined) =>
  low === null || low === undefined || high === null || high === undefined ? "—" : `${low.toFixed(1)}–${high.toFixed(1)} ms`

export default function StatsCards({
  statistics,
  current,
  lastUpdated,
  vocabulary,
  paused = false,
  unmeasured = false,
  period,
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
  /**
   * A closed-port check that has never had an answer: its server cannot be
   * measured this way. Grey, as paused is, and saying so, rather than
   * calling a server down that no reading says is.
   */
  unmeasured?: boolean
  /** The period the figures are over, as it ends a sentence: "over the last 2 days". */
  period?: string
}>) {
  // Either way nothing on the cards is a verdict on the server.
  const quiet = paused || unmeasured
  const quietLabel = paused ? 'Paused' : "Can't measure"
  // "Has data" is a question about sample count, not about values. Checking
  // `avgLatency === 0 && packetLoss === 0` treated a fast, lossless target as
  // having no data and left it reading "Calculating…" forever.
  const hasData = !!statistics && statistics.sampleCount > 0

  const avgLatency = statistics?.avgLatency ?? null
  const medianLatency = statistics?.medianLatency ?? null
  const packetLoss = statistics?.packetLoss ?? null
  const maxPacketLoss = statistics?.maxPacketLoss ?? null
  const jitter = statistics?.jitter ?? null

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
  const latencyAccentColor = !hasData || quiet ? NO_DATA_COLOR
    : isCurrentlyOffline ? NO_REPLY_COLOR
    : getLatencyColor(avgLatency ?? 0)
  const packetLossAccentColor = !hasData || quiet || packetLoss === null ? NO_DATA_COLOR : getPacketLossVar(packetLoss)
  const jitterAccentColor = !hasData || quiet || jitter === null ? NO_DATA_COLOR : getLatencyColor(jitter)

  // How many probes lost anything: the number the average is made of, said
  // outright so a small figure is not taken for a small problem, or the
  // other way about.
  const probes = statistics?.sampleCount ?? 0
  const affected = (statistics?.lossyProbes ?? 0) + (statistics?.failedProbes ?? 0)
  const lossLabel = !hasData
    ? vocabulary.lossLabel
    : affected === 0
      ? probes === 1 ? "The one probe came back in full" : `All ${probes.toLocaleString()} probes came back in full`
      : `${affected.toLocaleString()} of ${probes.toLocaleString()} probes lost ${vocabulary.unit}`
  // Each headline says what period it is over, which the cards otherwise leave to the buttons above.
  const over = (text: string) => (period && hasData ? `${text}, ${period}` : text)

  return (
    // One card to a row on a phone, three abreast where each still has room
    // for its figures. Between the two, the latency card takes a row to itself
    // and the other two share the next: three in two columns leaves a hole.
    <div className={cn(STAT_GRID, quiet && "grayscale")}>
      {/* The headline is a true median: one slow reply must not move it. */}
      <StatCard
        className={STAT_GRID_LEAD}
        title={vocabulary.latencyTitle}
        icon={<Gauge size={20} strokeWidth={1.75} />}
        main={{ value: hasData ? medianLatency : null, suffix: " ms", decimals: 1 }}
        mainLabel={over(vocabulary.latencyLabel)}
        accentColor={latencyAccentColor}
        trend={quiet ? 'stable' : latencyTrend}
        trendValue={quiet ? quietLabel : latencyTrendValue}
        still={quiet}
        lastUpdated={lastUpdated}
        visual={
          <SpreadBar
            color={latencyAccentColor}
            describe={value => ms(value)}
            what={vocabulary.latencyTitle.replace(/^Median /, "")}
            spread={{
              min: statistics?.minLatency ?? null,
              low: statistics?.latencyP10 ?? null,
              middle: medianLatency,
              high: statistics?.latencyP90 ?? null,
              max: statistics?.maxLatency ?? null,
              now: hasData ? current.latency : null,
            }}
          />
        }
        figures={[
          { label: "Average", value: ms(avgLatency) },
          { label: "Usually", value: usual(statistics?.latencyP10, statistics?.latencyP90) },
          { label: "Latest", value: ms(current.latency) },
        ]}
      />

      {/* Min and max are the real extremes over the window. */}
      <StatCard
        title={vocabulary.lossTitle}
        icon={<FileX size={20} strokeWidth={1.75} />}
        main={{ value: hasData ? packetLoss : null, suffix: "%", decimals: 2 }}
        mainLabel={over(lossLabel)}
        accentColor={packetLossAccentColor}
        trend={quiet ? 'stable' : lossTrend}
        trendValue={quiet ? quietLabel : lossTrendValue}
        still={quiet}
        lastUpdated={lastUpdated}
        visual={<LossBar bands={statistics?.lossBands ?? []} unit={vocabulary.unit} />}
        figures={[
          { label: "Worst probe", value: pct(maxPacketLoss), loss: maxPacketLoss },
          { label: "No reply at all", value: hasData ? `${(statistics?.failedProbes ?? 0).toLocaleString()} probes` : "—", loss: (statistics?.failedProbes ?? 0) > 0 ? 100 : 0 },
          { label: "Latest", value: pct(current.packetLoss), loss: current.packetLoss },
        ]}
      />

      <StatCard
        title="Jitter"
        icon={<Zap size={20} strokeWidth={1.75} />}
        main={{ value: hasData ? jitter : null, suffix: " ms", decimals: 1 }}
        mainLabel={over(`Average ${vocabulary.jitterLabel.charAt(0).toLowerCase()}${vocabulary.jitterLabel.slice(1)}`)}
        accentColor={jitterAccentColor}
        trend={quiet ? 'stable' : jitterTrend}
        trendValue={quiet ? quietLabel : jitterTrendValue}
        still={quiet}
        lastUpdated={lastUpdated}
        visual={
          <SpreadBar
            color={jitterAccentColor}
            describe={value => ms(value)}
            what="jitter"
            spread={{
              min: statistics?.minJitter ?? null,
              low: statistics?.jitterP10 ?? null,
              middle: statistics?.medianJitter ?? null,
              high: statistics?.jitterP90 ?? null,
              max: statistics?.maxJitter ?? null,
              now: hasData ? current.jitter : null,
            }}
          />
        }
        figures={[
          { label: "Median", value: ms(statistics?.medianJitter) },
          { label: "Usually", value: usual(statistics?.jitterP10, statistics?.jitterP90) },
          { label: "Latest", value: ms(current.jitter), variant: current.jitter === null || current.jitter <= 50 ? "default" : current.jitter <= 100 ? "warning" : "danger" },
        ]}
      />
    </div>
  )
}
