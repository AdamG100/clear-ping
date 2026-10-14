import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { removalProblem } from '@/lib/security/factors';
import { passCookies, refusal, requireUser } from '@/lib/security/http';
import { getFactorPolicy, getUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/security/me/two-factor - Your authenticator app
 * Body: { action: 'enable', password }  - start: the code to scan and the backup codes
 *       { action: 'verify', code }      - finish: a code from the app, which turns it on
 *       { action: 'disable', password } - turn it off
 *       { action: 'backup-codes', password } - new backup codes, the old ones stop working
 *
 * All of it Better Auth's two-factor plugin. Only for an account that signs
 * in with a password: one that signs in through single sign-on has its
 * provider's second factor instead.
 */
export async function POST(request: NextRequest) {
  const actor = await requireUser(request);
  if (actor instanceof NextResponse) return actor;
  const user = await getUser(actor.id);
  if (!user?.hasPassword) {
    return NextResponse.json({ error: 'Your account signs in through single sign-on, which has its own second factor' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === 'string' ? body.password : '';
  const auth = await getAuth();
  const wrongPassword = (reason: string) => /invalid password|password/i.test(reason);

  switch (body?.action) {
    case 'enable': {
      if (!password) return NextResponse.json({ error: 'Type your password' }, { status: 400 });
      const answer = await auth.api
        .enableTwoFactor({ body: { password }, headers: request.headers, asResponse: true })
        .catch(() => null);
      if (!answer?.ok) {
        const reason = answer ? await refusal(answer, 'Could not start setting up the app') : 'Could not start setting up the app';
        return NextResponse.json({ error: wrongPassword(reason) ? 'Your password is not right' : reason }, { status: 400 });
      }
      const { totpURI, backupCodes } = (await answer.clone().json()) as { totpURI: string; backupCodes: string[] };
      return passCookies(answer, NextResponse.json({ totpURI, backupCodes }), request);
    }

    case 'verify': {
      const code = typeof body?.code === 'string' ? body.code.replace(/\s+/g, '') : '';
      if (!code) return NextResponse.json({ error: 'Type the code the app shows' }, { status: 400 });
      const answer = await auth.api.verifyTOTP({ body: { code }, headers: request.headers, asResponse: true }).catch(() => null);
      if (!answer?.ok) return NextResponse.json({ error: 'That code is not right. Check the time on your phone is set automatically.' }, { status: 400 });
      await recordActivity(actor, 'dashboard', 'account.2fa.enable');
      return passCookies(answer, NextResponse.json({ success: true }), request);
    }

    case 'disable': {
      const problem = removalProblem(await getFactorPolicy(), { role: user.role, totp: user.twoFactor, passkeys: user.passkeys }, { factor: 'totp' });
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      if (!password) return NextResponse.json({ error: 'Type your password' }, { status: 400 });
      const answer = await auth.api
        .disableTwoFactor({ body: { password }, headers: request.headers, asResponse: true })
        .catch(() => null);
      if (!answer?.ok) {
        const reason = answer ? await refusal(answer, 'Could not turn it off') : 'Could not turn it off';
        return NextResponse.json({ error: wrongPassword(reason) ? 'Your password is not right' : reason }, { status: 400 });
      }
      await recordActivity(actor, 'dashboard', 'account.2fa.disable');
      return passCookies(answer, NextResponse.json({ success: true }), request);
    }

    case 'backup-codes': {
      if (!password) return NextResponse.json({ error: 'Type your password' }, { status: 400 });
      const answer = await auth.api
        .generateBackupCodes({ body: { password }, headers: request.headers, asResponse: true })
        .catch(() => null);
      if (!answer?.ok) {
        const reason = answer ? await refusal(answer, 'Could not make new codes') : 'Could not make new codes';
        return NextResponse.json({ error: wrongPassword(reason) ? 'Your password is not right' : reason }, { status: 400 });
      }
      const { backupCodes } = (await answer.clone().json()) as { backupCodes: string[] };
      await recordActivity(actor, 'dashboard', 'account.2fa.codes');
      return NextResponse.json({ backupCodes });
    }

    default:
      return NextResponse.json({ error: 'Say what to do: enable, verify, disable or backup-codes' }, { status: 400 });
  }
}
