import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { parseKeyDays } from '@/lib/security/key-lifetime';
import { canAdminister } from '@/lib/security/roles';
import { getApiKey, recordActivity, rerollApiKey } from '@/lib/security/store';

/**
 * POST /api/security/keys/:id/reroll - Make a new key in place of one
 * Body (optional): { expiresInDays?: number | null }
 *
 * The new key has the same name, level and maker, and lasts as many days as
 * the old one was made to unless `expiresInDays` says otherwise (null for no
 * end). The old key stops working at once. Your own keys, or, as an admin,
 * anyone's. The new key is in the answer and nowhere else, ever.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const existing = await getApiKey(id);
  // Someone else's key is answered as no key at all: not even whether it exists.
  if (!existing || (!canAdminister(user.role) && existing.ownerId !== user.id)) {
    return NextResponse.json({ error: 'No such key' }, { status: 404 });
  }
  if (existing.revokedAt) return NextResponse.json({ error: 'That key was revoked. Make a new one instead.' }, { status: 409 });

  const body = await request.json().catch(() => null);
  let days: number | null | undefined;
  if (body && 'expiresInDays' in body) {
    const lifetime = parseKeyDays(body.expiresInDays);
    if ('error' in lifetime) return NextResponse.json({ error: lifetime.error }, { status: 400 });
    days = lifetime.days;
  }

  const made = await rerollApiKey(id, days);
  if (!made) return NextResponse.json({ error: 'No such key' }, { status: 404 });

  await recordActivity(user, 'dashboard', 'key.reroll', existing.name);
  return NextResponse.json({ key: made.key, record: made.record, replaced: made.replaced }, { status: 201 });
}
