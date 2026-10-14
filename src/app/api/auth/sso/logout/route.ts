import { NextRequest, NextResponse } from 'next/server';
import { discover, getSsoConfig, ssoUsable, verifyLogoutToken } from '@/lib/security/oidc';
import { actorOf, endSsoSessions, recordActivity } from '@/lib/security/store';

/** The answer the specification asks for: nothing to cache, and the reason when refused. */
function answer(status: number, error?: string) {
  return NextResponse.json(error ? { error: 'invalid_request', error_description: error } : {}, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * POST /api/auth/sso/logout - The identity provider saying someone has
 * signed out there (OpenID Connect Back-Channel Logout)
 *
 * Sent by the provider's server, not a browser, so there is no session or
 * cookie to go by: the signed logout token is the whole of the request's
 * authority. It ends the ClearPing sessions made from that sign-in. Authentik
 * sends one when someone logs out of Authentik, when an administrator ends
 * their session, and when their account is deactivated.
 */
export async function POST(request: NextRequest) {
  const config = await getSsoConfig();
  if (!ssoUsable(config)) return answer(400, 'Single sign-on is not set up');

  const form = await request.formData().catch(() => null);
  const token = form?.get('logout_token');
  if (typeof token !== 'string' || !token) return answer(400, 'No logout_token');

  let who;
  try {
    const discovery = await discover(config.issuer);
    who = await verifyLogoutToken(token, { discovery, clientId: config.clientId, clientSecret: config.clientSecret });
  } catch (error) {
    return answer(400, error instanceof Error ? error.message : 'The logout token was refused');
  }

  const users = await endSsoSessions(who.iss, who);
  for (const user of users) {
    await recordActivity(actorOf(user), 'dashboard', 'signout', `Signed out at ${config.label}`);
  }
  return answer(200);
}
