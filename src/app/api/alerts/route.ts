import { NextRequest, NextResponse } from 'next/server';
import { createAlert, getAlerts, parseAlertInput, type AlertInput } from '@/lib/alerts';
import { checkNotifyUrls } from '@/lib/apprise';
import { initializeServer } from '@/lib/init';

/** GET /api/alerts - Every alert, with the state of each target it is ticked for */
export async function GET() {
  try {
    await initializeServer();
    return NextResponse.json({ alerts: await getAlerts() });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}

/**
 * POST /api/alerts - Create an alert
 * Body: { name?, metric, threshold, consecutiveProbes, notifyUrls?, targetIds }
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
    return NextResponse.json(alert, { status: 201 });
  } catch (error) {
    console.error('Error creating alert:', error);
    return NextResponse.json({ error: 'Failed to create alert' }, { status: 500 });
  }
}
