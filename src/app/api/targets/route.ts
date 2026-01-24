import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets, createTarget, getLatestPacketLossForAllTargets } from '@/lib/database';
import { randomUUID } from 'crypto';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';

export async function GET(request: NextRequest) {
  try {
    // Ensure server is initialized (starts scheduler on first request)
    await initializeServer();
    
    const { searchParams } = new URL(request.url);
    const includePacketLoss = searchParams.get('packetLoss') === 'true';
    
    const targets = await getAllTargets();
    
    if (includePacketLoss) {
      const packetLossMap = await getLatestPacketLossForAllTargets();
      return NextResponse.json({
        targets,
        packetLoss: packetLossMap
      });
    }
    
    return NextResponse.json(targets);
  } catch (error) {
    console.error('Error fetching targets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch targets' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Ensure server is initialized
    await initializeServer();
    
    const body = await request.json();
    const { name, host, probeType, interval, group } = body;

    if (!name || !host || !probeType || !interval) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    if (probeType !== 'ping' && probeType !== 'dns') {
      return NextResponse.json(
        { error: 'Invalid probe type' },
        { status: 400 }
      );
    }

    const target = await createTarget({
      id: randomUUID(),
      name,
      host,
      probeType,
      interval,
      status: 'active',
      group: group || undefined,
    });

    // Reload scheduler to pick up the new target immediately
    const scheduler = getScheduler();
    await scheduler.reloadTargets();

    return NextResponse.json(target, { status: 201 });
  } catch (error) {
    console.error('Error creating target:', error);
    return NextResponse.json(
      { error: 'Failed to create target' },
      { status: 500 }
    );
  }
}
