import { NextRequest, NextResponse } from 'next/server';
import { getTargetById, storeMeasurement } from '@/lib/database';
import { executePing } from '@/lib/ping';
import { executeDnsProbe } from '@/lib/dns';
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

    let result;
    
    if (target.probeType === 'ping') {
      result = await executePing(target.id, target.host);
    } else if (target.probeType === 'dns') {
      result = await executeDnsProbe(target.id, target.host);
    } else {
      return NextResponse.json(
        { error: 'Invalid probe type' },
        { status: 400 }
      );
    }

    // Store the measurement
    const measurement = {
      id: randomUUID(),
      targetId: result.targetId,
      timestamp: result.timestamp,
      latency: result.latency,
      packetLoss: result.packetLoss || 0,
      success: result.success,
      errorMessage: result.errorMessage,
    };

    await storeMeasurement(measurement);

    return NextResponse.json({
      result,
      measurement,
    });
  } catch (error) {
    console.error('Error executing probe:', error);
    return NextResponse.json(
      { error: 'Failed to execute probe' },
      { status: 500 }
    );
  }
}
