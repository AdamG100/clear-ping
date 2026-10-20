import { NextRequest, NextResponse } from 'next/server';
import { createAlert, getAlerts, parseAlertInput, type AlertInput } from '@/lib/alerts';
import { checkNotifyUrls } from '@/lib/apprise';
import { initializeServer } from '@/lib/init';
import { redactNotifyUrl } from '@/lib/alert-delivery';
import { actorFor, identify } from '@/lib/security/access';
import { canChange } from '@/lib/security/roles';
import { recordActivity } from '@/lib/security/store';

/**
 * GET /api/alerts - Every alert, with the state of each target it is ticked for
 *
 * Where each is sent is shown whole only to whoever may change alerts: the
 * URLs carry the services' tokens. A viewer, a key that only reads, and anyone
 * not signed in (sign-in may be off) see which service and no more.
 */
export async function GET(request: NextRequest) {
  try {
    await initializeServer();
    const alerts = await getAlerts();
    const { actor } = await identify(request);
    const mayChange = actor?.kind === 'user' ? canChange(actor.role) : actor?.kind === 'key' ? actor.access === 'write' : false;
    return NextResponse.json({
      alerts: mayChange ? alerts : alerts.map(alert => ({ ...alert, notifyUrls: alert.notifyUrls.map(redactNotifyUrl) })),
    });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}

/**
 * POST /api/alerts - Create an alert
 * Body: { name?, metric, threshold, consecutiveProbes, notifyUrls?, traceOnFire?, traceCooldownMinutes?, targetIds }
 *
 * `notifyUrls` is the Apprise URLs to send it to: any service Apprise has, and
 * as many as wanted. Left out or empty, the alert is only shown in the app.
 */
export async function POST(request: NextRequest) {
  try {
    await initializeServer();

    const parsed = parseAlertInput(await request.json());
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const usable = await checkNotifyUrls(parsed.input.notifyUrls ?? []);
    if (!usable.ok) return NextResponse.json({ error: usable.detail }, { status: 400 });

    // Not partial, so everything an alert needs has been checked to be there.
    const alert = await createAlert(parsed.input as AlertInput);
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'alert.add', alert.name || `${alert.metric} alert`);
    return NextResponse.json(alert, { status: 201 });
  } catch (error) {
    console.error('Error creating alert:', error);
    return NextResponse.json({ error: 'Failed to create alert' }, { status: 500 });
  }
}
