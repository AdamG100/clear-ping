import { originAllowed } from '../mcp/protocol'
import { KEY_PREFIX, sameSecret } from './secrets'
import { canChange, ROLE_LABEL } from './roles'
import { describeOwed, factorsOwed } from './factors'
import { getFactorPolicy, getSecuritySettings, recoveryMode } from './settings-store'
import { actorOf, ANONYMOUS, apiKeyFor, signedIn, type Actor, type Via } from './store'

export { recoveryMode }

/**
 * Who a request is from, and what they may do.
 *
 * Off by default, as ClearPing always was: anyone who can reach it can use it,
 * which is right behind a VPN or a sign-in proxy such as Authentik. Turned on
 * from the dashboard, the dashboard and its API need a signed-in user or a
 * key, and the MCP address needs a key. Keys are made per script or
 * assistant, each able to read or to read and write, so one can be cut off
 * without the others and the record says which of them did what.
 *
 * CLEARPING_AUTH=off overrides the switch, for whoever has locked themselves
 * out: sign-in is not asked for, and a new account can be made, for as long as
 * it is set.
 *
 * An admin can require second factors of the accounts that sign in to
 * ClearPing itself (factors.ts). One signed in without them is sent to add
 * them, and can reach nothing else until it has.
 */

export interface Policy {
  /** The dashboard and API need a signed-in user or a key. */
  loginRequired: boolean
  /** The MCP address needs a key, even to read. */
  mcpKeyRequired: boolean
  /** Looking is open to anyone, but changing anything needs a signed-in account or a key that may write. */
  changesNeedSignIn: boolean
  /** Websites whose pages may call the API from a browser, with a key (cors.ts). */
  corsOrigins: string[]
  /** Accounts may sign in with a password, rather than only through single sign-on. */
  passwordLogin: boolean
  /** CLEARPING_AUTH=off is set. */
  recovery: boolean
  /** The single key from before keys were made in the dashboard. Still honoured, as a key that can change things. */
  legacyMcpToken: string | null
}

export async function securityPolicy(): Promise<Policy> {
  const recovery = recoveryMode()
  const legacyMcpToken = process.env.CLEARPING_MCP_TOKEN?.trim() || null
  const settings = await getSecuritySettings()
  const loginRequired = settings.loginRequired && !recovery
  return {
    loginRequired,
    // A protected dashboard with an open MCP address would hand its data to
    // anyone who asked there instead.
    mcpKeyRequired: settings.mcpKeyRequired || loginRequired || legacyMcpToken !== null,
    // Sign-in for everything covers changing things too.
    changesNeedSignIn: loginRequired || (settings.changesNeedSignIn && !recovery),
    corsOrigins: settings.corsOrigins,
    // A provider that is down, or set up wrong, must not lock everyone out.
    passwordLogin: settings.passwordLogin || recovery,
    recovery,
    legacyMcpToken,
  }
}

// ─── Who is asking ──────────────────────────────────────────────────────────

export interface Identity {
  actor: Actor | null
  /** A key was sent and it is not one: wrong, or revoked. */
  invalidKey: boolean
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim())
  }
  return null
}

/** A key, sent as `Authorization: Bearer …` or `X-API-Key: …`. */
export function presentedKey(headers: Headers): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '')?.[1]?.trim()
  return bearer || headers.get('x-api-key')?.trim() || null
}

/**
 * `useCookie` is false for a page of another website that an admin has
 * listed: it sends a key or it is nobody, however the browser got hold of a
 * session cookie.
 */
export async function identify(
  request: Request,
  legacyMcpToken = process.env.CLEARPING_MCP_TOKEN?.trim() || null,
  useCookie = true
): Promise<Identity> {
  const key = presentedKey(request.headers)
  if (key) {
    if (key.startsWith(KEY_PREFIX)) {
      const found = await apiKeyFor(key)
      return found
        ? { actor: { kind: 'key', id: found.id, name: found.name, access: found.access }, invalidKey: false }
        : { actor: null, invalidKey: true }
    }
    if (legacyMcpToken && sameSecret(key, legacyMcpToken)) {
      return { actor: { kind: 'key', id: 'env:CLEARPING_MCP_TOKEN', name: 'CLEARPING_MCP_TOKEN', access: 'write' }, invalidKey: false }
    }
    return { actor: null, invalidKey: true }
  }

  // Better Auth reads its own cookie, checks its signature and the session behind it.
  if (useCookie && request.headers.get('cookie')) {
    const found = await signedIn(request.headers)
    if (found) {
      // Not while CLEARPING_AUTH=off is set: that is for getting back in.
      const owes = recoveryMode() ? null : factorsOwed(await getFactorPolicy(), { role: found.user.role, totp: found.user.twoFactor, passkeys: found.user.passkeys }, { viaSso: found.viaSso })
      return { actor: { ...actorOf(found.user), ...(owes ? { owes } : {}) }, invalidKey: false }
    }
  }
  return { actor: null, invalidKey: false }
}

/** Who to put in the record for a change, and how it arrived. */
export async function actorFor(request: Request): Promise<{ actor: Actor; via: Via }> {
  const { actor } = await identify(request)
  return { actor: actor ?? ANONYMOUS, via: actor?.kind === 'key' ? 'api' : 'dashboard' }
}

// ─── What they may do ───────────────────────────────────────────────────────

/** How a path is guarded. */
export type RouteKind = 'open' | 'api' | 'page'

const OPEN_PATHS = new Set(['/login', '/api/health', '/api/mcp', '/api/mcp/info', '/upgrading', '/api/upgrade', '/api/upgrade/retry'])

/** Where an account sent to add second factors is let through to: the page that does it, and what it calls. */
export const FACTOR_SETUP_PAGE = '/security-setup'
function setupRoute(pathname: string): boolean {
  return pathname === FACTOR_SETUP_PAGE || pathname === '/api/security/me' || pathname.startsWith('/api/security/me/')
}

/**
 * `open` is let through here and, where it needs guarding, guards itself:
 * the sign-in page and its API, the health check, and the MCP address, which
 * has rules of its own about keys.
 */
export function routeKind(pathname: string): RouteKind {
  if (OPEN_PATHS.has(pathname) || pathname.startsWith('/api/auth/')) return 'open'
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'api'
  return 'page'
}

const READING = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Whether a change was asked for by a page of another site. A browser says so
 * itself: `Origin` is sent with every cross-site POST, even one made with
 * `no-cors` and a `text/plain` body, and `Sec-Fetch-Site` with every request
 * from a browser made this decade. Neither is sent by a script or a key, so
 * those pass.
 */
export function crossSite(origin: string | null, host: string | null, fetchSite: string | null): boolean {
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true
  return !originAllowed(origin, host)
}

/**
 * The hostnames ClearPing answers to: CLEARPING_ALLOWED_HOSTS, comma
 * separated, each with or without a port. Unset, any is accepted. Set, a
 * request addressed to another name is refused, which is what stops a page
 * from pointing its own domain at this machine (DNS rebinding) and reading the
 * API as if it were its own.
 */
export function hostAllowed(host: string | null, allowed = process.env.CLEARPING_ALLOWED_HOSTS): boolean {
  const list = (allowed ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return true
  if (!host) return false
  const full = host.trim().toLowerCase()
  const name = full.startsWith('[') ? full.slice(0, full.indexOf(']') + 1) : full.replace(/:\d+$/, '')
  return list.includes(full) || list.includes(name)
}

export type Decision =
  | { allow: true }
  | { allow: false; status: 401 | 403; message: string }
  | { allow: false; signIn: true }
  | { allow: false; setup: true }

export function decide(input: {
  pathname: string
  method: string
  policy: Pick<Policy, 'loginRequired'> & Partial<Pick<Policy, 'changesNeedSignIn'>>
  identity: Identity
  origin: string | null
  host: string | null
  /** The `Sec-Fetch-Site` header. */
  fetchSite?: string | null
  /** The request is from a website an admin listed (cors.ts), whose identity was taken without the cookie. */
  trustedOrigin?: boolean
}): Decision {
  const kind = routeKind(input.pathname)
  const reading = READING.has(input.method.toUpperCase())
  const fromAnotherSite = !reading && crossSite(input.origin, input.host, input.fetchSite ?? null)
  if (kind === 'open') {
    // The sign-in API guards itself, but not against another site making it
    // do something: making the first account, say. The MCP address and the
    // health check are for scripts, and have rules of their own.
    if (fromAnotherSite && input.pathname.startsWith('/api/auth/')) {
      return { allow: false, status: 403, message: 'That request came from another site' }
    }
    return { allow: true }
  }

  const { actor, invalidKey } = input.identity

  // Signed in, and owing a second factor an admin requires: that first.
  if (actor?.kind === 'user' && actor.owes && !setupRoute(input.pathname)) {
    if (kind === 'page') return { allow: false, setup: true }
    return { allow: false, status: 403, message: `${describeOwed(actor.owes)} first: an admin requires it` }
  }

  if (kind === 'page') {
    return input.policy.loginRequired && actor?.kind !== 'user' ? { allow: false, signIn: true } : { allow: true }
  }

  // A key that was sent is checked even where none is needed: a script with a
  // wrong or revoked key should hear so, not carry on as nobody.
  if (invalidKey) return { allow: false, status: 401, message: 'That API key is not valid, or has been revoked or has expired' }
  if (actor?.kind === 'key' && actor.access === 'read' && !reading) {
    return { allow: false, status: 403, message: `The key "${actor.name}" may only read` }
  }
  // A viewer changes nothing that is monitored. Settings are left to their
  // own routes, which know what each role may do there: a viewer may still
  // change their own password, and make and revoke keys of their own.
  const settingsRoute = input.pathname === '/api/security' || input.pathname.startsWith('/api/security/')
  if (actor?.kind === 'user' && !reading && !canChange(actor.role) && !settingsRoute) {
    return { allow: false, status: 403, message: `Your account is a ${ROLE_LABEL[actor.role]}, which may look but not change anything` }
  }
  if (input.policy.loginRequired && !actor) {
    return { allow: false, status: 401, message: 'Sign in, or send an API key as "Authorization: Bearer <key>"' }
  }
  // Looking is open, changing is not: an account that may change things, or a
  // key that may write (a read-only key and a viewer were turned away above).
  if (!reading && !actor && input.policy.changesNeedSignIn) {
    return { allow: false, status: 401, message: 'Sign in, or send a key that may change things as "Authorization: Bearer <key>"' }
  }
  // A browser sends its cookie with whatever page asks, so a change made with
  // one has to come from a page of this site. And with sign-in off there is no
  // cookie to wait for: any page the user visits could make the change. Keys
  // are not sent by browsers on their own and need no such check, nor does a
  // page an admin listed, which was taken without its cookie.
  if (actor?.kind !== 'key' && fromAnotherSite && !input.trustedOrigin) {
    return { allow: false, status: 403, message: 'That request came from another site' }
  }
  return { allow: true }
}
