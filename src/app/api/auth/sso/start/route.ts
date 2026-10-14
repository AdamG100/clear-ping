import { NextRequest, NextResponse } from 'next/server';
import { identify } from '@/lib/security/access';
import { isHttps } from '@/lib/security/http';
import {
  authorizationUrl,
  discover,
  encodePending,
  getSsoConfig,
  newPending,
  PENDING_COOKIE,
  PENDING_LIFETIME_S,
  safeNext,
  ssoUsable,
} from '@/lib/security/oidc';

/** Back to the sign-in page, saying why. A relative address, so it is right behind any proxy. */
function failed(message: string) {
  return new NextResponse(null, { status: 303, headers: { Location: `/login?error=${encodeURIComponent(message)}` } });
}

/**
 * GET /api/auth/sso/start?next=/path - Off to the identity provider to sign in
 * GET /api/auth/sso/start?link=1      - The same, to link it to the account signed in now
 *
 * What the way back needs to check the answer (the state, the nonce and the
 * PKCE verifier) goes with the browser in a short-lived cookie that only the
 * callback is sent.
 */
export async function GET(request: NextRequest) {
  const config = await getSsoConfig();
  if (!ssoUsable(config)) return failed('Single sign-on is not set up');

  const link = request.nextUrl.searchParams.get('link') === '1';
  if (link && (await identify(request)).actor?.kind !== 'user') {
    return failed(`Sign in first, then link your ${config.label} account from Security`);
  }

  let destination: string;
  const pending = newPending(safeNext(request.nextUrl.searchParams.get('next')), link);
  try {
    destination = authorizationUrl(await discover(config.issuer), config, pending);
  } catch (error) {
    return failed(`${config.label} could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  const response = new NextResponse(null, { status: 303, headers: { Location: destination } });
  response.cookies.set(PENDING_COOKIE, encodePending(pending), {
    httpOnly: true,
    // Lax, not Strict: the provider sending the browser back is a link from
    // another site, and Strict would leave the cookie behind.
    sameSite: 'lax',
    secure: isHttps(request),
    path: '/api/auth/sso',
    maxAge: PENDING_LIFETIME_S,
  });
  return response;
}
