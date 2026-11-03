import type { AlertScopeEntry } from '@/types/alert-rules';
import type { ProbeId } from '@/types/probe-agent';
import { isWithinGroup } from '../targets/group-path';

/**
 * Where an alert applies, worked out when a reading is judged so that a monitor
 * added to a group later is covered without anyone editing the
 * alert.
 */

export const SCOPE_KINDS = ['monitor', 'group', 'probe'] as const;

export function isScopeEntry(value: unknown): value is AlertScopeEntry {
  const entry = value as Partial<AlertScopeEntry> | null;
  return !!entry && (SCOPE_KINDS as readonly string[]).includes(entry.kind as string) && typeof entry.ref === 'string' && entry.ref !== '';
}

/**
 * The probes of a monitor an alert covers: every probe a monitor entry or its
 * group names, and the probe a probe entry
 * names where the monitor has it. Narrowed to the alert's own list of probes
 * when it has one. Empty when the alert does not apply to the monitor at all.
 */
export function coveredProbes(
  scope: readonly AlertScopeEntry[],
  alertProbes: readonly ProbeId[] | null | undefined,
  target: { id: string; group?: string },
  targetProbes: readonly ProbeId[]
): ProbeId[] {
  const covered = new Set<ProbeId>();
  for (const entry of scope) {
    if (entry.kind === 'monitor' && entry.ref === target.id) targetProbes.forEach(probe => covered.add(probe));
    else if (entry.kind === 'group' && target.group && isWithinGroup(target.group, entry.ref)) targetProbes.forEach(probe => covered.add(probe));
    else if (entry.kind === 'probe' && targetProbes.includes(entry.ref)) covered.add(entry.ref);
  }
  return targetProbes.filter(probe => covered.has(probe) && (!alertProbes || alertProbes.includes(probe)));
}
