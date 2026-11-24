import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { getNotificationSender, readSender, setNotificationSender } from '@/lib/alerts/sender';
import { actorFor } from '@/lib/security/access';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * Settings → Notifications: who notifications are posted as, a name and a
 * picture. Anyone who can open the dashboard reads them; only an admin
 * changes them.
 */

/** GET /api/notifications - The name and picture notifications are posted with */
export async function GET() {
  try {
    await initializeServer();
    return NextResponse.json({ sender: await getNotificationSender() });
  } catch (error) {
    console.error('Error reading the notification settings:', error);
    return NextResponse.json({ error: 'Failed to read the notification settings' }, { status: 500 });
  }
}

/**
 * PUT /api/notifications - Change them
 * Body: { sender: { name, avatarUrl } }, either left empty for the service's own
 */
export async function PUT(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  try {
    await initializeServer();
    const body = await request.json().catch(() => null);
    const sender = readSender(body?.sender);
    if ('error' in sender) return NextResponse.json({ error: sender.error }, { status: 400 });

    await setNotificationSender(sender);
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'notifications.sender', sender.name ?? undefined);
    return NextResponse.json({ sender });
  } catch (error) {
    console.error('Error saving the notification settings:', error);
    return NextResponse.json({ error: 'Failed to save the notification settings' }, { status: 500 });
  }
}
