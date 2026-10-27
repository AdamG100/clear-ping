import { randomUUID } from 'crypto';
import type { ProbeMeasurement, ProbeResult, Target, TargetDefinition } from '@/types/probe';
import { createTarget, getAllTargets, setResolvedAddress, storeMeasurement } from '../db/database';
import { runProbes } from '../probe-agents/client';
import { measurementFrom, worstOf } from '../probes/result';
import { getScheduler } from '../scheduler';

/**
 * Things done to targets that more than one door leads to.
 *
 * A list of targets arrives from a share link through the API and from an
 * assistant through the MCP server, and a probe is asked for now from the
 * page and from an assistant alike. What happens is here, once, so that
 * neither door does it a little differently from the other.
 */

/**
 * Add targets that have already been checked, after everything that is here
 * already and in the order given. They are probed from the scheduler's next
 * pass, which this brings on.
 */
export async function addTargets(
  definitions: TargetDefinition[],
  options: { probeAgentId?: string | null } = {}
): Promise<Target[]> {
  const existing = await getAllTargets();
  let sortOrder = Math.max(-1, ...existing.map(target => target.sortOrder ?? 0)) + 1;

  const created: Target[] = [];
  for (const definition of definitions) {
    created.push(
      await createTarget({
        id: randomUUID(),
        ...definition,
        status: 'active',
        sortOrder: sortOrder++,
        probeAgentId: options.probeAgentId ?? null,
      })
    );
  }

  // Once, for all of them.
  await getScheduler().reloadTargets();
  return created;
}

export interface ProbedNow {
  /** The round as a whole, which for a target probed over both families is the worse of the two. */
  result: ProbeResult;
  /** One result, or one for each address family. */
  results: ProbeResult[];
  measurements: ProbeMeasurement[];
}

/**
 * Probe a target now, outside its schedule, and keep the reading like any
 * other. From its probe agent if it has one; a ProbeAgentUnavailableError
 * means nothing was taken or kept.
 */
export async function probeNow(target: Target): Promise<ProbedNow> {
  const startedAt = Date.now();
  const results = await runProbes(target);
  // Counts as this interval's reading, so the scheduled one is not taken too.
  getScheduler().noteProbed(target.id, startedAt);
  const measurements = results.map(result => measurementFrom(randomUUID(), result));

  for (const measurement of measurements) {
    await storeMeasurement(measurement);
  }

  const result = worstOf(results);
  if (result.resolvedAddress) {
    await setResolvedAddress(target.id, result.resolvedAddress);
  }

  return { result, results, measurements };
}
