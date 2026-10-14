import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { passCookies } from '@/lib/security/http';
import { discover, endSessionUrl, getSsoConfig, ssoUsable } from '@/lib/security/oidc';
import { sessionSso } from '@/lib/security/store';

/**
 * Where to go to sign out at the identity provider too, for a session that
 * was signed in through it. Null for any other session, when that is turned
 * off, or when the provider cannot be asked.
 */
async function providerSignOut(headers: Headers): Promise<string | null> {
  const origin = await sessionSso(headers);
  if (!origin) return null;
  const config = await getSsoConfig();
  if (!ssoUsable(config) || !config.signOutAtProvider) return null;
  try {
    const discovery = await discover(config.issuer);
    // Back to the sign-in page, at the address the provider already knows this site by.
    return endSessionUrl(discovery, config, origin.idToken, new URL('/login', config.redirectUri).href);
  } catch {
    // Signing out here must not wait on, or fail with, the provider.
    return null;
  }
}

/**
 * POST /api/auth/logout - Sign out: Better Auth ends the session on the
 * server, not only in the browser. For a session signed in through the
 * identity provider, the answer's `redirect` is where to send the browser to
 * sign out there as well.
 */
export async function POST(request: NextRequest) {
  const redirect = await providerSignOut(request.headers);
  const auth = await getAuth();
  const signedOut = await auth.api.signOut({ headers: request.headers, body: { disableRedirect: true }, asResponse: true });
  return passCookies(signedOut, NextResponse.json({ success: true, redirect }), request);
}
