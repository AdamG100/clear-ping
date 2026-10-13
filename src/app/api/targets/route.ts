import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets, createTarget, deleteTargets, getLatestMeasurementForAllTargets, getGroupOrders, getGroups, getRecentSeriesForAllTargets } from '@/lib/database';
import { randomUUID } from 'crypto';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';
import { validateTargetDefinition } from '@/lib/target-definition';

export async function GET(request: NextRequest) {
  try {
    // Ensure server is initialized (starts scheduler on first request)
    await initializeServer();
    
    const { searchParams } = new URL(request.url);
    const includePacketLoss = searchParams.get('packetLoss') === 'true';
    
    const targets = await getAllTargets();
    
    if (includePacketLoss) {
      const [latest, groups, groupOrders, series] = await Promise.all([
        getLatestMeasurementForAllTargets(),
        getGroups(),
        getGroupOrders(),
        getRecentSeriesForAllTargets(24),
      ]);
      return NextResponse.json({
        targets,
        latest,
        groups,
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
    
    const definition = validateTargetDefinition(await request.json());
    if (!definition.ok) {
      return NextResponse.json({ error: definition.error }, { status: 400 });
    }

    const target = await createTarget({ id: randomUUID(), ...definition.target, status: 'active' });

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

/**
 * DELETE /api/targets - Delete several targets at once
 *
 * `{ ids: [...] }` in the body, and nothing is deleted without it: a bare
 * DELETE of the whole collection is refused, so a request that lost its body
 * on the way cannot empty the list. An id that is not a target's is passed
 * over, which is what has happened when two people clear out the same list.
 */
export async function DELETE(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json().catch(() => null);
    const ids: unknown = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string' && id)) {
      return NextResponse.json({ error: 'Say which targets to delete, as a list of their ids' }, { status: 400 });
    }

    const deleted = await deleteTargets([...new Set(ids as string[])]);

    // Once, for all of them.
    if (deleted > 0) await getScheduler().reloadTargets();

    return NextResponse.json({ deleted });
  } catch (error) {
    console.error('Error deleting targets:', error);
    return NextResponse.json({ error: 'Failed to delete targets' }, { status: 500 });
  }
}
