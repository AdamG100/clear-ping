import type { ProbeAgentOutage } from './probe-agent'

/** `outage`: a probe got no reply at all. `loss`: every probe got something back, and not everything. */
export type IncidentKind = 'outage' | 'loss'

/**
 * The overview: how everything has done over the last day, worked out on the
 * server from every reading in it. What is going on this minute (each
 * target's newest reading, the probe agents' states, the alerts) the dashboard
 * already has, and shows beside it.
 */

/** One target's day. */
export interface OverviewTarget {
  targetId: string
  probes: number
  /** Probes that got nothing back at all. */
  failedProbes: number
  /** Probes that got something back, and not everything. */
  lossyProbes: number
  /** Share of probes that got something back, 0-100. */
  uptimePercent: number
  /** Mean loss over every probe, one that got nothing back counting as 100. */
  lossPercent: number
  medianLatencyMs: number | null
}

/**
 * Where an event's fault lay, from what else was probed from the same place
 * while it went on:
 *
 * - `local`: something inside the network it is probed from failed too
 * - `single`: only this one target, while the others kept answering
 * - `beyond`: several targets out on the internet, while the network inside kept answering
 * - `unclear`: not enough was being watched to say
 */
export type OverviewEventScope = 'local' | 'single' | 'beyond' | 'unclear'

/** A target's part in an event. */
export interface OverviewEventTarget {
  targetId: string
  /** Its name, with the address family where it is probed over both and only one failed. */
  label: string
  kind: IncidentKind
  /** Why its probes failed, as they said it, most often said first. */
  reasons: string[]
}

/**
 * Targets that went wrong together: their incidents started within a probe
 * or two of each other, probed from the same place. One fault seen from many
 * targets is one event, not twenty.
 */
export interface OverviewEvent {
  /** Stable while the event lasts: where it was seen from, and when it began. */
  id: string
  /** Where it was seen from: a probe agent, or null for this server. */
  probeAgentId: string | null
  /** `outage` if any of them got no reply at all. */
  kind: IncidentKind
  start: number
  /** Null while it is still going on, or where the readings stopped before it was seen to end. */
  end: number | null
  ongoing: boolean
  durationMs: number
  targets: OverviewEventTarget[]
  /** How many targets probed from the same place were being probed while it went on, these among them. */
  watched: number
  scope: OverviewEventScope
}

/** A slice of the day, and how many targets did what in it. */
export interface OverviewSlice {
  start: number
  /** Targets probed at least once in it. */
  watched: number
  /** Of those, the ones with a probe that got nothing back. */
  down: number
  /** Of the rest, the ones that lost packets, queries or requests. */
  lossy: number
}

export interface OverviewReport {
  start: number
  end: number
  targets: OverviewTarget[]
  /** Oldest first. */
  events: OverviewEvent[]
  /** Spells of loss too short to list, counted. */
  briefLossSpells: number
  slices: OverviewSlice[]
  sliceMs: number
  /** By probe agent id: when each could not be reached. */
  probeAgentOutages: Record<string, ProbeAgentOutage[]>
}
