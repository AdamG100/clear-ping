import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { getSsoConfig } from '@/lib/security/oidc';
import { getUser, recordActivity, unlinkSso } from '@/lib/security/store';

/**
 * DELETE /api/security/sso/link - Stop your account signing in through the provider
 *
 * Linking is done by signing in through it: /api/auth/sso/start?link=1.
 * Unlinking an account that has no password would leave no way into it.
 */
export async function DELETE(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const [me, sso] = await Promise.all([getUser(user.id), getSsoConfig()]);
  if (!me?.sso) return NextResponse.json({ error: 'Your account is not linked' }, { status: 400 });
  if (!me.hasPassword) {
    return NextResponse.json(
      { error: `Your account was made by signing in with ${sso.label} and has no password, so it can only sign in that way` },
      { status: 400 }
    );
  }

  await unlinkSso(user.id);
  await recordActivity(user, 'dashboard', 'account.sso.unlink', sso.label);
  return NextResponse.json({ success: true });
}
