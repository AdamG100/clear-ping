import { NextRequest, NextResponse } from 'next/server';
import { deleteAlert, parseAlertInput, updateAlert } from '@/lib/alerts';
import { checkNotifyUrls } from '@/lib/apprise';
import { initializeServer } from '@/lib/init';

/**
 * PATCH /api/alerts/:alertId - Change an alert
 * Body: any of the fields an alert is created with, and `enabled`. `targetIds`
 * replaces the whole set of ticked targets.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ alertId: string }> }) {
  try {
    await initializeServer();

    const { alertId } = await params;
    const parsed = parseAlertInput(await request.json(), true);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    if (Object.keys(parsed.input).length === 0) {
      return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 });
    }

    const usable = await checkNotifyUrls(parsed.input.notifyUrls ?? []);
    if (!usable.ok) return NextResponse.json({ error: usable.detail }, { status: 400 });

    const alert = await updateAlert(alertId, parsed.input);
    if (!alert) return NextResponse.json({ error: 'Alert not found' }, { status: 404 });

    return NextResponse.json(alert);
  } catch (error) {
    console.error('Error updating alert:', error);
    return NextResponse.json({ error: 'Failed to update alert' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ alertId: string }> }) {
  try {
    await initializeServer();

    const { alertId } = await params;
    if (!(await deleteAlert(alertId))) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting alert:', error);
    return NextResponse.json({ error: 'Failed to delete alert' }, { status: 500 });
  }
}
