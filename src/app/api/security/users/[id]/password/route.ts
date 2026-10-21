import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/http';
import { passwordProblem } from '@/lib/security/secrets';
import { recordActivity, setPasswordFor } from '@/lib/security/store';

/**
 * PUT /api/security/users/:id/password - Set another account's password
 * Body: { password }
 *
 * Admins only: for someone who has forgotten theirs. The account is signed
 * out everywhere. Not your own (change that with your current password) and
 * not the primary account's, which only its owner sets.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  if (id === user.id) {
    return NextResponse.json({ error: 'Change your own password under Your account, with your current one' }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const problem = passwordProblem(body?.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const changed = await setPasswordFor(id, body.password, request.headers);
    await recordActivity(user, 'dashboard', 'account.password.set', changed.username);
    return NextResponse.json({ user: changed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not set the password';
    return NextResponse.json({ error: message }, { status: message === 'No such account' ? 404 : 400 });
  }
}
