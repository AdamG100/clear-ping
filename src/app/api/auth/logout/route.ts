import { NextRequest, NextResponse } from 'next/server';
import { readCookie } from '@/lib/security/access';
import { clearSessionCookie } from '@/lib/security/http';
import { discover, endSessionUrl, getSsoConfig, ssoUsable } from '@/lib/security/oidc';
import { endSession, sessionSso, SESSION_COOKIE } from '@/lib/security/store';

/**
 * Where to go to sign out at the identity provider too, for a session that
 * was signed in through it. Null for any other session, when that is turned
 * off, or when the provider cannot be asked.
 */
async function providerSignOut(token: string): Promise<string | null> {
  const origin = await sessionSso(token);
  if (!origin) return null;
  const config = await getSsoConfig();
  if (!ssoUsable(config) || !config.signOutAtProvider || origin.issuer.replace(/\/$/, '') !== config.issuer.replace(/\/$/, '')) {
    return null;
  }
  try {
    const discovery = await discover(config.issuer);
    // Back to the sign-in page, at the address the provider already knows this site by.
    return endSessionUrl(discovery, config, origin.idToken || null, new URL('/login', config.redirectUri).href);
  } catch {
    // Signing out here must not wait on, or fail with, the provider.
    return null;
  }
}

/**
 * POST /api/auth/logout - Sign out: the session is ended on the server, not
 * only forgotten by the browser. For a session signed in through the identity
 * provider, the answer's `redirect` is where to send the browser to sign out
 * there as well.
 */
export async function POST(request: NextRequest) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const redirect = token ? await providerSignOut(token) : null;
  if (token) await endSession(token);

  const response = NextResponse.json({ success: true, redirect });
  clearSessionCookie(response, request);
  return response;
}
