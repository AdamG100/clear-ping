import { NextRequest, NextResponse } from 'next/server';
import { recoveryMode } from '@/lib/security/access';
import { getAuth } from '@/lib/security/auth';
import { passCookies } from '@/lib/security/http';
import { passwordProblem } from '@/lib/security/secrets';
import { actorOf, countUsers, createUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/auth/register - Make the first account, and sign in with it
 * Body: { username, password }
 *
 * Only while there is no account at all, or while CLEARPING_AUTH=off is set
 * to get back into an install whose password is lost. Every other account is
 * added by an admin, in Settings → Accounts.
 *
 * Either way the account is an admin: the first has to be, to set the rest
 * up, and one made to get back in is made to fix what locked everyone out.
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

  let user;
  try {
    user = await createUser(username, password, 'admin');
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not make the account' }, { status: 400 });
  }
  await recordActivity(actorOf(user), 'dashboard', 'account.create', recoveryMode() ? 'Made while CLEARPING_AUTH=off' : 'First account');

  // Signed in with it straight away, as Better Auth signs anyone in.
  const auth = await getAuth();
  const signedIn = await auth.api
    .signInUsername({ body: { username, password, rememberMe: true }, headers: request.headers, asResponse: true })
    .catch(() => null);
  const response = NextResponse.json({ username: user.username }, { status: 201 });
  return signedIn?.ok ? passCookies(signedIn, response, request) : response;
}
