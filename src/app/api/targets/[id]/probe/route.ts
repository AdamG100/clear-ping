import { NextRequest, NextResponse } from 'next/server';
import { getTargetById } from '@/lib/db/database';
import { ProbeAgentUnavailableError } from '@/lib/probe-agents/client';
import { probeNow } from '@/lib/targets/actions';
import { chosenProbe, probeIdsOf } from '@/lib/targets/probes';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const target = await getTargetById(id);

    if (!target) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    // `result` is what the caller reports back to the user: the round as a
    // whole, which for a pair of address families is the worse of the two.
    // From the probe in view, from every probe with probes=all, and from the
    // primary one when it is not said, as it always was.
    const { searchParams } = new URL(request.url);
    const wanted = searchParams.get('probes') === 'all' ? probeIdsOf(target) : [chosenProbe(target, searchParams.get('probe'))];
    return NextResponse.json(await probeNow(target, wanted));
  } catch (error) {
    // Nothing is recorded: the agent, not the target, is what failed.
    if (error instanceof ProbeAgentUnavailableError) {
      return NextResponse.json({ error: `Probe agent ${error.agentName}: ${error.message}` }, { status: 503 });
    }
    console.error('Error executing probe:', error);
    return NextResponse.json(
      { error: 'Failed to execute probe' },
      { status: 500 }
    );
  }
}
