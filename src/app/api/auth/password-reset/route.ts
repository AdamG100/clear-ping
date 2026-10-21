import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/security/auth';
import { addressKeys, clientAddress, loginLockedFor, noteLoginFailure, noteLoginSuccess, refusal } from '@/lib/security/http';
import { securityPolicy } from '@/lib/security/access';
import { passwordProblem } from '@/lib/security/secrets';
import { findUserByUsername, recordActivity } from '@/lib/security/store';

/**
 * POST /api/auth/password-reset - The primary account's forgotten password, with a code from the server's log
 *
 *   { step: 'ask', username }        writes a code for the account to the log
 *   { step: 'reset', code, password } sets the new password with it
 *
 * Better Auth makes the code, keeps it, lets it be used once within a quarter
 * of an hour and sets the password (auth.ts, sendResetPassword). Reading the
 * log is what proves the right to it: that takes access to the machine
 * ClearPing runs on, which is the primary account's owner. Every other
 * account's password is set by an admin (/api/security/users/:id/password),
 * or chosen by its owner with a password link an admin made
 * (/api/security/users/:id/link), whose code comes to the 'reset' step here.
 *
 * Asking answers the same whether or not the account exists or is the
 * primary one, so the page says nothing about either; the log says which.
 * Both steps are slowed down when repeated, as signing in is.
 */
export async function POST(request: NextRequest) {
  if (!(await securityPolicy()).passwordLogin) {
    return NextResponse.json({ error: 'Signing in with a password is turned off here: use single sign-on' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const address = clientAddress(request);

  if (body?.step === 'ask') {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username) return NextResponse.json({ error: 'Type your username' }, { status: 400 });

    // Every ask counts, so the log cannot be flooded with codes.
    const keys = [...addressKeys(address), `reset:${username.toLowerCase()}`];
    const wait = loginLockedFor(keys);
    if (wait > 0) return tooMany(wait);
    noteLoginFailure(keys);

    const user = await findUserByUsername(username);
    if (user?.primary) {
      const auth = await getAuth();
      await auth.api.requestPasswordReset({ body: { email: user.email } });
    } else {
      console.warn(
        `[Sign-in] A password reset code was asked for "${username}" from ${address}, but ` +
          (user
            ? 'it is not the primary account: an admin sets its password in Settings → Accounts'
            : 'there is no account by that name')
      );
    }
    await recordActivity({ kind: 'anonymous', name: username }, 'dashboard', 'account.password.reset.asked', `From ${address}`);
    return NextResponse.json({ asked: true });
  }

  if (body?.step === 'reset') {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const problem = passwordProblem(body.password);
    if (!code) return NextResponse.json({ error: 'Type the code from the server log' }, { status: 400 });
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    // Counted by address only. The code is 24 random letters and digits, out
    // of reach of guessing, and one count shared by everyone would let anyone
    // stop the owner typing theirs.
    const keys = addressKeys(address);
    const wait = loginLockedFor(keys);
    if (wait > 0) return tooMany(wait);

    const auth = await getAuth();
    const reset = await auth.api
      .resetPassword({ body: { token: code, newPassword: body.password }, asResponse: true })
      .catch(() => null);
    if (!reset?.ok) {
      noteLoginFailure(keys);
      const reason = reset ? await refusal(reset, '') : '';
      return NextResponse.json(
        { error: /token/i.test(reason) || !reason ? 'That code is not right, or it has run out. Ask for a new one.' : reason },
        { status: 400 }
      );
    }
    noteLoginSuccess(keys);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Unknown step' }, { status: 400 });
}

function tooMany(wait: number): NextResponse {
  return NextResponse.json(
    { error: `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` },
    { status: 429, headers: { 'Retry-After': String(wait) } }
  );
}
