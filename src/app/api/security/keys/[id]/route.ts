import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { recordActivity, revokeApiKey } from '@/lib/security/store';

/**
 * DELETE /api/security/keys/:id - Revoke a key
 *
 * It stops working at once. The record of it stays, so the activity it was
 * used for still says whose it was.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const key = await revokeApiKey(id);
  if (!key) return NextResponse.json({ error: 'No such key' }, { status: 404 });

  await recordActivity(user, 'dashboard', 'key.revoke', key.name);
  return NextResponse.json({ key });
}
