import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { connectProbeAgent } from '@/lib/probe-agents/client';
import { getProbeAgent } from '@/lib/probe-agents/store';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * POST /api/security/probe-agents/:id/connect - Connect to a probe agent
 * Body, optional: { trust: true } to accept the new certificate it now presents
 *
 * The first time, this pairs: the certificate it presents is trusted from
 * then on, and its fingerprint is in the answer to compare with the one the
 * agent logged. After that it is a test. Either way the answer says how it
 * went, with a 200, because "it is unreachable" is an answer, not an error.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const trust = body?.trust === true;

  const outcome = await connectProbeAgent(id, { trustOffered: trust });
  if (!outcome) return NextResponse.json({ error: 'No such probe agent' }, { status: 404 });

  const probeAgent = await getProbeAgent(id);
  if (outcome.ok && (outcome.pinned || trust)) {
    await recordActivity(
      user,
      'dashboard',
      trust ? 'probe-agent.trust' : 'probe-agent.pair',
      `${probeAgent?.name ?? id} (certificate ${outcome.fingerprint.slice(0, 23)}…)`
    );
  }
  return NextResponse.json({ outcome, probeAgent });
}
