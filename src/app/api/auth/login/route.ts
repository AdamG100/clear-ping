import { NextRequest, NextResponse } from 'next/server';
import { clientAddress, loginLockedFor, noteLoginFailure, noteLoginSuccess, setSessionCookie } from '@/lib/security/http';
import { securityPolicy } from '@/lib/security/access';
import { checkLogin, createSession, recordActivity } from '@/lib/security/store';

/**
 * POST /api/auth/login - Sign in
 * Body: { username, password }
 *
 * One answer for a wrong username and a wrong password, so the page says
 * nothing about which accounts exist; and repeated failures are slowed down.
 */
export async function POST(request: NextRequest) {
  if (!(await securityPolicy()).passwordLogin) {
    return NextResponse.json({ error: 'Signing in with a password is turned off here: use single sign-on' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const address = clientAddress(request);
  const keys = [`address:${address}`, `user:${username.toLowerCase()}`];

  const wait = loginLockedFor(keys);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'Retry-After': String(wait) } }
    );
  }

  const user = username && password ? await checkLogin(username, password) : null;
  if (!user) {
    noteLoginFailure(keys);
    await recordActivity({ kind: 'anonymous', name: username || 'Unknown' }, 'dashboard', 'signin.failed', `From ${address}`);
    return NextResponse.json({ error: 'Wrong username or password' }, { status: 401 });
  }

  noteLoginSuccess(keys);
  const session = await createSession(user.id);
  await recordActivity({ kind: 'user', id: user.id, name: user.username }, 'dashboard', 'signin', `From ${address}`);

  const response = NextResponse.json({ username: user.username });
  setSessionCookie(response, request, session.token, session.expiresAt);
  return response;
}
