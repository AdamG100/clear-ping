import { randomUUID } from 'crypto';
import type { ProbeMeasurement, ProbeResult, Target, TargetDefinition } from '@/types/probe';
import { createTarget, getAllTargets, setResolvedAddress, storeMeasurement } from '../db/database';
import { runProbes } from '../probe-agents/client';
import { measurementFrom, worstOf } from '../probes/result';
import { getScheduler } from '../scheduler';
import { agentIdOf, primaryProbeOf, probeOf } from './probes';
import { recordPairRound } from './store';
import type { ProbeId } from '@/types/probe-agent';

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
  definitions: (TargetDefinition & { probes?: ProbeId[] })[],
  options: { probeAgentId?: string | null; probes?: ProbeId[] } = {}
): Promise<Target[]> {
  const existing = await getAllTargets();
  let sortOrder = Math.max(-1, ...existing.map(target => target.sortOrder ?? 0)) + 1;

  // Where they are measured from: the probes named, or the one probe agent an older caller names.
  const probes = options.probes?.length ? options.probes : [probeOf(options.probeAgentId)];
  const created: Target[] = [];
  for (const { probes: own, ...definition } of definitions) {
    // A monitor that names its own probes, as one imported from a file does, keeps them.
    const these = own?.length ? own : probes;
    created.push(
      await createTarget({
        id: randomUUID(),
        ...definition,
        status: 'active',
        sortOrder: sortOrder++,
        probeAgentId: agentIdOf(these[0]),
        probes: these.map((id, position) => ({ id, position })),
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
export async function probeNow(target: Target, probes: ProbeId[] = [primaryProbeOf(target)]): Promise<ProbedNow> {
  // One round from each probe asked for, side by side; the first to fail
  // because its probe agent is down says so, and nothing is kept for any.
  const rounds = await Promise.all(
    probes.map(async probe => {
      const startedAt = Date.now();
      return { probe, startedAt, results: await runProbes(target, probe) };
    })
  );

  const all: ProbeResult[] = [];
  const measurements: ProbeMeasurement[] = [];
  for (const { probe, startedAt, results } of rounds) {
    // Counts as this interval's reading, so the scheduled one is not taken too.
    getScheduler().noteProbed(target.id, startedAt, probe);
    const stored = results.map(result => measurementFrom(randomUUID(), result));
    for (const measurement of stored) await storeMeasurement(measurement);
    await recordPairRound(
      target.id,
      probe,
      startedAt,
      results.flatMap(result => (result.resolvedAddress ? [{ family: result.family, address: result.resolvedAddress }] : []))
    );

    const resolved = worstOf(results).resolvedAddress;
    if (resolved && probe === primaryProbeOf(target)) await setResolvedAddress(target.id, resolved);
    all.push(...results);
    measurements.push(...stored);
  }

  return { result: worstOf(all), results: all, measurements };
}
