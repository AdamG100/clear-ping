import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/http';
import { DEFAULT_NEW_ROLE, isRole, ROLE_LABEL, type Role } from '@/lib/security/roles';
import { passwordProblem } from '@/lib/security/secrets';
import { createUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/security/users - Add an account
 * Body: { username, password, role? }
 *
 * Admins only. The role is what the account may do (see roles.ts); a viewer
 * unless another is asked for.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  if (body?.role !== undefined && !isRole(body.role)) {
    return NextResponse.json({ error: 'A role is admin, editor or viewer' }, { status: 400 });
  }
  const role: Role = isRole(body?.role) ? body.role : DEFAULT_NEW_ROLE;
  const problem = passwordProblem(body?.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const created = await createUser(username, body.password, role);
    await recordActivity(user, 'dashboard', 'account.add', `${created.username}, as ${ROLE_LABEL[role]}`);
    return NextResponse.json({ user: created }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not add the account' }, { status: 400 });
  }
}
