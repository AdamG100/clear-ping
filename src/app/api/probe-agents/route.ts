import { NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { listProbeAgentSummaries } from '@/lib/probe-agents/store';

/**
 * GET /api/probe-agents - The probe agents targets can be probed from
 *
 * Names, addresses and whether each is up: what anyone who can see the
 * targets needs to know where they are probed from. Managing them is under
 * /api/security/probe-agents, for admins.
 */
export async function GET() {
  try {
    await initializeServer();
    return NextResponse.json({ probeAgents: await listProbeAgentSummaries() });
  } catch (error) {
    console.error('Error listing probe agents:', error);
    return NextResponse.json({ error: 'Failed to list probe agents' }, { status: 500 });
  }
}
