import { NextRequest, NextResponse } from 'next/server';
import { recoveryMode } from '@/lib/security/access';
import { getAuth } from '@/lib/security/auth';
import { passCookies } from '@/lib/security/http';
import { passwordProblem } from '@/lib/security/secrets';
import { setupCodeMatches } from '@/lib/security/setup-code';
import { actorOf, countUsers, createUser, makePrimary, recordActivity } from '@/lib/security/store';

/**
 * POST /api/auth/register - Make the first account, and sign in with it
 * Body: { username, password }
 *
 * Only while there is no account at all, and with the setup code, or while CLEARPING_AUTH=off is set
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

  const first = (await countUsers()) === 0;
  if (!first && !recoveryMode()) {
    return NextResponse.json({ error: 'There is already an account. Sign in, and add others from the security settings.' }, { status: 403 });
  }
  // The first account is an admin, so it is not for whoever gets here first:
  // the code is in the server's log (see setup-code.ts).
  if (!recoveryMode() && !setupCodeMatches(body?.setupCode)) {
    return NextResponse.json({ error: 'The setup code is missing or wrong. It is in the ClearPing server log, or is CLEARPING_SETUP_CODE if you set that.' }, { status: 403 });
  }
  const problem = passwordProblem(password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  let user;
  try {
    user = await createUser(username, password, 'admin');
    // The first account belongs to whoever runs the server: the primary one.
    // One made later with CLEARPING_AUTH=off is an admin like any other.
    if (first) await makePrimary(user.id);
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
