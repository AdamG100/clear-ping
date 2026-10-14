import { originAllowed } from '../mcp-protocol'
import { KEY_PREFIX, sameSecret } from './secrets'
import { canChange, ROLE_LABEL } from './roles'
import { actorOf, ANONYMOUS, apiKeyFor, getSecuritySettings, SESSION_COOKIE, userForSession, type Actor, type Via } from './store'

/**
 * Who a request is from, and what they may do.
 *
 * Off by default, as ClearPing always was: anyone who can reach it can use it,
 * which is right behind a VPN or a sign-in proxy such as Authentik. Turned on
 * from the dashboard, the dashboard and its API need a signed-in user or a
 * key, and the MCP address needs a key. Keys are made per script or
 * assistant, each able to read or to read and change, so one can be cut off
 * without the others and the record says which of them did what.
 *
 * CLEARPING_AUTH=off overrides the switch, for whoever has locked themselves
 * out: sign-in is not asked for, and a new account can be made, for as long as
 * it is set.
 */

export interface Policy {
  /** The dashboard and API need a signed-in user or a key. */
  loginRequired: boolean
  /** The MCP address needs a key, even to read. */
  mcpKeyRequired: boolean
  /** Accounts may sign in with a password, rather than only through single sign-on. */
  passwordLogin: boolean
  /** CLEARPING_AUTH=off is set. */
  recovery: boolean
  /** The single key from before keys were made in the dashboard. Still honoured, as a key that can change things. */
  legacyMcpToken: string | null
}

export function recoveryMode(): boolean {
  return /^(off|0|false|no)$/i.test(process.env.CLEARPING_AUTH?.trim() ?? '')
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

export async function identify(request: Request, legacyMcpToken = process.env.CLEARPING_MCP_TOKEN?.trim() || null): Promise<Identity> {
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

  const session = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (session) {
    const user = await userForSession(session)
    if (user) return { actor: actorOf(user), invalidKey: false }
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

const OPEN_PATHS = new Set(['/login', '/api/health', '/api/mcp', '/api/mcp/info'])

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

export type Decision =
  | { allow: true }
  | { allow: false; status: 401 | 403; message: string }
  | { allow: false; signIn: true }

export function decide(input: {
  pathname: string
  method: string
  policy: Pick<Policy, 'loginRequired'>
  identity: Identity
  origin: string | null
  host: string | null
}): Decision {
  const kind = routeKind(input.pathname)
  if (kind === 'open') return { allow: true }

  const { actor, invalidKey } = input.identity
  const reading = READING.has(input.method.toUpperCase())

  if (kind === 'page') {
    return input.policy.loginRequired && actor?.kind !== 'user' ? { allow: false, signIn: true } : { allow: true }
  }

  // A key that was sent is checked even where none is needed: a script with a
  // wrong or revoked key should hear so, not carry on as nobody.
  if (invalidKey) return { allow: false, status: 401, message: 'That API key is not valid, or has been revoked' }
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
  // A browser sends its cookie with whatever page asks, so a change made with
  // one has to come from a page of this site. Keys are not sent by browsers on
  // their own and need no such check.
  if (actor?.kind === 'user' && !reading && !originAllowed(input.origin, input.host)) {
    return { allow: false, status: 403, message: 'That request came from another site' }
  }
  return { allow: true }
}
