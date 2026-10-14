import { NextRequest, NextResponse } from 'next/server';
import { recoveryMode } from '@/lib/security/access';
import { setSessionCookie } from '@/lib/security/http';
import { passwordProblem } from '@/lib/security/secrets';
import { countUsers, createSession, createUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/auth/register - Make the first account, and sign in with it
 * Body: { username, password }
 *
 * Only while there is no account at all, or while CLEARPING_AUTH=off is set
 * to get back into an install whose password is lost. Every other account is
 * added by someone signed in, from the security settings.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = body?.password;

  if ((await countUsers()) > 0 && !recoveryMode()) {
    return NextResponse.json({ error: 'There is already an account. Sign in, and add others from the security settings.' }, { status: 403 });
  }
  const problem = passwordProblem(password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const user = await createUser(username, password);
    const session = await createSession(user.id);
    await recordActivity(
      { kind: 'user', id: user.id, name: user.username },
      'dashboard',
      'account.create',
      recoveryMode() ? 'Made while CLEARPING_AUTH=off' : 'First account'
    );

    const response = NextResponse.json({ username: user.username }, { status: 201 });
    setSessionCookie(response, request, session.token, session.expiresAt);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not make the account' }, { status: 400 });
  }
}
