import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { getAlert } from '@/lib/alerts/store';
import { getAlertEvents } from '@/lib/alerts/history';

/**
 * GET /api/alerts/[alertId]/events?limit= - An alert's history, newest first
 *
 * Each time a monitor started or stopped firing: the conditions as they stood,
 * each probe's part in it, and why.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ alertId: string }> }) {
  try {
    await initializeServer();
    const { alertId } = await params;
    if (!(await getAlert(alertId))) return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
    return NextResponse.json({ events: await getAlertEvents(alertId, Number.isFinite(limit) ? limit : 50) });
  } catch (error) {
    console.error('Error reading an alert’s history:', error);
    return NextResponse.json({ error: 'Failed to read the alert’s history' }, { status: 500 });
  }
}
