import { NextRequest, NextResponse } from 'next/server';
import { getBucketedMeasurements, getTargetById, getTargetStatistics } from '@/lib/db/database';
import { probeAgentOutages as outagesOf } from '@/lib/probe-agents/store';
import { windowFromQuery } from '@/lib/charts/series';
import { initializeServer } from '@/lib/init';
import { chosenProbe } from '@/lib/targets/probes';
import { LOCAL_PROBE } from '@/types/probe-agent';
import type { AddressFamily } from '@/types/probe';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();

    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const window = windowFromQuery(searchParams);
    const startTime = new Date(window.start);
    const endTime = new Date(window.end);
    const { bucketMs } = window;

    // Aggregated in SQL rather than returning every raw row: a 30-day window at
    // a 30-second probe interval is ~86,000 rows per target, all of which the
    // browser previously downloaded only to average them away.
    // One side of a target probed over both address families. Anything else
    // is read whole.
    const requestedFamily = Number(searchParams.get('family'));
    const family: AddressFamily | undefined = requestedFamily === 4 ? 4 : requestedFamily === 6 ? 6 : undefined;

    const target = await getTargetById(id);
    // The probe asked for with `?probe=`; the primary one when it is not, which
    // is what every monitor was read from before it could have several.
    const probe = target ? chosenProbe(target, searchParams.get('probe')) : undefined;
    const scope = { family, probe };
    const [buckets, statistics, probeAgentOutages] = await Promise.all([
      getBucketedMeasurements(id, startTime, endTime, bucketMs, scope),
      getTargetStatistics(id, startTime, endTime, scope),
      // When that probe's agent could not be reached: the gaps in the readings
      // that are the agent's and not the target's.
      probe && probe !== LOCAL_PROBE ? outagesOf(probe, window.start, window.end) : [],
    ]);

    return NextResponse.json({
      buckets,
      bucketMs,
      // The period read, which the chart spans whether or not it has readings
      // all the way across.
      start: window.start,
      end: window.end,
      statistics,
      probeAgentOutages,
    });
  } catch (error) {
    console.error('Error fetching measurements:', error);
    return NextResponse.json(
      { error: 'Failed to fetch measurements' },
      { status: 500 }
    );
  }
}
