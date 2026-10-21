import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { resolveExposure } from '@/lib/probe-agents/client';
import { readProbeAgentInput } from '@/lib/probe-agents/input';
import { probeAgentInstall } from '@/lib/probe-agents/install';
import { createProbeAgent, listProbeAgents, probeAgentNameTaken } from '@/lib/probe-agents/store';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * GET /api/security/probe-agents - Every probe agent, with how it is doing,
 * and where to install one from.
 */
export async function GET(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  return NextResponse.json({ probeAgents: await listProbeAgents(), install: probeAgentInstall() });
}

/**
 * POST /api/security/probe-agents - Add a probe agent
 * Body: { name, address, port? }
 *
 * The token the agent is to be started with is in the answer and nowhere
 * else, ever; a lost one is replaced, not shown again.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const input = readProbeAgentInput(await request.json().catch(() => null));
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  if (await probeAgentNameTaken(input.value.name)) {
    return NextResponse.json({ error: `There is already a probe agent called ${input.value.name}` }, { status: 409 });
  }

  const { probeAgent, token } = await createProbeAgent({ ...input.value, exposure: await resolveExposure(input.value.address) });
  await recordActivity(user, 'dashboard', 'probe-agent.add', `${probeAgent.name} (${probeAgent.address}:${probeAgent.port})`);
  return NextResponse.json({ probeAgent, token, install: probeAgentInstall() }, { status: 201 });
}
