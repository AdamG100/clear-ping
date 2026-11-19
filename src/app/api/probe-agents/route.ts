import { NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { listProbeAgentSummaries } from '@/lib/probe-agents/store';
import { localProbeName } from '@/lib/probe-agents/probes';
import { offlineAfterMinutes } from '@/lib/probe-agents/heartbeat';
import { LOCAL_PROBE } from '@/types/probe-agent';
import { eitherNames } from '@/lib/targets/monitor-names';

/**
 * GET /api/probe-agents - The probe agents targets can be probed from
 *
 * Names, addresses and whether each is up: what anyone who can see the
 * targets needs to know where they are probed from. Managing them is under
 * /api/security/probe-agents, for admins.
 */
async function handleGET() {
  try {
    await initializeServer();
    // The local probe is listed too, so the dashboard has every probe from one call.
    const [probeAgents, name, offlineAfter] = await Promise.all([listProbeAgentSummaries(), localProbeName(), offlineAfterMinutes()]);
    return NextResponse.json({ probeAgents, localProbe: { id: LOCAL_PROBE, name }, offlineAfterMinutes: offlineAfter });
  } catch (error) {
    console.error('Error listing probe agents:', error);
    return NextResponse.json({ error: 'Failed to list probe agents' }, { status: 500 });
  }
}

// Either name for a monitor in, both out (see monitor-names.ts).
export const GET = eitherNames(handleGET)
