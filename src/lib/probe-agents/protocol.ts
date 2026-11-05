import type { ProbeIpVersion, ProbeResult, Traceroute } from '@/types/probe';
import { isIpVersion, isValidHost, normalizeHost } from '../probes/host';
import { isProbeType, validateProbeConfig } from '../probes/config';
import type { ProbeTarget } from '../probes/probe';

/**
 * What a probe agent and the dashboard say to each other.
 *
 * A probe agent is a small program on another machine (a VPS abroad, a box in
 * the office) that takes readings from there when the dashboard asks. The
 * dashboard connects to it, over HTTPS with a pinned certificate and a token,
 * and it runs the very same probe code the dashboard runs locally.
 *
 * Shared by both ends, so it imports nothing either end lacks: no database,
 * no Next.js, no sign-in.
 */

/** Raised when what the routes take or give changes, so each end can tell the other is out of date. */
export const PROBE_AGENT_PROTOCOL = 1;

export const PROBE_AGENT_DEFAULT_PORT = 7380;

/** Tokens look like `cpa_` and 43 characters, so one can be recognised wherever it ends up. */
export const PROBE_AGENT_TOKEN_PREFIX = 'cpa_';

/** Shorter than this is not a token the dashboard made, and too easy to guess. */
export const PROBE_AGENT_MIN_TOKEN_LENGTH = 32;

/** Largest request body a probe agent reads. A probe request is a few hundred bytes. */
export const PROBE_AGENT_MAX_BODY_BYTES = 64 * 1024;

export interface ProbeAgentInfo {
  version: string;
  protocol: number;
  hostname: string;
  platform: string;
  arch: string;
  /**
   * Whether the programs some probes run are installed there. `arping` is
   * only needed for ARP monitors, and is not said at all by a probe agent from
   * before ARP probes.
   */
  tools: { ping: boolean; traceroute: boolean; arping?: boolean };
}

export interface ProbeAgentProbeRequest {
  target: ProbeTarget;
}

export interface ProbeAgentTraceRequest {
  target: { id: string; host: string };
  ipVersion: ProbeIpVersion;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A probe request as the probe agent receives it, checked as strictly as the
 * dashboard checks a target before storing it. The token says who is asking;
 * this makes sure what they ask for is something a probe can do.
 */
export function readProbeRequest(raw: unknown): Checked<ProbeAgentProbeRequest> {
  const target = (raw as { target?: Record<string, unknown> } | null)?.target;
  if (!target || typeof target !== 'object') return { ok: false, error: 'No target' };

  const { id, host, probeType, ipVersion } = target;
  if (typeof id !== 'string' || !id || id.length > 100) return { ok: false, error: 'Invalid target id' };
  if (typeof host !== 'string' || !isValidHost(host)) return { ok: false, error: 'Invalid host' };
  if (!isProbeType(probeType)) return { ok: false, error: 'Invalid probe type' };
  if (ipVersion !== undefined && !isIpVersion(ipVersion)) return { ok: false, error: 'Invalid IP version' };

  const config = validateProbeConfig(probeType, host, target.probeConfig);
  if (!config.ok) return config;

  return {
    ok: true,
    value: {
      target: {
        id,
        host: normalizeHost(host),
        probeType,
        ipVersion: ipVersion ?? 'auto',
        probeConfig: config.config,
      },
    },
  };
}

export function readTraceRequest(raw: unknown): Checked<ProbeAgentTraceRequest> {
  const body = (raw ?? {}) as { target?: { id?: unknown; host?: unknown }; ipVersion?: unknown };
  const id = body.target?.id;
  const host = body.target?.host;
  if (typeof id !== 'string' || !id || id.length > 100) return { ok: false, error: 'Invalid target id' };
  if (typeof host !== 'string' || !isValidHost(host)) return { ok: false, error: 'Invalid host' };
  const ipVersion = body.ipVersion ?? 'auto';
  if (ipVersion !== 'auto' && ipVersion !== 'ipv4' && ipVersion !== 'ipv6') {
    return { ok: false, error: 'Invalid IP version' };
  }
  return { ok: true, value: { target: { id, host: normalizeHost(host) }, ipVersion } };
}

function dateOf(value: unknown): Date | null {
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Results as they arrive over JSON, with their dates made dates again. Null for anything that is not results. */
export function reviveResults(raw: unknown): ProbeResult[] | null {
  const results = (raw as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length === 0 || results.length > 2) return null;

  const revived: ProbeResult[] = [];
  for (const result of results as Record<string, unknown>[]) {
    const timestamp = dateOf(result?.timestamp);
    if (!timestamp || typeof result.success !== 'boolean' || typeof result.targetId !== 'string') return null;
    revived.push({ ...(result as unknown as ProbeResult), timestamp });
  }
  return revived;
}

export function reviveTrace(raw: unknown): Traceroute | null {
  const trace = raw as Record<string, unknown> | null;
  const timestamp = dateOf(trace?.timestamp);
  if (!trace || !timestamp || typeof trace.id !== 'string' || !Array.isArray(trace.hops)) return null;
  return { ...(trace as unknown as Traceroute), timestamp };
}

export function isProbeAgentInfo(raw: unknown): raw is ProbeAgentInfo {
  const info = raw as Partial<ProbeAgentInfo> | null;
  return !!info && typeof info.version === 'string' && typeof info.protocol === 'number' && typeof info.hostname === 'string';
}
