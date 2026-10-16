import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { addressKeys, clientAddress, loginLockedFor, noteLoginFailure, noteLoginSuccess, passCookies, refusal } from '@/lib/security/http';
import { actorOf, getUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/auth/two-factor - The second step of signing in with a password
 * Body: { code, backup?: boolean, trustDevice?: boolean }
 *
 * After /api/auth/login answered { twoFactor: true }: the code from the
 * account's authenticator app, or one of its backup codes. Better Auth checks
 * it against the sign-in the cookie from that step names, and makes the
 * session. `trustDevice` skips this step in this browser for 30 days.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  const backup = body?.backup === true;
  const trustDevice = body?.trustDevice === true;
  const address = clientAddress(request);
  const keys = addressKeys(address);

  const wait = loginLockedFor(keys);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'Retry-After': String(wait) } }
    );
  }
  if (!code) return NextResponse.json({ error: 'Type the code' }, { status: 400 });

  const auth = await getAuth();
  const answer = await (backup
    ? auth.api.verifyBackupCode({ body: { code, trustDevice }, headers: request.headers, asResponse: true })
    : auth.api.verifyTOTP({ body: { code, trustDevice }, headers: request.headers, asResponse: true })
  ).catch(() => null);
  const verified = answer?.ok ? ((await answer.clone().json().catch(() => null)) as { user?: { id: string } } | null) : null;
  const user = verified?.user ? await getUser(verified.user.id) : null;

  if (!answer?.ok || !user) {
    noteLoginFailure(keys);
    const reason = answer ? await refusal(answer, '') : '';
    // The step's cookie lasts ten minutes; after that the password is asked for again.
    const expired = /invalid two factor cookie|two factor cookie/i.test(reason);
    const locked = /locked/i.test(reason);
    return NextResponse.json(
      {
        error: expired
          ? 'That took too long. Sign in again.'
          : locked
            ? 'Too many wrong codes: this account cannot finish signing in for a quarter of an hour.'
            : backup
              ? 'That backup code is not right, or has been used'
              : 'That code is not right',
        restart: expired,
      },
      { status: 401 }
    );
  }

  noteLoginSuccess(keys);
  await recordActivity(actorOf(user), 'dashboard', 'signin', `With ${backup ? 'a backup code' : 'an authenticator code'}, from ${address}`);
  return passCookies(answer, NextResponse.json({ username: user.username }), request);
}
