import { NextRequest, NextResponse } from 'next/server';
import { identify } from '@/lib/security/access';
import { getAuth, SSO_PROVIDER_ID, ssoReady } from '@/lib/security/auth';
import { passCookies, refusal } from '@/lib/security/http';
import { getSsoConfig, safeNext, ssoUsable } from '@/lib/security/oidc';

/** Back to the sign-in page, saying why. A relative address, so it is right behind any proxy. */
function failed(message: string) {
  return new NextResponse(null, { status: 303, headers: { Location: `/login?error=${encodeURIComponent(message)}` } });
}

/**
 * GET /api/auth/sso/start?next=/path - Off to the identity provider to sign in
 * GET /api/auth/sso/start?link=1      - The same, to link it to the account signed in now
 *
 * Better Auth makes the request to the provider (the authorization code flow,
 * with PKCE, a state and a nonce) and keeps what the way back needs to check
 * the answer. Its cookies are handed on to the browser from here.
 */
export async function GET(request: NextRequest) {
  const config = await getSsoConfig();
  if (!ssoUsable(config)) return failed('Single sign-on is not set up');
  if (!(await ssoReady())) return failed(`${config.label} could not be reached. Try again in a minute.`);

  const link = request.nextUrl.searchParams.get('link') === '1';
  if (link && (await identify(request)).actor?.kind !== 'user') {
    return failed(`Sign in first, then link your ${config.label} account from Settings`);
  }

  const auth = await getAuth();
  const next = link ? '/settings/sso' : safeNext(request.nextUrl.searchParams.get('next'));
  const body = { provider: SSO_PROVIDER_ID, callbackURL: next, errorCallbackURL: '/login', disableRedirect: true };
  const answer = link
    ? await auth.api.linkSocialAccount({ headers: request.headers, body, asResponse: true })
    : await auth.api.signInSocial({ headers: request.headers, body, asResponse: true });
  const destination = answer.ok ? ((await answer.clone().json().catch(() => null)) as { url?: string } | null)?.url : null;
  if (!destination) return failed(await refusal(answer, `${config.label} could not be reached`));

  return passCookies(answer, new NextResponse(null, { status: 303, headers: { Location: destination } }), request);
}
