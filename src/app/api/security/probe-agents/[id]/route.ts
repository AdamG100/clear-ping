import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { resolveExposure } from '@/lib/probe-agents/client';
import { readProbeAgentAddress, readProbeAgentName, readProbeAgentPort } from '@/lib/probe-agents/input';
import {
  deleteProbeAgent,
  getProbeAgent,
  probeAgentNameTaken,
  targetsUsingProbeAgent,
  unpinProbeAgentCertificate,
  updateProbeAgent,
  type NewProbeAgent,
} from '@/lib/probe-agents/store';
import { getScheduler } from '@/lib/scheduler';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * PATCH /api/security/probe-agents/:id - Rename a probe agent, or change where it is
 * Body: any of { name, address, port }
 *
 * A probe agent moved to another address keeps its pinned certificate: it is
 * the same agent, reached another way, and must still prove it.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const { id } = await params;
  const existing = await getProbeAgent(id);
  if (!existing) return NextResponse.json({ error: 'No such probe agent' }, { status: 404 });

  const body = (await request.json().catch(() => null)) ?? {};
  const changes: Partial<NewProbeAgent> = {};

  if (body.name !== undefined) {
    const name = readProbeAgentName(body.name);
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
    if (await probeAgentNameTaken(name.value, id)) {
      return NextResponse.json({ error: `There is already a probe agent called ${name.value}` }, { status: 409 });
    }
    changes.name = name.value;
  }
  if (body.address !== undefined) {
    const address = readProbeAgentAddress(body.address);
    if (!address.ok) return NextResponse.json({ error: address.error }, { status: 400 });
    changes.address = address.value;
    changes.exposure = await resolveExposure(address.value);
  }
  if (body.port !== undefined) {
    const port = readProbeAgentPort(body.port);
    if (!port.ok) return NextResponse.json({ error: port.error }, { status: 400 });
    changes.port = port.value;
  }

  const probeAgent = await updateProbeAgent(id, changes);
  await recordActivity(user, 'dashboard', 'probe-agent.change', `${probeAgent?.name ?? id}: ${Object.keys(changes).filter(key => key !== 'exposure').join(', ')}`);
  return NextResponse.json({ probeAgent });
}

/**
 * DELETE /api/security/probe-agents/:id - Remove a probe agent
 *
 * Refused while any target is probed from it, with their names: those have to
 * be moved or deleted first, so no target quietly starts measuring from
 * somewhere else.
 *
 * DELETE /api/security/probe-agents/:id?certificate=1 - Forget its certificate
 * instead, so the next connection pairs afresh.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const { id } = await params;
  const existing = await getProbeAgent(id);
  if (!existing) return NextResponse.json({ error: 'No such probe agent' }, { status: 404 });

  if (new URL(request.url).searchParams.get('certificate')) {
    await unpinProbeAgentCertificate(id);
    await recordActivity(user, 'dashboard', 'probe-agent.forget', existing.name);
    return NextResponse.json({ probeAgent: await getProbeAgent(id) });
  }

  const targets = await targetsUsingProbeAgent(id);
  if (targets.length > 0) {
    return NextResponse.json(
      {
        error: `${targets.length === 1 ? 'A monitor is' : `${targets.length} monitors are`} measured by ${existing.name}: ${targets.join(', ')}. Untick ${existing.name} under Probes in ${targets.length === 1 ? 'its' : 'their'} settings, or delete ${targets.length === 1 ? 'it' : 'them'}, first. Their readings from it are kept.`,
        targets,
      },
      { status: 409 }
    );
  }

  await deleteProbeAgent(id);
  await getScheduler().reloadTargets();
  await recordActivity(user, 'dashboard', 'probe-agent.remove', existing.name);
  return NextResponse.json({ deleted: true });
}
