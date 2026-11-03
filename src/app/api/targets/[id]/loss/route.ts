import { NextRequest, NextResponse } from 'next/server';
import { getProbeReadings, getTargetById } from '@/lib/db/database';
import { windowFromQuery } from '@/lib/charts/series';
import { initializeServer } from '@/lib/init';
import { DEFAULT_PING_PACKETS } from '@/lib/probes/config';
import { isTimeZone } from '@/lib/reports/evidence';
import { analyzeLoss } from '@/lib/reports/loss';
import { readNeighbours } from '@/lib/reports/neighbours';
import { chosenProbe } from '@/lib/targets/probes';

/**
 * Where a target's loss over a period is: its pattern, the hours it falls in
 * and which other targets lost packets at the same moments. Takes the same
 * period as /measurements, and `tz`, the zone the hours are told in.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();

    const { id } = await params;
    const target = await getTargetById(id);
    if (!target) return NextResponse.json({ error: 'Target not found' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const window = windowFromQuery(searchParams);
    const startTime = new Date(window.start);
    const endTime = new Date(window.end);
    const requestedFamily = Number(searchParams.get('family'));
    const family = requestedFamily === 4 || requestedFamily === 6 ? requestedFamily : undefined;
    const timeZone = searchParams.get('tz');

    // Of the probe asked for; the primary one when it is not said.
    const probe = chosenProbe(target, searchParams.get('probe'));
    const [readings, neighbours] = await Promise.all([
      getProbeReadings(id, startTime, endTime, { probe }),
      readNeighbours(target, startTime, endTime, probe),
    ]);

    return NextResponse.json(
      analyzeLoss(family ? readings.filter(reading => reading.family === family) : readings, {
        intervalMs: target.interval * 1000,
        timeZone: isTimeZone(timeZone) ? timeZone : 'UTC',
        packetsPerProbe: target.probeType === 'ping' ? target.probeConfig?.packets ?? DEFAULT_PING_PACKETS : null,
        neighbours,
      })
    );
  } catch (error) {
    console.error('Error working out where the loss is:', error);
    return NextResponse.json({ error: 'Failed to work out where the loss is' }, { status: 500 });
  }
}
