import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets, createTarget, deleteTargets, deleteEmptyGroups, getLatestMeasurementForAllTargets, getNeverAnswered, pruneEmptyGroups, getGroupOrders, getGroups, getRecentSeriesForAllTargets } from '@/lib/db/database';
import { isClosedPortCheck } from '@/lib/probes/config';
import { parentGroup } from '@/lib/targets/group-path';
import { randomUUID } from 'crypto';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';
import { validateTargetDefinition } from '@/lib/targets/definition';
import { listProbeAgentSummaries, readProbeAgentChoice } from '@/lib/probe-agents/store';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

export async function GET(request: NextRequest) {
  try {
    // Ensure server is initialized (starts scheduler on first request)
    await initializeServer();
    
    const { searchParams } = new URL(request.url);
    const includePacketLoss = searchParams.get('packetLoss') === 'true';
    
    const targets = await getAllTargets();
    
    if (includePacketLoss) {
      const [latest, groups, groupOrders, series, probeAgents, neverAnswered] = await Promise.all([
        getLatestMeasurementForAllTargets(),
        getGroups(),
        getGroupOrders(),
        getRecentSeriesForAllTargets(24),
        listProbeAgentSummaries(),
        getNeverAnswered(targets.filter(isClosedPortCheck).map(target => target.id)),
      ]);
      return NextResponse.json({
        // A closed-port check that has never had an answer can't measure its
        // server, and is shown that way rather than as down.
        targets: targets.map(target => (neverAnswered.has(target.id) ? { ...target, neverAnswered: true } : target)),
        latest,
        groups,
        groupOrders,
        series,
        // So each row can say where it is probed from, and whether that is up.
        probeAgents,
      });
    }
    
    return NextResponse.json(targets);
  } catch (error) {
    console.error('Error fetching targets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch targets' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Ensure server is initialized
    await initializeServer();
    
    const body = await request.json();
    const definition = validateTargetDefinition(body);
    if (!definition.ok) {
      return NextResponse.json({ error: definition.error }, { status: 400 });
    }
    // Where it is probed from belongs to this installation, not to what the
    // target is, so it is read beside the definition rather than in it.
    const from = await readProbeAgentChoice(body?.probeAgentId);
    if (!from.ok) return NextResponse.json({ error: from.error }, { status: 400 });

    const target = await createTarget({
      id: randomUUID(),
      ...definition.target,
      status: 'active',
      probeAgentId: from.probeAgentId ?? null,
    });
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'target.add', `${target.name} (${target.host})`);

    // Reload scheduler to pick up the new target immediately
    const scheduler = getScheduler();
    await scheduler.reloadTargets();

    return NextResponse.json(target, { status: 201 });
  } catch (error) {
    console.error('Error creating target:', error);
    return NextResponse.json(
      { error: 'Failed to create target' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/targets - Delete several targets at once
 *
 * `{ ids: [...] }` in the body, and nothing is deleted without it: a bare
 * DELETE of the whole collection is refused, so a request that lost its body
 * on the way cannot empty the list. An id that is not a target's is passed
 * over, which is what has happened when two people clear out the same list.
 *
 * `groups: [...]` alongside deletes those groups too, with the groups inside
 * them, once the targets are gone: each one that has no target left in it.
 * Given on its own, with no ids, it deletes groups that are already empty.
 */
export async function DELETE(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json().catch(() => null);
    const ids: unknown = body?.ids ?? [];
    const groups: unknown = body?.groups ?? [];
    const isList = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every(each => typeof each === 'string' && each);
    if (!isList(ids) || !isList(groups) || ids.length + groups.length === 0) {
      return NextResponse.json({ error: 'Say which targets to delete, as a list of their ids' }, { status: 400 });
    }

    const wanted = new Set(ids);
    const going = (await getAllTargets()).filter(target => wanted.has(target.id));
    const names = going.map(target => target.name);
    // Before the rows go, so no probe is started or stored for them meanwhile.
    getScheduler().forget([...wanted]);
    const deleted = await deleteTargets([...wanted]);
    // The groups chosen, then the ones left empty around them and around the
    // targets, nested ones included.
    const chosen = await deleteEmptyGroups(groups);
    const pruned = await pruneEmptyGroups([...going.map(target => target.group ?? ''), ...chosen]);
    const groupsRemoved = new Set([...chosen, ...pruned]);
    if (deleted > 0 || groupsRemoved.size > 0) {
      const { actor, via } = await actorFor(request);
      if (deleted > 0) await recordActivity(actor, via, 'target.delete', names.join(', '));
      // The groups inside one go without saying.
      const outermost = chosen.filter(group => !chosen.includes(parentGroup(group)));
      if (outermost.length > 0) await recordActivity(actor, via, 'group.delete', outermost.join(', '));
    }

    // Once, for all of them.
    if (deleted > 0) await getScheduler().reloadTargets();

    return NextResponse.json({ deleted, groupsRemoved: groupsRemoved.size });
  } catch (error) {
    console.error('Error deleting targets:', error);
    return NextResponse.json({ error: 'Failed to delete targets' }, { status: 500 });
  }
}
