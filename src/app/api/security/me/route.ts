import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { passkeySite, requireUser } from '@/lib/security/http';
import { getFactorPolicy, getUser, signedIn } from '@/lib/security/store';

/**
 * GET /api/security/me - Your second factors, and what is required of you
 *
 * What the Sign-in settings and the page that asks for missing factors show:
 * whether an authenticator app is set up, the passkeys, the rule an admin set
 * and what it still asks of this account. Reachable while factors are owed.
 */
export async function GET(request: NextRequest) {
  const actor = await requireUser(request);
  if (actor instanceof NextResponse) return actor;

  const [found, user, policy] = await Promise.all([signedIn(request.headers), getUser(actor.id), getFactorPolicy()]);
  if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const auth = await getAuth();
  const passkeys = (await auth.api.listPasskeys({ headers: request.headers }).catch(() => [])) as Array<{
    id: string;
    name?: string | null;
    createdAt: string | Date;
    deviceType: string;
    backedUp: boolean;
  }>;

  return NextResponse.json({
    username: user.username,
    role: user.role,
    hasPassword: user.hasPassword,
    sso: user.sso,
    viaSso: found?.viaSso ?? false,
    twoFactor: user.twoFactor,
    passkeys: passkeys.map(each => ({
      id: each.id,
      name: each.name || 'Passkey',
      createdAt: new Date(each.createdAt).getTime(),
      synced: each.backedUp,
    })),
    policy,
    owes: actor.owes ?? null,
    // Whether passkeys can be made at the address this page is open at.
    passkeysHere: passkeySite(request) !== null,
  });
}
