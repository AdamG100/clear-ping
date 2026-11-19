import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { probeAgentInstall } from '@/lib/probe-agents/install';
import { getProbeAgent, renewProbeAgentToken } from '@/lib/probe-agents/store';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';
import { eitherNames } from '@/lib/targets/monitor-names';

/**
 * POST /api/security/probe-agents/:id/token - Make a new token for a probe agent
 *
 * For a token that was lost, or may have been seen. The old one stops being
 * sent at once, so the agent is refused until it is restarted with the new
 * one, which is in the answer and nowhere else.
 */
async function handlePOST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const { id } = await params;
  const token = await renewProbeAgentToken(id);
  if (!token) return NextResponse.json({ error: 'No such probe agent' }, { status: 404 });

  const probeAgent = await getProbeAgent(id);
  await recordActivity(user, 'dashboard', 'probe-agent.token', probeAgent?.name ?? id);
  return NextResponse.json({ probeAgent, token, install: probeAgentInstall() });
}

// Either name for a monitor in, both out (see monitor-names.ts).
export const POST = eitherNames(handlePOST)
