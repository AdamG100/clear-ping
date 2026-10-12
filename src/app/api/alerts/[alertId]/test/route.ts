import { NextRequest, NextResponse } from 'next/server';
import { getAlert, sendTestAlert } from '@/lib/alerts';
import { getTargetById } from '@/lib/database';
import { initializeServer } from '@/lib/init';

/**
 * POST /api/alerts/:alertId/test - Send the alert's notification URLs a sample message
 *
 * Worded as the alert firing on the first target it is ticked for, and marked
 * as a test. Nothing about the alert's own state changes.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ alertId: string }> }) {
  try {
    await initializeServer();

    const { alertId } = await params;
    const alert = await getAlert(alertId);
    if (!alert) return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    if (alert.notifyUrls.length === 0) {
      return NextResponse.json({ error: 'This alert is not sent anywhere' }, { status: 400 });
    }

    const example = alert.targets[0] ? await getTargetById(alert.targets[0].targetId) : null;
    const result = await sendTestAlert(alert, example ?? undefined);

    // The request to this API worked either way; `ok` says whether the delivery did.
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error sending test alert:', error);
    return NextResponse.json({ error: 'Failed to send test alert' }, { status: 500 });
  }
}
