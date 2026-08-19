import { NextRequest, NextResponse } from 'next/server';
import { getTargetById, updateTarget, deleteTarget } from '@/lib/database';
import { isValidPingHost } from '@/lib/ping';
import { getScheduler } from '@/lib/scheduler';
import { initializeServer } from '@/lib/init';
import type { Target } from '@/types/probe';

const STATUSES = ['active', 'paused', 'error'] as const;
const PROBE_TYPES = ['ping', 'dns'] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();
    const { id } = await params;
    const target = await getTargetById(id);

    if (!target) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(target);
  } catch (error) {
    console.error('Error fetching target:', error);
    return NextResponse.json(
      { error: 'Failed to fetch target' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();

    const { id } = await params;
    const body = await request.json();

    // Only known fields are forwarded. Passing the request body straight to the
    // database let a client set anything the update builder recognised, and an
    // invalid status reached SQLite as a CHECK-constraint failure rather than a
    // 400.
    const updates: Partial<Target> = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      updates.name = name;
    }

    if (body.host !== undefined) {
      const host = String(body.host).trim();
      if (!isValidPingHost(host)) {
        return NextResponse.json(
          { error: 'Invalid host: must be a hostname or IP address' },
          { status: 400 }
        );
      }
      updates.host = host;
    }

    if (body.probeType !== undefined) {
      if (!PROBE_TYPES.includes(body.probeType)) {
        return NextResponse.json({ error: 'Invalid probe type' }, { status: 400 });
      }
      updates.probeType = body.probeType;
    }

    if (body.interval !== undefined) {
      const interval = Number(body.interval);
      if (!Number.isFinite(interval) || interval < 10 || interval > 86400) {
        return NextResponse.json(
          { error: 'Interval must be between 10 and 86400 seconds' },
          { status: 400 }
        );
      }
      updates.interval = interval;
    }

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) {
        return NextResponse.json(
          { error: `Invalid status. Expected one of: ${STATUSES.join(', ')}` },
          { status: 400 }
        );
      }
      updates.status = body.status;
    }

    if (body.group !== undefined) {
      updates.group = body.group ? String(body.group).trim() : undefined;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 });
    }

    const updated = await updateTarget(id, updates);

    if (!updated) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    // Pausing, resuming or re-scheduling should take effect now rather than at
    // the scheduler's next five-minute reload.
    await getScheduler().reloadTargets();

    const target = await getTargetById(id);
    return NextResponse.json(target);
  } catch (error) {
    console.error('Error updating target:', error);
    return NextResponse.json(
      { error: 'Failed to update target' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();

    const { id } = await params;
    const deleted = await deleteTarget(id);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    await getScheduler().reloadTargets();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting target:', error);
    return NextResponse.json(
      { error: 'Failed to delete target' },
      { status: 500 }
    );
  }
}
