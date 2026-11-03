import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { localProbeName, setLocalProbeName } from '@/lib/probe-agents/probes';
import { actorFor } from '@/lib/security/access';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * PATCH /api/security/probes/local - Rename the local probe
 * Body: { name } ("Local probe" again when empty)
 *
 * The local probe is where this dashboard runs. It is called "Local probe"
 * until someone calls it something that says where that is.
 */
export async function PATCH(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const body = await request.json().catch(() => null);
  if (!body || typeof body.name !== 'string') {
    return NextResponse.json({ error: 'name is the new name for the local probe' }, { status: 400 });
  }

  const before = await localProbeName();
  const name = await setLocalProbeName(body.name);
  if (name !== before) {
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'probe.rename', `${before} → ${name}`);
  }
  return NextResponse.json({ name });
}
