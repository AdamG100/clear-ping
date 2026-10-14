import { NextRequest, NextResponse } from 'next/server';
import { identify, securityPolicy } from '@/lib/security/access';
import { getSsoConfig, ssoUsable } from '@/lib/security/oidc';
import { passkeySite } from '@/lib/security/http';
import { countPasskeys, countUsers } from '@/lib/security/store';

/**
 * GET /api/auth/status - What the sign-in page needs to know
 *
 * Whether sign-in is asked for, whether there is an account yet (and so
 * whether this page should offer to make one), and who is signed in. Open to
 * anyone: the page that asks is the one shown to people who are not signed in.
 */
export async function GET(request: NextRequest) {
  const [policy, accounts, { actor }, sso, passkeys] = await Promise.all([
    securityPolicy(),
    countUsers(),
    identify(request),
    getSsoConfig(),
    countPasskeys(),
  ]);
  return NextResponse.json({
    loginRequired: policy.loginRequired,
    accountExists: accounts > 0,
    // The first account is made here. After that, accounts are added by
    // someone already signed in, except while CLEARPING_AUTH=off is set.
    registrationOpen: accounts === 0 || policy.recovery,
    recovery: policy.recovery,
    passwordLogin: policy.passwordLogin,
    // Offered once there is a passkey to use, at an address passkeys work at.
    passkeys: policy.passwordLogin && passkeys > 0 && passkeySite(request) !== null,
    sso: ssoUsable(sso) ? { label: sso.label } : null,
    signedIn: actor?.kind === 'user' ? { username: actor.name, role: actor.role } : null,
  });
}
