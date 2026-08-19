import { NextRequest, NextResponse } from 'next/server';
import { getBucketedMeasurements, getTargetStatistics } from '@/lib/database';
import { bucketWidthFor, MAX_CHART_POINTS } from '@/lib/series';
import { initializeServer } from '@/lib/init';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();

    const { id } = await params;
    const { searchParams } = new URL(request.url);

    // An unparseable `hours` used to produce a NaN window, which queried
    // `timestamp >= NaN` and silently returned nothing.
    const parsedHours = Number(searchParams.get('hours') ?? 24);
    const hours = Number.isFinite(parsedHours)
      ? Math.min(24 * 31, Math.max(1, parsedHours))
      : 24;

    const parsedMaxPoints = Number(searchParams.get('maxPoints') ?? MAX_CHART_POINTS);
    const maxPoints = Number.isFinite(parsedMaxPoints)
      ? Math.min(2000, Math.max(10, Math.floor(parsedMaxPoints)))
      : MAX_CHART_POINTS;

    const endTime = new Date();
    const windowMs = hours * 60 * 60 * 1000;
    const startTime = new Date(endTime.getTime() - windowMs);
    const bucketMs = bucketWidthFor(windowMs, maxPoints);

    // Aggregated in SQL rather than returning every raw row: a 30-day window at
    // a 30-second probe interval is ~86,000 rows per target, all of which the
    // browser previously downloaded only to average them away.
    const [buckets, statistics] = await Promise.all([
      getBucketedMeasurements(id, startTime, endTime, bucketMs),
      getTargetStatistics(id, startTime, endTime),
    ]);

    return NextResponse.json({
      buckets,
      bucketMs,
      statistics,
    });
  } catch (error) {
    console.error('Error fetching measurements:', error);
    return NextResponse.json(
      { error: 'Failed to fetch measurements' },
      { status: 500 }
    );
  }
}
