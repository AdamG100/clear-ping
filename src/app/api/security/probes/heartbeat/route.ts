import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { isOfflineAfterMinutes, MAX_OFFLINE_AFTER_MINUTES, offlineAfterMinutes, setOfflineAfterMinutes } from '@/lib/probe-agents/heartbeat';
import { actorFor } from '@/lib/security/access';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * PATCH /api/security/probes/heartbeat - How long a probe agent may be silent before it is offline
 * Body: { offlineAfterMinutes } (1 to 60)
 *
 * The dashboard asks each probe agent how it is once a minute. One that has not
 * answered for this long is marked offline, and the alerts that ask are told.
 */
export async function PATCH(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const body = await request.json().catch(() => null);
  if (!isOfflineAfterMinutes(body?.offlineAfterMinutes)) {
    return NextResponse.json({ error: `offlineAfterMinutes is a whole number of minutes from 1 to ${MAX_OFFLINE_AFTER_MINUTES}` }, { status: 400 });
  }

  const before = await offlineAfterMinutes();
  await setOfflineAfterMinutes(body.offlineAfterMinutes);
  if (before !== body.offlineAfterMinutes) {
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'probe.heartbeat', `${before} → ${body.offlineAfterMinutes} minutes`);
  }
  return NextResponse.json({ offlineAfterMinutes: body.offlineAfterMinutes });
}
