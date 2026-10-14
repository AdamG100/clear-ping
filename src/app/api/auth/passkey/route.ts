import { NextRequest, NextResponse } from 'next/server';
import { securityPolicy } from '@/lib/security/access';
import { getAuth } from '@/lib/security/auth';
import { clientAddress, loginLockedFor, noteLoginFailure, noteLoginSuccess, NO_PASSKEY_HERE, passCookies, passkeySite } from '@/lib/security/http';
import { actorOf, getUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/auth/passkey - Sign in with a passkey
 * Body: { step: 'options' }, then { step: 'verify', response }
 *
 * Two calls, as WebAuthn is. The first has Better Auth make a challenge for
 * this site name (kept in a cookie for five minutes) and returns what the
 * browser's passkey prompt is opened with; the second hands Better Auth what
 * the passkey signed, which it checks and makes the session from. No password
 * and no code: a passkey is something held and something unlocked already.
 */
export async function POST(request: NextRequest) {
  if (!(await securityPolicy()).passwordLogin) {
    return NextResponse.json({ error: 'Signing in here is turned off: use single sign-on' }, { status: 403 });
  }
  const site = passkeySite(request);
  if (!site) return NextResponse.json({ error: NO_PASSKEY_HERE }, { status: 400 });

  const body = await request.json().catch(() => null);
  const auth = await getAuth(site);

  if (body?.step === 'options') {
    const answer = await auth.api
      .generatePasskeyAuthenticationOptions({ headers: request.headers, asResponse: true })
      .catch(() => null);
    if (!answer?.ok) return NextResponse.json({ error: 'Could not start signing in with a passkey' }, { status: 500 });
    return passCookies(answer, NextResponse.json(await answer.clone().json()), request);
  }

  if (body?.step !== 'verify' || !body.response || typeof body.response !== 'object') {
    return NextResponse.json({ error: 'Say which step: options, or verify with the response' }, { status: 400 });
  }

  const address = clientAddress(request);
  const keys = [`address:${address}`];
  const wait = loginLockedFor(keys);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'Retry-After': String(wait) } }
    );
  }

  const answer = await auth.api
    .verifyPasskeyAuthentication({ body: { response: body.response }, headers: request.headers, asResponse: true })
    .catch(() => null);
  const verified = answer?.ok ? ((await answer.clone().json().catch(() => null)) as { session?: { userId: string } } | null) : null;
  const user = verified?.session?.userId ? await getUser(verified.session.userId) : null;

  if (!answer?.ok || !user) {
    noteLoginFailure(keys);
    await recordActivity({ kind: 'anonymous', name: 'Unknown' }, 'dashboard', 'signin.failed', `With a passkey, from ${address}`);
    return NextResponse.json({ error: 'That passkey was not accepted. It may be for another account, or removed.' }, { status: 401 });
  }

  noteLoginSuccess(keys);
  await recordActivity(actorOf(user), 'dashboard', 'signin', `With a passkey, from ${address}`);
  return passCookies(answer, NextResponse.json({ username: user.username }), request);
}
