import { NextRequest, NextResponse } from 'next/server';
import { setGroupProbes } from '@/lib/db/database';
import { normalizeGroupPath } from '@/lib/targets/group-path';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';
import { probeNames, readRequestedProbes } from '@/lib/probe-agents/probes';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

/**
 * PUT /api/groups/probe - Probe every target in a group from one place
 * Body: { group: string, probes: string[] } (or the older probeAgentId, one place)
 *
 * Probes are "local" for this server, or probe agent ids. Targets in groups inside this one move
 * too. Readings already taken stay where they were taken from.
 */
export async function PUT(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json();
    const group = normalizeGroupPath(typeof body.group === 'string' ? body.group : '');
    if (!group) {
      return NextResponse.json({ error: 'Which group to change is required' }, { status: 400 });
    }

    const from = await readRequestedProbes(body);
    if (!from.ok) return NextResponse.json({ error: from.error }, { status: 400 });
    if (from.probes === undefined) {
      return NextResponse.json({ error: 'probes is a list of probe ids, with "local" for this server' }, { status: 400 });
    }

    const updated = await setGroupProbes(group, from.probes);
    await getScheduler().reloadTargets();

    const names = await probeNames(from.probes);
    const place = from.probes.map(probe => names.get(probe)).join(', ');
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'group.probe', `${group}: ${updated} measured from ${place}`);

    return NextResponse.json({ updated });
  } catch (error) {
    console.error('Error switching a group’s probe:', error);
    return NextResponse.json({ error: 'Failed to switch where the group is probed from' }, { status: 500 });
  }
}
