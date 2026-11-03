"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Activity, Clock3, Network, Route } from "lucide-react"
import { Button } from "@/components/arc/button/button"
import { Tooltip } from "@/components/arc/tooltip/tooltip"
import { ExpandableCard } from "@/components/arc/expandable-card/expandable-card"
import type { AddressFamily, TimeWindow } from "@/types/probe"
import type { ProbeVocabulary } from "@/lib/probes/labels"
import { humanDuration } from "@/lib/reports/evidence"
import type { LossAnalysis, LossPattern, LossSource } from "@/lib/reports/loss"
import { displayTimeZone, inDisplayZone } from "@/lib/time-zone"
import { cn } from "@/lib/utils"

/**
 * The packet loss analysis under the cards, shown only when the period has
 * loss, and folded until it is opened. The card says how much was lost; this
 * is for finding out why. It lays out what the lossy probes have in common:
 * how they are spread, the hours they fall in, and which other targets lost
 * packets at the same time, which is what tells a fault on the local network
 * from one at the ISP or beyond. Folded, its header still gives the gist.
 */

const PATTERN: Record<Exclude<LossPattern, "none">, { label: string; color: string; says: (unit: string) => string }> = {
  scattered: {
    label: "Sporadic",
    color: "var(--signal-minor)",
    says: () =>
      "Isolated losses, never in consecutive probes. Typical of ICMP rate limiting on a router along the path, or brief congestion. Usually harmless unless it lines up with problems users report.",
  },
  spells: {
    label: "Bursts",
    color: "var(--signal-moderate)",
    says: unit =>
      `Consecutive probes lost ${unit} for a few minutes at a time. Points to an intermittent fault: Wi-Fi interference, a flapping link or port, or congestion at peak times.`,
  },
  constant: {
    label: "Sustained",
    color: "var(--signal-critical)",
    says: unit =>
      `Most probes lose ${unit}. Points to a persistent fault: a bad cable or port, a saturated link, or a device dropping traffic.`,
  },
}

/** The likely source, in a few words for the folded header. */
const SOURCE: Record<LossSource, string | null> = {
  local: "Likely source: your local network",
  shared: "Likely source: your connection or ISP",
  "own-path": "Likely source: this monitor's path",
  unknown: null,
}

const TILE = "flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4"

function Tile({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={TILE}>
      <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
        {title}
      </h3>
      {children}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-xs tabular-nums text-foreground">{children}</dd>
    </div>
  )
}

const count = (value: number) => value.toLocaleString()
const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`

/** A moment, with the day as well when the period runs over more than one. */
function moment(timestamp: number, longPeriod: boolean): string {
  return new Date(timestamp).toLocaleString(
    [],
    inDisplayZone(longPeriod ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" })
  )
}

function PatternTile({ analysis, unit, longPeriod }: { analysis: LossAnalysis; unit: string; longPeriod: boolean }) {
  const pattern = PATTERN[analysis.pattern === "none" ? "scattered" : analysis.pattern]
  return (
    <Tile icon={<Activity size={15} strokeWidth={1.75} />} title={`Pattern: ${pattern.label.toLowerCase()}`}>
      <p className="text-sm leading-relaxed text-muted-foreground">{pattern.says(unit)}</p>
      <dl className="divide-y divide-border border-t border-border">
        {analysis.packets && (
          <>
            <Fact label="Packets lost">
              {count(analysis.packets.lost)} of {count(analysis.packets.sent)}
            </Fact>
            <Fact label="Single-packet losses">
              {count(analysis.packets.singlePacketProbes)} of {count(analysis.affectedProbes)} probes
            </Fact>
          </>
        )}
        {analysis.spells > 0 && analysis.longest && (
          <Fact label={analysis.spells === 1 ? "Burst" : `Longest of ${analysis.spells} bursts`}>
            {humanDuration(analysis.longest.durationMs)} at {moment(analysis.longest.start, longPeriod)}
          </Fact>
        )}
        {analysis.worst && (
          <Fact label="Worst probe">
            {analysis.worst.loss.toFixed(0)}% at {moment(analysis.worst.at, longPeriod)}
          </Fact>
        )}
        {analysis.failedProbes > 0 && (
          <Fact label="No reply">
            <span className="text-destructive">{count(analysis.failedProbes)} probes</span>
          </Fact>
        )}
      </dl>
    </Tile>
  )
}

/**
 * The period folded into one day. Loss that comes every evening at the same
 * hour is congestion at the busy hour, and this is the only place it shows.
 */
/** A share of probes, as a percentage worth reading: "16.7%", "0.8%", "100%". */
function percent(share: number): string {
  const value = share * 100
  return `${value >= 10 || value === 0 ? value.toFixed(0) : value.toFixed(1)}%`
}

/** What one hour's bar says when pointed at. */
function HourTip({ hour, peak, unit }: { hour: LossAnalysis["hours"][number]; peak: boolean; unit: string }) {
  const span = `${hourLabel(hour.hour)}–${hourLabel((hour.hour + 1) % 24)}`
  return (
    <span className="block space-y-0.5 text-left">
      <span className="block font-medium">{span}{peak && " · peak hour"}</span>
      {hour.probes === 0 ? (
        <span className="block">No probes in this hour</span>
      ) : (
        <>
          <span className="block">
            {count(hour.affected)} of {count(hour.probes)} probes lost {unit}
          </span>
          <span className="block">{percent(hour.affected / hour.probes)} of this hour&apos;s probes</span>
        </>
      )}
    </span>
  )
}

function HoursTile({ analysis, unit }: { analysis: LossAnalysis; unit: string }) {
  const share = (hour: LossAnalysis["hours"][number]) => (hour.probes > 0 ? hour.affected / hour.probes : 0)
  const highest = Math.max(...analysis.hours.map(share), 0)
  const covered = analysis.hours.filter(hour => hour.probes > 0).length

  return (
    <Tile icon={<Clock3 size={15} strokeWidth={1.75} />} title="By hour of day">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-muted-foreground">
          <span>Probes with loss, by hour</span>
          {highest > 0 && <span className="font-mono">max {percent(highest)}</span>}
        </div>
        {/* The bars are scaled to the worst hour, whose share is the top line. */}
        <div className="relative h-24 border-b border-border">
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-border" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-border/60" aria-hidden="true" />
          <div className="absolute inset-0 grid grid-cols-24 gap-0.5">
            {analysis.hours.map(hour => {
              const height = highest > 0 ? (share(hour) / highest) * 100 : 0
              const peak = hour.hour === analysis.busiestHour
              return (
                <Tooltip key={hour.hour} content={<HourTip hour={hour} peak={peak} unit={unit} />}>
                  {/* The whole column answers the pointer, not only the bar, so a short bar is as easy to point at. */}
                  <div
                    tabIndex={0}
                    aria-label={hour.probes === 0
                      ? `${hourLabel(hour.hour)}: no probes`
                      : `${hourLabel(hour.hour)}: ${hour.affected} of ${hour.probes} probes lost ${unit}`}
                    className="group flex h-full items-end rounded-t-sm outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
                  >
                    <div
                      className={cn("w-full rounded-t-sm transition-opacity group-hover:opacity-80", hour.probes === 0 && "border-t border-dashed border-muted-foreground/40")}
                      style={{
                        height: hour.affected > 0 ? `${Math.max(4, height)}%` : "2px",
                        backgroundColor: hour.probes === 0
                          ? "transparent"
                          : hour.affected === 0 ? "var(--color-muted)" : peak ? "var(--signal-moderate)" : "var(--signal-minor)",
                      }}
                    />
                  </div>
                </Tooltip>
              )
            })}
          </div>
        </div>
        {/* A label at the start of every third hour, under the bar it names. */}
        <div className="mt-1.5 grid grid-cols-8 font-mono text-[10px] text-muted-foreground" aria-hidden="true">
          {[0, 3, 6, 9, 12, 15, 18, 21].map(hour => <span key={hour}>{String(hour).padStart(2, "0")}</span>)}
        </div>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {covered < 12
          ? "Less than a day of data. Pick 24h or longer to see whether the loss follows the time of day."
          : analysis.busiestHour !== null
            ? <>Peaks around <span className="font-mono text-foreground">{hourLabel(analysis.busiestHour)}</span>. Loss at the same hour each day usually means congestion at peak times.</>
            : "No peak hour: the loss is spread across the day."}
      </p>
    </Tile>
  )
}

/** What the other targets' loss at the same time says about where it starts. */
function verdict(analysis: LossAnalysis, unit: string): ReactNode {
  const sharing = analysis.sameMoments.filter(each => each.significant)
  const names = (list: typeof sharing) => {
    const shown = list.slice(0, 2).map(each => each.name)
    return list.length > 2 ? `${shown.join(", ")} and others` : shown.join(" and ")
  }
  const lead = (text: string) => <strong className="font-medium text-foreground">{text}</strong>

  switch (analysis.source) {
    case "local":
      return <>{lead("Likely source: your local network.")} {names(sharing.filter(each => each.local))} lost {unit} at the same time. Check Wi-Fi, cabling, switch ports and the router.</>
    case "shared":
      return analysis.comparedWithLocal
        ? <>{lead("Likely source: your connection or ISP.")} {names(sharing)} lost {unit} at the same time, and nothing on your local network did.</>
        : <>{lead(`Shared with ${names(sharing)}.`)} The fault is on the part of the path they have in common. Add a target for your router to tell your own network from your ISP.</>
    case "own-path":
      return <>{lead("Likely source: this monitor's path.")} No other monitor lost {unit} at the same time more often than chance, so the fault is past the point where the paths split.</>
    default:
      return analysis.sameMoments.length === 0
        ? <>No other monitors to compare with. Add your router and a public address such as 1.1.1.1 to locate the fault.</>
        : <>Not enough loss to correlate with other monitors yet.</>
  }
}

function CorrelationTile({ analysis, unit }: { analysis: LossAnalysis; unit: string }) {
  return (
    <Tile icon={<Network size={15} strokeWidth={1.75} />} title="Other monitors at the same time">
      {analysis.sameMoments.length > 0 && (
        <ul className="space-y-2.5">
          {analysis.sameMoments.map(each => (
            <li key={each.targetId} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-foreground" title={each.host}>{each.name}</span>
                  {each.local && (
                    <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">Local</span>
                  )}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                  {count(each.shared)} of {count(analysis.affectedProbes)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${analysis.affectedProbes > 0 ? (each.shared / analysis.affectedProbes) * 100 : 0}%`,
                    backgroundColor: each.significant ? "var(--signal-moderate)" : "var(--text-secondary)",
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-auto rounded-xl bg-muted/60 p-3 text-sm leading-relaxed text-muted-foreground">{verdict(analysis, unit)}</p>
    </Tile>
  )
}

export function LossBreakdown({
  targetId,
  zoom,
  hours,
  family,
  probe,
  refreshKey,
  vocabulary,
}: {
  targetId: string
  /** The period on screen: a zoomed window, or the last `hours`. */
  zoom: TimeWindow | null
  hours: number
  family: AddressFamily | null
  /** The probe it is looked at from; the monitor's first when left out. */
  probe?: string
  /** Changes when a new reading arrives, which is when the analysis is read again. */
  refreshKey?: number
  vocabulary: ProbeVocabulary
}) {
  const [loaded, setLoaded] = useState<{ key: string; analysis: LossAnalysis } | null>(null)
  const [failed, setFailed] = useState(false)

  const query = new URLSearchParams(zoom ? { start: String(zoom.start), end: String(zoom.end) } : { hours: String(hours) })
  if (family) query.set("family", String(family))
  if (probe) query.set("probe", probe)
  const key = `${targetId}?${query}`

  useEffect(() => {
    const controller = new AbortController()
    const asked = new URLSearchParams(key.slice(key.indexOf("?") + 1))
    // The hours are told on the clock the page shows times in.
    asked.set("tz", displayTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone)

    fetch(`/api/targets/${targetId}/loss?${asked}`, { signal: controller.signal })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`Server responded ${response.status}`))))
      .then((analysis: LossAnalysis) => {
        setLoaded({ key, analysis })
        setFailed(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [key, targetId, refreshKey])

  // What was read for another period is not shown for this one.
  const analysis = loaded?.key === key ? loaded.analysis : null
  if (analysis && analysis.pattern === "none") return null

  const pattern = analysis && analysis.pattern !== "none" ? PATTERN[analysis.pattern] : null
  const longPeriod = (zoom ? zoom.end - zoom.start : hours * 3_600_000) > 86_400_000
  const summary = analysis && pattern
    ? [`${count(analysis.affectedProbes)} of ${count(analysis.probes)} probes with loss`, pattern.label, SOURCE[analysis.source]].filter(Boolean).join(" · ")
    : failed ? "Could not analyse the loss" : "Analysing…"

  return (
    <ExpandableCard
      title="Packet loss analysis"
      description={summary}
      leading={
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: pattern?.color ?? "var(--signal-none)" }}
          aria-hidden="true"
        />
      }
    >
      {analysis ? (
        <div className="@container/loss">
          <div className="grid gap-4 @3xl/loss:grid-cols-3">
            <PatternTile analysis={analysis} unit={vocabulary.unit} longPeriod={longPeriod} />
            <HoursTile analysis={analysis} unit={vocabulary.unit} />
            <CorrelationTile analysis={analysis} unit={vocabulary.unit} />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              A traceroute shows which hop the loss starts at, if it is happening while the trace runs.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => document.getElementById("route")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              <Route size={14} strokeWidth={1.75} aria-hidden="true" />
              Go to traceroute
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{failed ? "Could not analyse the loss." : "Analysing…"}</p>
      )}
    </ExpandableCard>
  )
}
