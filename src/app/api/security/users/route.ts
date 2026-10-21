import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/http';
import { DEFAULT_NEW_ROLE, isRole, ROLE_LABEL, type Role } from '@/lib/security/roles';
import { passwordProblem } from '@/lib/security/secrets';
import { createUser, createUserWithLink, recordActivity } from '@/lib/security/store';

/**
 * POST /api/security/users - Add an account
 * Body: { username, role?, password } or { username, role?, link: true }
 *
 * Admins only. The role is what the account may do (see roles.ts); a viewer
 * unless another is asked for. Either the admin sets the password, or the
 * answer carries a one-time link (`link.token`, good for PASSWORD_LINK_HOURS)
 * for the new account's owner to choose their own; the page makes the address
 * of it, since the token is only ever shown this once.
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

  if (body?.link === true) {
    try {
      const { user: created, token, expiresAt } = await createUserWithLink(username, role);
      await recordActivity(user, 'dashboard', 'account.add', `${created.username}, as ${ROLE_LABEL[role]}, with a password link`);
      return NextResponse.json({ user: created, link: { token, expiresAt } }, { status: 201 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not add the account' }, { status: 400 });
    }
  }

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
