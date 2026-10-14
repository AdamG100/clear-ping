import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { canAdminister } from '@/lib/security/roles';
import { getApiKey, recordActivity, revokeApiKey } from '@/lib/security/store';

/**
 * DELETE /api/security/keys/:id - Revoke a key
 *
 * Your own, or, as an admin, anyone's. It stops working at once. The record
 * of it stays, so the activity it was used for still says whose it was.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const existing = await getApiKey(id);
  // Someone else's key is answered as no key at all: not even whether it exists.
  if (!existing || (!canAdminister(user.role) && existing.ownerId !== user.id)) {
    return NextResponse.json({ error: 'No such key' }, { status: 404 });
  }
  const key = await revokeApiKey(id);
  if (!key) return NextResponse.json({ error: 'No such key' }, { status: 404 });

  await recordActivity(user, 'dashboard', 'key.revoke', key.name);
  return NextResponse.json({ key });
}
