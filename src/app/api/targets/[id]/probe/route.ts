import { NextRequest, NextResponse } from 'next/server';
import { getTargetById, setResolvedAddress, storeMeasurement } from '@/lib/database';
import { executeProbes } from '@/lib/probe';
import { measurementFrom, worstOf } from '@/lib/probe-result';
import { randomUUID } from 'crypto';

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

    // One result, or one per address family for a target probed over both.
    const results = await executeProbes(target);
    const measurements = results.map(result => measurementFrom(randomUUID(), result));

    for (const measurement of measurements) {
      await storeMeasurement(measurement);
    }

    // What the caller reports back to the user: the round as a whole, which
    // for a pair is the worse of the two.
    const result = worstOf(results);

    if (result.resolvedAddress) {
      await setResolvedAddress(target.id, result.resolvedAddress);
    }

    return NextResponse.json({
      result,
      results,
      measurements,
    });
  } catch (error) {
    console.error('Error executing probe:', error);
    return NextResponse.json(
      { error: 'Failed to execute probe' },
      { status: 500 }
    );
  }
}
