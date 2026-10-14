import { NextRequest, NextResponse } from 'next/server';
import { identify, readCookie } from '@/lib/security/access';
import { clientAddress, isHttps, setSessionCookie } from '@/lib/security/http';
import {
  decodePending,
  getSsoConfig,
  inAllowedGroup,
  PENDING_COOKIE,
  redeemCode,
  ssoUsable,
  usernameFrom,
  type Pending,
} from '@/lib/security/oidc';
import { sameSecret } from '@/lib/security/secrets';
import { createSession, createSsoUser, linkSso, noteLogin, recordActivity, userForSso } from '@/lib/security/store';

/** Somewhere on this site, with the pending sign-in's cookie gone. */
function go(request: NextRequest, path: string) {
  const response = new NextResponse(null, { status: 303, headers: { Location: path } });
  response.cookies.set(PENDING_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: isHttps(request), path: '/api/auth/sso', maxAge: 0 });
  return response;
}

function failed(request: NextRequest, message: string) {
  return go(request, `/login?error=${encodeURIComponent(message)}`);
}

/**
 * GET /api/auth/sso/callback - Back from the identity provider
 *
 * The answer is taken only for the sign-in this browser started: the state
 * has to match the cookie set on the way out. The code is then traded for an
 * ID token directly with the provider, and the token checked, before anyone
 * is signed in.
 */
export async function GET(request: NextRequest) {
  const config = await getSsoConfig();
  const params = request.nextUrl.searchParams;
  const pending: Pending | null = decodePending(readCookie(request.headers.get('cookie'), PENDING_COOKIE));
  const state = params.get('state') ?? '';

  if (!pending || !state || !sameSecret(state, pending.state)) {
    return failed(request, 'That sign-in had expired, or was not started here. Try again.');
  }
  const refused = params.get('error');
  if (refused) {
    return failed(request, `${config.label} did not sign you in: ${params.get('error_description') || refused}`);
  }
  if (!ssoUsable(config)) return failed(request, 'Single sign-on is not set up');

  const code = params.get('code');
  if (!code) return failed(request, `${config.label} sent no code back`);

  let claims;
  try {
    claims = await redeemCode(code, pending, config);
  } catch (error) {
    return failed(request, error instanceof Error ? error.message : 'The sign-in could not be completed');
  }

  const who = usernameFrom(claims);
  if (!inAllowedGroup(claims, config.allowedGroup)) {
    await recordActivity({ kind: 'anonymous', name: who }, 'dashboard', 'signin.failed', `${config.label}: not in ${config.allowedGroup}`);
    return failed(request, `Your ${config.label} account is not in the group allowed to use ClearPing (${config.allowedGroup})`);
  }

  // Linking: to the account signed in now, never to one named in the cookie.
  if (pending.link) {
    const { actor } = await identify(request);
    if (actor?.kind !== 'user') return failed(request, 'Sign in first, then link your account from Security');
    try {
      await linkSso(actor.id, claims.iss, claims.sub);
    } catch (error) {
      return failed(request, error instanceof Error ? error.message : 'Could not link the account');
    }
    await recordActivity(actor, 'dashboard', 'account.sso.link', `${config.label}: ${who}`);
    return go(request, pending.next);
  }

  let user = await userForSso(claims.iss, claims.sub);
  if (!user) {
    if (!config.autoCreate) {
      await recordActivity({ kind: 'anonymous', name: who }, 'dashboard', 'signin.failed', `${config.label}: no linked account`);
      return failed(
        request,
        `No ClearPing account is linked to ${who}. Sign in with a password and link it from Security, or have new accounts made on first sign-in.`
      );
    }
    user = await createSsoUser(who, claims.iss, claims.sub);
    await recordActivity({ kind: 'user', id: user.id, name: user.username }, 'dashboard', 'account.create', `First sign-in with ${config.label}`);
  }

  await noteLogin(user.id);
  const session = await createSession(user.id);
  await recordActivity({ kind: 'user', id: user.id, name: user.username }, 'dashboard', 'signin', `With ${config.label}, from ${clientAddress(request)}`);

  const response = go(request, pending.next);
  setSessionCookie(response, request, session.token, session.expiresAt);
  return response;
}
