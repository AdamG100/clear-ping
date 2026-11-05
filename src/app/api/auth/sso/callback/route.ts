import { NextRequest, NextResponse } from 'next/server';
import { safeNext } from '@/lib/dashboard-pages';
import { getAuth, SSO_PROVIDER_ID } from '@/lib/security/auth';
import { passCookies } from '@/lib/security/http';
import { getSsoConfig } from '@/lib/security/oidc';

/** Better Auth's reasons for not signing someone in, said for the sign-in page. */
function reason(code: string | null, label: string, allowedGroup: string): string {
  switch (code) {
    case 'state_mismatch':
    case 'state_not_found':
    case 'invalid_state':
    case 'please_restart_the_process':
      return 'That sign-in had expired, or was not started here. Try again.';
    case 'unable_to_get_user_info':
      return allowedGroup
        ? `Your ${label} account is not in the group allowed to use ClearPing (${allowedGroup}), or ${label} did not say who you are.`
        : `${label} did not say who you are.`;
    case 'account_not_linked':
      return `That ${label} account is not linked to an account here. Sign in, then link it from Settings.`;
    case 'signup_disabled':
      return `No ClearPing account is linked to your ${label} account. Sign in with a password and link it from Settings, or ask an admin to have accounts made on first sign-in.`;
    case 'account_already_linked_to_different_user':
      return `That ${label} account already signs in as someone else here.`;
    case 'unable_to_link_account':
      return `Your account could not be linked to ${label}. Sign in, then link it from Settings.`;
    case 'access_denied':
      return `${label} did not sign you in.`;
    default:
      return `${label} could not sign you in${code ? ` (${code})` : ''}.`;
  }
}

/**
 * GET /api/auth/sso/callback - Back from the identity provider
 *
 * The address the provider was given as the redirect URI before sign-in moved
 * to Better Auth, and still the one it is given, so nothing has to change in
 * Authentik. The answer is handed to Better Auth's own callback, which checks
 * it was the sign-in this browser started (the state), trades the code for
 * tokens with the provider, checks the ID token's signature, issuer, audience
 * and nonce, and signs in, links, or makes the account (see auth.ts for what
 * ClearPing adds: the group, the role, the provider's session id).
 *
 * It answers with a redirect: to where the sign-in was headed, or to the
 * sign-in page saying why not.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuth();
  const target = new URL(`/api/auth/callback/${SSO_PROVIDER_ID}${request.nextUrl.search}`, request.url);
  const answer = await auth.handler(new Request(target, { method: 'GET', headers: request.headers }));

  // Better Auth sends a refusal to /login?error=<code>, or to its own error
  // page when it cannot tell where the sign-in came from. Either way, to the
  // sign-in page, in words.
  const location = answer.headers.get('location');
  const destination = location ? new URL(location, request.url) : null;
  const error = destination?.searchParams.get('error') ?? (destination ? null : 'sign_in_failed');
  let to: string;
  if (error || !destination || destination.pathname.startsWith('/api/auth/error')) {
    const { label, allowedGroup } = await getSsoConfig();
    to = `/login?error=${encodeURIComponent(reason(error, label, allowedGroup))}`;
  } else {
    // A path on this site, kept relative so it is right behind any proxy.
    // Never another site's address, whatever Better Auth was handed.
    to = safeNext(`${destination.pathname}${destination.search}`);
  }
  return passCookies(answer, new NextResponse(null, { status: 303, headers: { Location: to } }), request);
}
