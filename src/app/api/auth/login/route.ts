import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { addressKeys, clientAddress, loginLockedFor, noteLoginFailure, noteLoginSuccess, passCookies, refusal } from '@/lib/security/http';
import { securityPolicy } from '@/lib/security/access';
import { askForPasskey, factorStillOwed } from '@/lib/security/step-up';
import { actorOf, findUserByUsername, getUser, recordActivity, signInTrouble } from '@/lib/security/store';

/**
 * POST /api/auth/login - Sign in
 * Body: { username, password }
 *
 * Better Auth checks the password and makes the session. One answer for a
 * wrong username and a wrong password, so the page says nothing about which
 * accounts exist; and repeated failures are slowed down.
 *
 * An account with an authenticator app is not signed in yet: Better Auth
 * answers { twoFactor: true } with a cookie that lets the code be checked
 * next, at /api/auth/two-factor, unless this browser was trusted then.
 *
 * Nor is one an admin requires a passkey of: it is answered { passkey: true },
 * with no session, and signs in at /api/auth/passkey (step-up.ts).
 */
export async function POST(request: NextRequest) {
  if (!(await securityPolicy()).passwordLogin) {
    return NextResponse.json({ error: 'Signing in with a password is turned off here: use single sign-on' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const address = clientAddress(request);
  const keys = [...addressKeys(address), `user:${username.toLowerCase()}`];

  const wait = loginLockedFor(keys);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'Retry-After': String(wait) } }
    );
  }

  const auth = await getAuth();
  // A refusal from one of ClearPing's hooks arrives as a throw, not an answer.
  let thrown: string | null = null;
  const answer =
    username && password
      ? await auth.api
          .signInUsername({ body: { username, password, rememberMe: true }, headers: request.headers, asResponse: true })
          .catch((error: unknown) => {
            thrown = error instanceof Error ? error.message : String(error);
            return null;
          })
      : null;
  const signedIn = answer?.ok
    ? ((await answer.clone().json().catch(() => null)) as { user?: { id: string }; token?: string; twoFactorRedirect?: boolean } | null)
    : null;

  // The password was right; the code is next, unless it is a passkey that is required.
  if (answer?.ok && signedIn?.twoFactorRedirect) {
    noteLoginSuccess(keys);
    const account = await findUserByUsername(username);
    if (account && (await factorStillOwed(account, [])) === 'passkey') return askForPasskey(answer, request, {});
    return passCookies(answer, NextResponse.json({ twoFactor: true }), request);
  }
  const user = signedIn?.user ? await getUser(signedIn.user.id) : null;

  if (!answer?.ok || !user) {
    noteLoginFailure(keys);
    // The page says only "wrong username or password"; the log says which.
    const said = thrown ?? (answer ? await refusal(answer.clone(), `answered ${answer.status}`) : 'nothing was checked');
    console.warn(`[Sign-in] "${username}" from ${address} was refused: ${await signInTrouble(username, said)}`);
    await recordActivity({ kind: 'anonymous', name: username || 'Unknown' }, 'dashboard', 'signin.failed', `From ${address}`);
    return NextResponse.json({ error: 'Wrong username or password' }, { status: 401 });
  }

  noteLoginSuccess(keys);
  // Better Auth asks an account with the app for its code unless this browser
  // is trusted, so here the app counts as used.
  if ((await factorStillOwed(user, user.twoFactor ? ['totp'] : [])) === 'passkey') {
    return askForPasskey(answer, request, { sessionToken: signedIn?.token, codeUsedBy: user.twoFactor ? user.id : undefined });
  }
  await recordActivity(actorOf(user), 'dashboard', 'signin', `From ${address}`);
  return passCookies(answer, NextResponse.json({ username: user.username }), request);
}
