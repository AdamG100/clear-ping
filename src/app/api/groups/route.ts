import { NextRequest, NextResponse } from 'next/server';
import { createGroup, deleteGroup, moveGroup } from '@/lib/database';
import { MAX_GROUP_PATH_LENGTH, isWithinGroup, normalizeGroupPath } from '@/lib/group-path';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';

/**
 * POST /api/groups - Make a group, with nothing in it
 * Body: { group: string }, a whole path such as `Home/Network`
 *
 * Any group in the path that does not exist yet is made too. Making one that
 * is already there changes nothing.
 */
export async function POST(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json();
    const group = normalizeGroupPath(typeof body.group === 'string' ? body.group : '');

    if (!group) {
      return NextResponse.json({ error: 'A group needs a name' }, { status: 400 });
    }
    if (group.length > MAX_GROUP_PATH_LENGTH) {
      return NextResponse.json(
        { error: `A group's path can be at most ${MAX_GROUP_PATH_LENGTH} characters` },
        { status: 400 }
      );
    }

    return NextResponse.json({ group: await createGroup(group) }, { status: 201 });
  } catch (error) {
    console.error('Error creating group:', error);
    return NextResponse.json({ error: 'Failed to create group' }, { status: 500 });
  }
}

/**
 * DELETE /api/groups - Delete a group and keep what was in it
 * Body: { group: string }
 *
 * Its targets, and the groups inside it, move up to the group it sat in.
 */
export async function DELETE(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json();
    const group = normalizeGroupPath(typeof body.group === 'string' ? body.group : '');

    if (!group) {
      return NextResponse.json({ error: 'Which group to delete is required' }, { status: 400 });
    }
    if (!(await deleteGroup(group))) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // An alert names the group its target is in, and the prober holds its own
    // copy of each target.
    await getScheduler().reloadTargets();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    return NextResponse.json({ error: 'Failed to delete group' }, { status: 500 });
  }
}

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
