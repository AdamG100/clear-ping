import { NextRequest, NextResponse } from 'next/server';
import { identify, securityPolicy } from '@/lib/security/access';
import { countUsers } from '@/lib/security/store';

/**
 * GET /api/auth/status - What the sign-in page needs to know
 *
 * Whether sign-in is asked for, whether there is an account yet (and so
 * whether this page should offer to make one), and who is signed in. Open to
 * anyone: the page that asks is the one shown to people who are not signed in.
 */
export async function GET(request: NextRequest) {
  const [policy, accounts, { actor }] = await Promise.all([securityPolicy(), countUsers(), identify(request)]);
  return NextResponse.json({
    loginRequired: policy.loginRequired,
    accountExists: accounts > 0,
    // The first account is made here. After that, accounts are added by
    // someone already signed in, except while CLEARPING_AUTH=off is set.
    registrationOpen: accounts === 0 || policy.recovery,
    recovery: policy.recovery,
    signedIn: actor?.kind === 'user' ? { username: actor.name } : null,
  });
}
