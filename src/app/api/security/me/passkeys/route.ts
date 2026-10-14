import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { removalProblem } from '@/lib/security/factors';
import { NO_PASSKEY_HERE, passCookies, passkeySite, refusal, requireUser } from '@/lib/security/http';
import { getFactorPolicy, getUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/security/me/passkeys - Add a passkey to your account
 * Body: { step: 'options' }, then { step: 'verify', response, name? }
 *
 * DELETE /api/security/me/passkeys?id=<id> - Remove one
 *
 * Better Auth's passkey plugin, through the instance for the site name this
 * page is open at: a passkey belongs to that name and works only there.
 */
export async function POST(request: NextRequest) {
  const actor = await requireUser(request);
  if (actor instanceof NextResponse) return actor;
  const user = await getUser(actor.id);
  if (!user?.hasPassword) {
    return NextResponse.json({ error: 'Your account signs in through single sign-on, which has its own second factor' }, { status: 400 });
  }
  const site = passkeySite(request);
  if (!site) return NextResponse.json({ error: NO_PASSKEY_HERE }, { status: 400 });

  const body = await request.json().catch(() => null);
  const auth = await getAuth(site);
  // Better Auth adds passkeys only from a session made within the last day.
  const stale = (reason: string) =>
    /fresh/i.test(reason) ? 'Sign out and in again to add a passkey: it is only done within a day of signing in.' : reason;

  if (body?.step === 'options') {
    const answer = await auth.api
      .generatePasskeyRegistrationOptions({ headers: request.headers, query: { name: user.username }, asResponse: true })
      .catch(() => null);
    if (!answer?.ok) {
      const reason = answer ? await refusal(answer, 'Could not start adding a passkey') : 'Could not start adding a passkey';
      return NextResponse.json({ error: stale(reason) }, { status: 400 });
    }
    return passCookies(answer, NextResponse.json(await answer.clone().json()), request);
  }

  if (body?.step !== 'verify' || !body.response || typeof body.response !== 'object') {
    return NextResponse.json({ error: 'Say which step: options, or verify with the response' }, { status: 400 });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : undefined;
  const answer = await auth.api
    .verifyPasskeyRegistration({ body: { response: body.response, name }, headers: request.headers, asResponse: true })
    .catch(() => null);
  if (!answer?.ok) {
    const reason = answer ? await refusal(answer, 'The passkey was not added') : 'The passkey was not added';
    return NextResponse.json({ error: stale(reason) }, { status: 400 });
  }
  await recordActivity(actor, 'dashboard', 'account.passkey.add', name ?? site);
  return passCookies(answer, NextResponse.json({ success: true }), request);
}

export async function DELETE(request: NextRequest) {
  const actor = await requireUser(request);
  if (actor instanceof NextResponse) return actor;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Say which passkey' }, { status: 400 });

  const user = await getUser(actor.id);
  if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  const problem = removalProblem(await getFactorPolicy(), { role: user.role, totp: user.twoFactor, passkeys: user.passkeys }, { factor: 'passkey' });
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const auth = await getAuth();
  const answer = await auth.api.deletePasskey({ body: { id }, headers: request.headers, asResponse: true }).catch(() => null);
  if (!answer?.ok) return NextResponse.json({ error: 'That passkey was not found' }, { status: 404 });
  await recordActivity(actor, 'dashboard', 'account.passkey.remove');
  return NextResponse.json({ success: true });
}
