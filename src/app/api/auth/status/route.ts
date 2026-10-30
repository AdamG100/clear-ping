import { NextRequest, NextResponse } from 'next/server';
import { identify, securityPolicy } from '@/lib/security/access';
import { getSsoConfig, ssoUsable } from '@/lib/security/oidc';
import { passkeySite } from '@/lib/security/http';
import { isSetupAdviceDismissed } from '@/lib/security/settings-store';
import { shouldAdviseSignIn } from '@/lib/security/setup-advice';
import { countPasskeys, countUsers } from '@/lib/security/store';

/**
 * GET /api/auth/status - What the sign-in page needs to know
 *
 * Whether sign-in is asked for, whether there is an account yet (and so
 * whether this page should offer to make one), and who is signed in. Open to
 * anyone: the page that asks is the one shown to people who are not signed in.
 */
export async function GET(request: NextRequest) {
  const [policy, accounts, { actor }, sso, passkeys, dismissed] = await Promise.all([
    securityPolicy(),
    countUsers(),
    identify(request),
    getSsoConfig(),
    countPasskeys(),
    isSetupAdviceDismissed(),
  ]);
  return NextResponse.json({
    loginRequired: policy.loginRequired,
    // Anyone may look, but changing things asks for an account.
    changesNeedSignIn: policy.changesNeedSignIn,
    accountExists: accounts > 0,
    // The first account is made here. After that, accounts are added by
    // someone already signed in, except while CLEARPING_AUTH=off is set.
    registrationOpen: accounts === 0 || policy.recovery,
    recovery: policy.recovery,
    // The first account asks for the code in the server's log.
    setupCodeRequired: accounts === 0 && !policy.recovery,
    passwordLogin: policy.passwordLogin,
    // Offered once there is a passkey to use, at an address passkeys work at.
    passkeys: policy.passwordLogin && passkeys > 0 && passkeySite(request) !== null,
    sso: ssoUsable(sso) ? { label: sso.label } : null,
    signedIn: actor?.kind === 'user' ? { username: actor.name, role: actor.role } : null,
    // The dashboard asks for sign-in or single sign-on while this is open to
    // anyone who can reach it. Single sign-on being usable is not enough to
    // stop asking: the API stays open until sign-in is required.
    adviseSignIn: shouldAdviseSignIn({ loginRequired: policy.loginRequired, recovery: policy.recovery, dismissed }),
  });
}
