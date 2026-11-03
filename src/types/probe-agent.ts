/**
 * Probe agents as the dashboard sees them. A probe agent is a small program on
 * another machine that takes readings from there; it has nothing to do with AI
 * agents or the assistant.
 */

/** Where readings are taken from: 'local' for the dashboard's own probe, otherwise a probe agent's id. */
export type ProbeId = string;

/** The dashboard's own probe: readings taken from the machine it runs on. */
export const LOCAL_PROBE: ProbeId = 'local';

/** What the local probe is called until it is renamed in Settings. */
export const DEFAULT_LOCAL_PROBE_NAME = 'Local probe';

/**
 * - `unpaired`: added, but never connected to yet
 * - `online`: answered the last time it was asked
 * - `offline`: could not be reached; its targets take no readings meanwhile
 * - `cert-changed`: answered with a certificate other than the pinned one
 * - `token-rejected`: reached, but it refused the token
 * - `outdated`: speaks a different protocol version from this dashboard
 */
export type ProbeAgentState = 'unpaired' | 'online' | 'offline' | 'cert-changed' | 'token-rejected' | 'outdated';

/** How the dashboard reaches it: over a tailnet, a private network, or the open internet. */
export type ProbeAgentExposure = 'tailnet' | 'private' | 'public';

/** What anyone who can see targets may know about the probe agent one is probed from. */
export interface ProbeAgentSummary {
  id: string;
  name: string;
  state: ProbeAgentState;
  exposure: ProbeAgentExposure;
  address: string;
  /** The machine's own name, as it reported it. */
  hostname?: string;
  lastSeenAt?: number;
}

/**
 * A place readings are taken from, as the dashboard lists it: the local probe
 * first, then each probe agent. The local probe is always online.
 */
export interface ProbeSummary {
  id: ProbeId;
  name: string;
  /** The dashboard's own probe. */
  local: boolean;
  state: ProbeAgentState;
  exposure?: ProbeAgentExposure;
  address?: string;
  hostname?: string;
  lastSeenAt?: number;
}

/** Everything about a probe agent, for whoever manages them. Never the token. */
export interface ProbeAgent extends ProbeAgentSummary {
  port: number;
  /** SHA-256 of the pinned certificate. */
  fingerprint?: string;
  /** SHA-256 of a different certificate it presented, awaiting trust. */
  offeredFingerprint?: string;
  lastError?: string;
  version?: string;
  platform?: string;
  tools?: { ping: boolean; traceroute: boolean };
  createdAt: number;
  updatedAt: number;
  targetCount: number;
}

/** A stretch when a probe agent could not be reached. `end` is null while it lasts. */
export interface ProbeAgentOutage {
  start: number;
  end: number | null;
}
