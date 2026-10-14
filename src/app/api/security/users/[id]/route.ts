import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/http';
import { isRole, ROLE_LABEL } from '@/lib/security/roles';
import { deleteUser, getUser, recordActivity, setRole } from '@/lib/security/store';

/**
 * PATCH /api/security/users/:id - Change what an account may do
 * Body: { role: 'admin' | 'editor' | 'viewer' }
 *
 * Admins only, and never so as to leave no admin. Your own role can be
 * changed too, as long as another admin remains to change it back.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!isRole(body?.role)) return NextResponse.json({ error: 'A role is admin, editor or viewer' }, { status: 400 });

  const before = await getUser(id);
  if (!before) return NextResponse.json({ error: 'No such account' }, { status: 404 });
  try {
    const changed = await setRole(id, body.role);
    if (before.role !== changed.role) {
      await recordActivity(user, 'dashboard', 'account.role', `${changed.username}: ${ROLE_LABEL[before.role]} to ${ROLE_LABEL[changed.role]}`);
    }
    return NextResponse.json({ user: changed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not change the role' }, { status: 400 });
  }
}

/**
 * DELETE /api/security/users/:id - Remove an account, sign it out everywhere, and revoke its keys
 *
 * Admins only. Not your own: whoever removes an account is signed in with
 * another, so there is always one left to sign in with. Never the last admin.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  if (id === user.id) {
    return NextResponse.json({ error: 'You cannot remove the account you are signed in with' }, { status: 400 });
  }
  const removed = await getUser(id);
  if (!removed) return NextResponse.json({ error: 'No such account' }, { status: 404 });
  try {
    if (!(await deleteUser(id))) return NextResponse.json({ error: 'No such account' }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not remove the account' }, { status: 400 });
  }

  await recordActivity(user, 'dashboard', 'account.remove', removed.username);
  return NextResponse.json({ success: true });
}
