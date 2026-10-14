import { NextResponse } from 'next/server'
import { identify } from './access'
import { canAdminister, ROLE_LABEL } from './roles'
import { countUsers, type Actor } from './store'

/** What the security routes have in common. */

/** Over HTTPS, as the server or the proxy in front of it saw it. */
export function isHttps(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase()
  return forwarded ? forwarded === 'https' : new URL(request.url).protocol === 'https:'
}

/**
 * Hand on the cookies Better Auth set (the session, and the state of a sign-in
 * through the provider) to the browser. They are `HttpOnly` and
 * `SameSite=Lax`, and `Secure` where the request came over HTTPS: decided per
 * request, as ClearPing is reached over plain HTTP on a home network as often
 * as over HTTPS, where a cookie marked `Secure` would never be kept.
 */
export function passCookies(from: Response, to: NextResponse, request: Request): NextResponse {
  const secure = isHttps(request)
  for (const line of from.headers.getSetCookie()) {
    to.headers.append('set-cookie', secure && !/;\s*secure/i.test(line) ? `${line}; Secure` : line)
  }
  return to
}

/** Why Better Auth refused, in words fit to show. */
export async function refusal(response: Response, fallback: string): Promise<string> {
  const body = (await response.clone().json().catch(() => null)) as { message?: string } | null
  return body?.message || fallback
}

export type UserActor = Extract<Actor, { kind: 'user' }>

/**
 * The signed-in user, or the response refusing the request.
 *
 * Security settings are only ever changed by someone signed in, whether or
 * not the rest of the dashboard asks for it: otherwise anyone who could open
 * the page could hand themselves a key. Keys cannot change them either.
 */
export async function requireUser(request: Request): Promise<UserActor | NextResponse> {
  const { actor } = await identify(request)
  if (actor?.kind === 'user') return actor
  const accounts = await countUsers()
  return NextResponse.json(
    accounts === 0
      ? { error: 'Create an account first: security settings are changed signed in', needsAccount: true }
      : { error: 'Sign in to change security settings', needsSignIn: true },
    { status: accounts === 0 ? 403 : 401 }
  )
}

/**
 * The signed-in admin, or the response refusing the request. What only an
 * admin may change: the switches, single sign-on, other people's accounts and
 * keys, and what only an admin may see: the activity record.
 */
export async function requireAdmin(request: Request): Promise<UserActor | NextResponse> {
  const user = await requireUser(request)
  if (user instanceof NextResponse) return user
  if (canAdminister(user.role)) return user
  return NextResponse.json({ error: `Only an admin can do that. Your account is a ${ROLE_LABEL[user.role]}.`, needsAdmin: true }, { status: 403 })
}

// ─── Slowing down guessing ──────────────────────────────────────────────────

interface Attempts {
  failures: number
  lockedUntil: number
}

const FREE_ATTEMPTS = 5
const MAX_LOCK_MS = 15 * 60 * 1000
const attempts = new Map<string, Attempts>()

/** The address a request came from, as the proxy in front reports it. */
export function clientAddress(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    'unknown'
  )
}

/**
 * Seconds to wait before trying again, or 0. Five tries are free; after that
 * each failure doubles the wait, up to a quarter of an hour, counted per
 * address and per username so that neither spreading the guesses over names
 * nor over addresses gets round it.
 */
export function loginLockedFor(keys: string[], now = Date.now()): number {
  const until = Math.max(0, ...keys.map(key => attempts.get(key)?.lockedUntil ?? 0))
  return until > now ? Math.ceil((until - now) / 1000) : 0
}

export function noteLoginFailure(keys: string[], now = Date.now()): void {
  for (const key of keys) {
    const entry = attempts.get(key) ?? { failures: 0, lockedUntil: 0 }
    entry.failures++
    if (entry.failures > FREE_ATTEMPTS) {
      entry.lockedUntil = now + Math.min(MAX_LOCK_MS, 1000 * 2 ** (entry.failures - FREE_ATTEMPTS))
    }
    attempts.set(key, entry)
  }
  // Bounded, whatever is thrown at it.
  if (attempts.size > 10_000) attempts.clear()
}

export function noteLoginSuccess(keys: string[]): void {
  for (const key of keys) attempts.delete(key)
}
