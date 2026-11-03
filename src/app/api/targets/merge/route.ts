import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets } from '@/lib/db/database';
import { initializeServer } from '@/lib/init';
import { getScheduler } from '@/lib/scheduler';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';
import { findDuplicateSets, mergeMonitors } from '@/lib/targets/merge';
import { probeNames } from '@/lib/probe-agents/probes';

/**
 * GET /api/targets/merge - Monitors that were set up once for each probe
 *
 * Sets of two or more that measure the same thing from different probes,
 * which could be one monitor measured from all of them.
 */
export async function GET() {
  try {
    await initializeServer();
    return NextResponse.json({ sets: findDuplicateSets(await getAllTargets()) });
  } catch (error) {
    console.error('Error looking for duplicate monitors:', error);
    return NextResponse.json({ error: 'Failed to look for duplicate monitors' }, { status: 500 });
  }
}

/**
 * POST /api/targets/merge - Put monitors together
 * Body: { keep: id, merge: [id, …] }
 *
 * The others' readings, routes, probes and alert states go under `keep`, and
 * they are deleted. It cannot be undone with a button, but each reading keeps
 * the probe it was taken from, so the activity record is enough to set them
 * up apart again.
 */
export async function POST(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json().catch(() => null);
    const keep: unknown = body?.keep;
    const merge: unknown = body?.merge;
    if (typeof keep !== 'string' || !Array.isArray(merge) || merge.length === 0 || !merge.every(id => typeof id === 'string')) {
      return NextResponse.json({ error: 'keep is the monitor to keep, and merge the ids of the ones to put into it' }, { status: 400 });
    }

    // Only what the merge offered: two that share a probe are not one monitor split in two.
    const targets = await getAllTargets();
    const set = findDuplicateSets(targets).find(each => each.monitors.some(monitor => monitor.id === keep));
    const allowed = new Set(set?.monitors.map(monitor => monitor.id));
    if (!set || !merge.every(id => allowed.has(id) && id !== keep)) {
      return NextResponse.json({ error: 'Those monitors are not ones that can be merged' }, { status: 400 });
    }

    const merged = set.monitors.filter(monitor => merge.includes(monitor.id));
    const names = await probeNames(merged.flatMap(monitor => monitor.probes));
    getScheduler().forget(merge);
    const moved = await mergeMonitors(keep, merge);
    await getScheduler().reloadTargets();

    const { actor, via } = await actorFor(request);
    const kept = set.monitors.find(monitor => monitor.id === keep)!;
    await recordActivity(
      actor,
      via,
      'target.merge',
      `${kept.name} took in ${merged
        .map(monitor => `${monitor.name} (${monitor.group || 'no group'}, every ${monitor.interval}s, from ${monitor.probes.map(probe => names.get(probe)).join(', ')})`)
        .join('; ')}`
    );

    return NextResponse.json({ merged: merge.length, readingsMoved: moved });
  } catch (error) {
    console.error('Error merging monitors:', error);
    return NextResponse.json({ error: 'Failed to merge the monitors' }, { status: 500 });
  }
}
