import { NextRequest, NextResponse } from 'next/server';
import { deleteAlert, getAlert, parseAlertInput, updateAlert } from '@/lib/alerts/store';
import { trimAlertTraces } from '@/lib/traceroute/store';
import { checkNotifyUrls } from '@/lib/alerts/apprise';
import { initializeServer } from '@/lib/init';
import { restoreRedacted } from '@/lib/alerts/delivery';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

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

    // The page may only have been shown them redacted (see GET /api/alerts).
    if (parsed.input.notifyUrls) {
      const existing = await getAlert(alertId);
      if (existing) parsed.input.notifyUrls = restoreRedacted(parsed.input.notifyUrls, existing.notifyUrls);
    }

    const usable = await checkNotifyUrls(parsed.input.notifyUrls ?? []);
    if (!usable.ok) return NextResponse.json({ error: usable.detail }, { status: 400 });

    const alert = await updateAlert(alertId, parsed.input);
    if (!alert) return NextResponse.json({ error: 'Alert not found' }, { status: 404 });

    // A tighter keep-count or a shorter life takes effect now, not at the next
    // retention pass. Saving anything else leaves the routes alone.
    if (parsed.input.traceKeepCount !== undefined || parsed.input.traceKeepDays !== undefined) {
      await trimAlertTraces(alert.id, alert.traceKeepCount, alert.traceKeepDays);
    }

    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'alert.change', `${alert.name || `${alert.metric} alert`}: ${Object.keys(parsed.input).join(', ')}`);
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
    const existing = await getAlert(alertId);
    if (!(await deleteAlert(alertId))) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    }

    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'alert.delete', existing?.name || (existing ? `${existing.metric} alert` : alertId));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting alert:', error);
    return NextResponse.json({ error: 'Failed to delete alert' }, { status: 500 });
  }
}
