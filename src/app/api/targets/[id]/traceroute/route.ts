import { NextRequest, NextResponse } from 'next/server';
import { getTargetById } from '@/lib/database';
import { isTraceFamilies } from '@/lib/host';
import { initializeServer } from '@/lib/init';
import {
  countTraceroutes,
  deleteOlderTraceroutes,
  deleteTraceroute,
  ensureTracerouteSchema,
  getTraceroutes,
  traceAndStore,
  traceFamiliesProblem,
} from '@/lib/traceroute';

/**
 * GET /api/targets/[id]/traceroute - Recent traces for a target, newest first
 *
 * `total` is how many are kept in all, which can be more than are listed.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initializeServer();
    await ensureTracerouteSchema();

    const { id } = await params;
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 10);

    const [traceroutes, total] = await Promise.all([
      getTraceroutes(id, Number.isFinite(limit) ? limit : 10),
      countTraceroutes(id),
    ]);
    return NextResponse.json({ traceroutes, total });
  } catch (error) {
    console.error('Error fetching traceroutes:', error);
    return NextResponse.json({ error: 'Failed to fetch traceroutes' }, { status: 500 });
  }
}

/**
 * POST /api/targets/[id]/traceroute - Trace the route now
 *
 * Body, optional: { "family": "ipv4" | "ipv6" | "both" } to trace over those
 * families instead of the ones the target is probed over.
 *
 * Responds once the trace has finished, which takes a few seconds for a
 * healthy path and up to about a minute for one that goes nowhere.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initializeServer();

    const { id } = await params;
    const target = await getTargetById(id);
    if (!target) {
      return NextResponse.json({ error: 'Target not found' }, { status: 404 });
    }

    const body: unknown = await request.json().catch(() => ({}));
    const family = body && typeof body === 'object' ? (body as { family?: unknown }).family : undefined;
    if (family !== undefined && !isTraceFamilies(family)) {
      return NextResponse.json({ error: 'family is "ipv4", "ipv6" or "both"' }, { status: 400 });
    }
    const problem = family && traceFamiliesProblem(target.host, family);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    return NextResponse.json({ traceroutes: await traceAndStore(target, 'manual', family) });
  } catch (error) {
    console.error('Error running traceroute:', error);
    return NextResponse.json({ error: 'Failed to run traceroute' }, { status: 500 });
  }
}

/**
 * DELETE /api/targets/[id]/traceroute?trace=<id> - Delete one trace
 * DELETE /api/targets/[id]/traceroute?older=1    - Delete all but the newest
 *                                                  to each address family
 *
 * One or the other has to be said. A bare DELETE is refused, so that a
 * request with its query lost on the way cannot clear a target's routes.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initializeServer();
    await ensureTracerouteSchema();

    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const traceId = query.get('trace');

    if (traceId) {
      if (!(await deleteTraceroute(id, traceId))) {
        return NextResponse.json({ error: 'Route not found' }, { status: 404 });
      }
      return NextResponse.json({ deleted: 1 });
    }

    if (query.get('older')) {
      return NextResponse.json({ deleted: await deleteOlderTraceroutes(id) });
    }

    return NextResponse.json({ error: 'Say which route to delete, or older=1 for the old ones' }, { status: 400 });
  } catch (error) {
    console.error('Error deleting traceroutes:', error);
    return NextResponse.json({ error: 'Failed to delete traceroutes' }, { status: 500 });
  }
}
