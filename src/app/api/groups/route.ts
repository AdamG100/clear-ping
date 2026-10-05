import { NextRequest, NextResponse } from 'next/server';
import { moveGroup } from '@/lib/database';
import { isWithinGroup, normalizeGroupPath } from '@/lib/group-path';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';

/**
 * PUT /api/groups - Rename a group, or move it inside another
 * Body: { from: string, to: string }, both whole paths such as `Home/Network`
 *
 * Everything under `from` goes with it. A `to` that already exists merges the
 * two groups.
 */
export async function PUT(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json();
    const from = normalizeGroupPath(typeof body.from === 'string' ? body.from : '');
    const to = normalizeGroupPath(typeof body.to === 'string' ? body.to : '');

    if (!from || !to) {
      return NextResponse.json({ error: 'Both the group and its new name are required' }, { status: 400 });
    }
    if (from !== to && isWithinGroup(to, from)) {
      return NextResponse.json({ error: 'A group cannot be moved inside itself' }, { status: 400 });
    }

    const moved = await moveGroup(from, to);

    // An alert names the group its target is in, and the prober holds its own
    // copy of each target.
    await getScheduler().reloadTargets();
    return NextResponse.json({ success: true, moved });
  } catch (error) {
    console.error('Error moving group:', error);
    return NextResponse.json({ error: 'Failed to move group' }, { status: 500 });
  }
}
