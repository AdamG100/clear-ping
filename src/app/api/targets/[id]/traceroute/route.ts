import { NextRequest, NextResponse } from 'next/server';
import { getTargetById } from '@/lib/database';
import { initializeServer } from '@/lib/init';
import { ensureTracerouteSchema, getTraceroutes, traceAndStore } from '@/lib/traceroute';

/**
 * GET /api/targets/[id]/traceroute - Recent traces for a target, newest first
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initializeServer();
    await ensureTracerouteSchema();

    const { id } = await params;
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 10);

    return NextResponse.json({
      traceroutes: await getTraceroutes(id, Number.isFinite(limit) ? limit : 10),
    });
  } catch (error) {
    console.error('Error fetching traceroutes:', error);
    return NextResponse.json({ error: 'Failed to fetch traceroutes' }, { status: 500 });
  }
}

/**
 * POST /api/targets/[id]/traceroute - Trace the route now
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

    return NextResponse.json({ traceroutes: await traceAndStore(target, 'manual') });
  } catch (error) {
    console.error('Error running traceroute:', error);
    return NextResponse.json({ error: 'Failed to run traceroute' }, { status: 500 });
  }
}
