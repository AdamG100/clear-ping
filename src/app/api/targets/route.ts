import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets, createTarget, getLatestMeasurementForAllTargets, getGroupOrders, getRecentSeriesForAllTargets } from '@/lib/database';
import { randomUUID } from 'crypto';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';
import { isValidPingHost } from '@/lib/ping';

export async function GET(request: NextRequest) {
  try {
    // Ensure server is initialized (starts scheduler on first request)
    await initializeServer();
    
    const { searchParams } = new URL(request.url);
    const includePacketLoss = searchParams.get('packetLoss') === 'true';
    
    const targets = await getAllTargets();
    
    if (includePacketLoss) {
      const [latest, groupOrders, series] = await Promise.all([
        getLatestMeasurementForAllTargets(),
        getGroupOrders(),
        getRecentSeriesForAllTargets(24),
      ]);
      return NextResponse.json({
        targets,
        latest,
        groupOrders,
        series,
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

    // Reject hosts the probe could never use, rather than storing a target that
    // records 100% loss forever.
    if (!isValidPingHost(String(host))) {
      return NextResponse.json(
        { error: 'Invalid host: must be a hostname or IP address' },
        { status: 400 }
      );
    }

    const intervalSeconds = Number(interval);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 86400) {
      return NextResponse.json(
        { error: 'Interval must be between 10 and 86400 seconds' },
        { status: 400 }
      );
    }

    const target = await createTarget({
      id: randomUUID(),
      name: String(name).trim(),
      host: String(host).trim(),
      probeType,
      interval: intervalSeconds,
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
