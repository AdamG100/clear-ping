import { NextRequest, NextResponse } from 'next/server';
import { getAlert } from '@/lib/alerts/store';
import { purgeAlertTraces } from '@/lib/traceroute/store';
import { initializeServer } from '@/lib/init';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

/**
 * DELETE /api/alerts/:alertId/traces - Delete the routes this alert has taken
 *
 * A route traced by hand is kept. So is a route taken by a different alert.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ alertId: string }> }) {
  try {
    await initializeServer();

    const { alertId } = await params;
    const alert = await getAlert(alertId);
    if (!alert) return NextResponse.json({ error: 'Alert not found' }, { status: 404 });

    const deleted = await purgeAlertTraces(alertId);
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'alert.purge-traces', `${alert.name || `${alert.metric} alert`}: ${deleted}`);
    return NextResponse.json({ deleted });
  } catch (error) {
    console.error('Error deleting an alert’s routes:', error);
    return NextResponse.json({ error: 'Failed to delete the saved routes' }, { status: 500 });
  }
}
