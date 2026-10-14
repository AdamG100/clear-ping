import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { passCookies, refusal, requireUser } from '@/lib/security/http';
import { passwordProblem } from '@/lib/security/secrets';
import { recordActivity } from '@/lib/security/store';

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
  if (typeof body?.current !== 'string' || !body.current) {
    return NextResponse.json({ error: 'Your current password is not right' }, { status: 400 });
  }
  const problem = passwordProblem(body?.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const auth = await getAuth();
  const changed = await auth.api.changePassword({
    headers: request.headers,
    body: { currentPassword: body.current, newPassword: body.password, revokeOtherSessions: true },
    asResponse: true,
  });
  if (!changed.ok) {
    const reason = await refusal(changed, 'Could not change the password');
    return NextResponse.json({ error: /invalid password/i.test(reason) ? 'Your current password is not right' : reason }, { status: 400 });
  }

  await recordActivity(user, 'dashboard', 'account.password');
  return passCookies(changed, NextResponse.json({ success: true }), request);
}
