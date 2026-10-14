import { NextRequest, NextResponse } from 'next/server';
import { readCookie } from '@/lib/security/access';
import { requireUser } from '@/lib/security/http';
import { passwordProblem } from '@/lib/security/secrets';
import { checkPassword, endOtherSessions, recordActivity, SESSION_COOKIE, setPassword } from '@/lib/security/store';

/**
 * PUT /api/security/password - Change your own password
 * Body: { current, password }
 *
 * Signs the account out everywhere else, which is usually why it is changed.
 */
export async function PUT(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  if (typeof body?.current !== 'string' || !(await checkPassword(user.id, body.current))) {
    return NextResponse.json({ error: 'Your current password is not right' }, { status: 400 });
  }
  const problem = passwordProblem(body?.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  await setPassword(user.id, body.password);
  await endOtherSessions(user.id, readCookie(request.headers.get('cookie'), SESSION_COOKIE) ?? undefined);
  await recordActivity(user, 'dashboard', 'account.password');
  return NextResponse.json({ success: true });
}
