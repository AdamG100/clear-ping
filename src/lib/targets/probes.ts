import { LOCAL_PROBE, type ProbeId } from '@/types/probe-agent';
import type { Target, TargetProbe } from '@/types/probe';

/**
 * Which probes a monitor is measured from, as pure helpers the page, the API
 * and the scheduler share. Where they are kept is `targets/store.ts`.
 */

/** The probe a stored `probe_agent_id` names: none is the local probe. */
export function probeOf(agentId: string | null | undefined): ProbeId {
  return agentId ?? LOCAL_PROBE;
}

/** The value `targets.probe_agent_id` holds for a probe: the local probe is none. */
export function agentIdOf(probe: ProbeId): string | null {
  return probe === LOCAL_PROBE ? null : probe;
}

/**
 * The probes a monitor is measured from now, primary first. A monitor built by
 * hand, with no list, is measured from its `probeAgentId` alone.
 */
export function probesOf(target: Pick<Target, 'probes' | 'probeAgentId'>): TargetProbe[] {
  const active = (target.probes ?? []).filter(probe => !probe.former);
  if (active.length > 0) return [...active].sort((a, b) => a.position - b.position);
  return [{ id: probeOf(target.probeAgentId), position: 0 }];
}

/** Just their ids, primary first. */
export function probeIdsOf(target: Pick<Target, 'probes' | 'probeAgentId'>): ProbeId[] {
  return probesOf(target).map(probe => probe.id);
}

/** The probe a monitor opens on: the first it was given. */
export function primaryProbeOf(target: Pick<Target, 'probes' | 'probeAgentId'>): ProbeId {
  return probesOf(target)[0].id;
}

/**
 * Every probe a monitor has readings from or takes them with: those it is
 * measured from, and any it was before and still has readings of.
 */
export function knownProbeIdsOf(target: Pick<Target, 'probes' | 'probeAgentId'>): ProbeId[] {
  return [...new Set([...(target.probes ?? []).map(probe => probe.id), probeOf(target.probeAgentId)])];
}

/**
 * The probe a request asks for, when the monitor has (or had) it, and else its
 * primary probe: what an endpoint answers with when it is not told which.
 */
export function chosenProbe(target: Pick<Target, 'probes' | 'probeAgentId'>, requested: string | null | undefined): ProbeId {
  return requested && knownProbeIdsOf(target).includes(requested) ? requested : primaryProbeOf(target);
}

/** Whether two lists name the same probes, in the same order. */
export function sameProbes(a: ProbeId[], b: ProbeId[]): boolean {
  return a.length === b.length && a.every((probe, index) => probe === b[index]);
}

/**
 * Check the probes an API caller named: a list of at least one, each a string,
 * none twice. Whether each exists is for the caller to check against the probe
 * agents there are.
 */
export function parseProbeIds(value: unknown): { ok: true; probes: ProbeId[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'probes must be a list of at least one probe' };
  if (!value.every(entry => typeof entry === 'string' && entry.trim() !== '')) {
    return { ok: false, error: 'probes must be probe ids: "local", or a probe agent’s id' };
  }
  const probes = [...new Set(value.map(entry => (entry as string).trim()))];
  return { ok: true, probes };
}
