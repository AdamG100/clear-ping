import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { readCookie } from './access'
import { getAuth } from './auth'
import { factorToProve, type Factor } from './factors'
import { isHttps, passCookies } from './http'
import { getFactorPolicy, recoveryMode } from './settings-store'
import type { User } from './store'

/**
 * Holding a sign-in back until the factors an admin requires have been used.
 *
 * Better Auth checks each factor and makes a session as soon as one passes.
 * When the policy (factors.ts) asks for more, that session is ended before its
 * cookie reaches the browser, and the browser is told what to do next. A
 * passkey signs in by itself, so the next step needs nothing carried over,
 * except under a policy that wants the app's code as well: that one code,
 * already checked, is remembered for ten minutes, for this browser, once.
 */

const PROOF_COOKIE = 'clearping.totp_proved'
const PROOF_MINUTES = 10

/** The factor still to be used before this account gets a session, or null. Not while CLEARPING_AUTH=off is set: that is for getting back in. */
export async function factorStillOwed(user: Pick<User, 'role' | 'twoFactor' | 'passkeys'>, used: Factor[]): Promise<Factor | null> {
  if (recoveryMode()) return null
  return factorToProve(await getFactorPolicy(), { role: user.role, totp: user.twoFactor, passkeys: user.passkeys }, used)
}

/** End a session Better Auth has just made, whose cookie will not be handed on. */
export async function endHeldSession(token: string | undefined): Promise<void> {
  if (!token) return
  const context = await (await getAuth()).$context
  await context.internalAdapter.deleteSession(token)
}

/**
 * The answer that asks for a passkey to finish signing in. Of the cookies
 * Better Auth set, only "trust this browser" is handed on: never the session.
 * `codeUsedBy` is the account whose code has just been checked, when the
 * policy wants the passkey as well as the code.
 */
export async function askForPasskey(
  answer: Response,
  request: Request,
  { sessionToken, codeUsedBy }: { sessionToken?: string; codeUsedBy?: string }
): Promise<NextResponse> {
  await endHeldSession(sessionToken)
  const response = passCookies(answer, NextResponse.json({ passkey: true }), request, line => /^[^=]*trust_device=/.test(line))
  if (codeUsedBy) {
    const proof = randomBytes(32).toString('base64url')
    const context = await (await getAuth()).$context
    await context.internalAdapter.createVerificationValue({
      identifier: `totp-proved-${proof}`,
      value: codeUsedBy,
      expiresAt: new Date(Date.now() + PROOF_MINUTES * 60_000),
    })
    response.cookies.set(PROOF_COOKIE, proof, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps(request),
      path: '/api/auth',
      maxAge: PROOF_MINUTES * 60,
    })
  }
  return response
}

/** The account this browser has just used its code for, if any. Works once. */
export async function takeCodeProof(request: Request): Promise<string | null> {
  const proof = readCookie(request.headers.get('cookie'), PROOF_COOKIE)
  if (!proof) return null
  const identifier = `totp-proved-${proof}`
  const context = await (await getAuth()).$context
  const found = await context.internalAdapter.findVerificationValue(identifier)
  if (!found) return null
  await context.internalAdapter.deleteVerificationByIdentifier(identifier)
  return new Date(found.expiresAt).getTime() > Date.now() ? found.value : null
}
