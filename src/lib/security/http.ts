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

/**
 * The site name a passkey made or used here belongs to: the name the browser
 * has this page open at, from the page's own origin. Null where passkeys
 * cannot work: a browser makes them only for a name (never an address such as
 * 192.168.1.10) and only over HTTPS, apart from localhost.
 */
export function passkeySite(request: Request): string | null {
  // A browser sends its origin with a POST; a GET from the same site may
  // come without one, and then it is the address the request was made to.
  const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim() || request.headers.get('host')
  const origin = request.headers.get('origin') ?? (host ? `${isHttps(request) ? 'https' : 'http'}://${host}` : null)
  if (!origin) return null
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  const name = url.hostname.toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost')) return name
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(name) || /^[\d.]+$/.test(name)) return null
  return name
}

export const NO_PASSKEY_HERE =
  'Passkeys need ClearPing opened at a name over HTTPS, such as https://clearping.example.com, not at an address like 192.168.1.10.'

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

/**
 * How many proxies stand in front of ClearPing and add to `X-Forwarded-For`:
 * CLEARPING_TRUST_PROXY, a number (`true` is 1). 0 by default, when the header
 * is whatever the sender wrote and counts for nothing.
 */
function trustedProxies(): number {
  const set = process.env.CLEARPING_TRUST_PROXY?.trim().toLowerCase()
  if (!set || set === 'false' || set === '0') return 0
  if (set === 'true') return 1
  const hops = Number.parseInt(set, 10)
  return Number.isInteger(hops) && hops > 0 ? hops : 0
}

/**
 * The address a request came from, or 'unknown'. Only as a proxy we trust
 * reports it: each proxy appends the address it was reached from, so the
 * entries to believe are the last ones, as many as there are proxies. What
 * comes before them was written by the client, and anyone can write anything.
 */
export function clientAddress(request: Request): string {
  const hops = trustedProxies()
  if (hops === 0) return 'unknown'
  const chain = (request.headers.get('x-forwarded-for') ?? '').split(',').map(part => part.trim()).filter(Boolean)
  return chain[chain.length - hops] || request.headers.get('x-real-ip')?.trim() || 'unknown'
}

/**
 * What guesses are counted against besides the username. Not the address when
 * there is none to trust: every request would share one, and anyone could lock
 * everybody out with five wrong passwords.
 */
export function addressKeys(address: string): string[] {
  return address === 'unknown' ? [] : [`address:${address}`]
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
