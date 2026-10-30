import { NextRequest, NextResponse } from 'next/server';
import { setGroupProbeAgent } from '@/lib/db/database';
import { normalizeGroupPath } from '@/lib/targets/group-path';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';
import { listProbeAgentSummaries, readProbeAgentChoice } from '@/lib/probe-agents/store';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

/**
 * PUT /api/groups/probe - Probe every target in a group from one place
 * Body: { group: string, probeAgentId: string | null }
 *
 * `probeAgentId` null is this server. Targets in groups inside this one move
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

    const from = await readProbeAgentChoice(body.probeAgentId);
    if (!from.ok) return NextResponse.json({ error: from.error }, { status: 400 });
    if (from.probeAgentId === undefined) {
      return NextResponse.json({ error: 'probeAgentId is a probe agent id, or null for this server' }, { status: 400 });
    }

    const updated = await setGroupProbeAgent(group, from.probeAgentId);
    await getScheduler().reloadTargets();

    const names = new Map((await listProbeAgentSummaries()).map(agent => [agent.id, agent.name]));
    const place = from.probeAgentId ? names.get(from.probeAgentId) ?? 'a removed probe agent' : 'this server';
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'group.probe', `${group}: ${updated} probed from ${place}`);

    return NextResponse.json({ updated });
  } catch (error) {
    console.error('Error switching a group’s probe:', error);
    return NextResponse.json({ error: 'Failed to switch where the group is probed from' }, { status: 500 });
  }
}
