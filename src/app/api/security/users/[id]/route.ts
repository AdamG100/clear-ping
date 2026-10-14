import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { deleteUser, listUsers, recordActivity } from '@/lib/security/store';

/**
 * DELETE /api/security/users/:id - Remove an account, and sign it out everywhere
 *
 * Not your own: whoever removes an account is signed in with another, so there
 * is always one left to sign in with.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  if (id === user.id) {
    return NextResponse.json({ error: 'You cannot remove the account you are signed in with' }, { status: 400 });
  }
  const removed = (await listUsers()).find(each => each.id === id);
  if (!removed || !(await deleteUser(id))) return NextResponse.json({ error: 'No such account' }, { status: 404 });

  await recordActivity(user, 'dashboard', 'account.remove', removed.username);
  return NextResponse.json({ success: true });
}
