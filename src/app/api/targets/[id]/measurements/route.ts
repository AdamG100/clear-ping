import { NextRequest, NextResponse } from 'next/server';
import { getBucketedMeasurements, getTargetById, getTargetStatistics } from '@/lib/db/database';
import { probeAgentOutages as outagesOf } from '@/lib/probe-agents/store';
import { windowFromQuery } from '@/lib/charts/series';
import { initializeServer } from '@/lib/init';

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
    const family = requestedFamily === 4 || requestedFamily === 6 ? requestedFamily : undefined;

    const target = await getTargetById(id);
    const [buckets, statistics, probeAgentOutages] = await Promise.all([
      getBucketedMeasurements(id, startTime, endTime, bucketMs, family),
      getTargetStatistics(id, startTime, endTime, family),
      // When its probe agent could not be reached: the gaps in the readings
      // that are the agent's and not the target's.
      target?.probeAgentId ? outagesOf(target.probeAgentId, window.start, window.end) : [],
    ]);

    return NextResponse.json({
      buckets,
      bucketMs,
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
