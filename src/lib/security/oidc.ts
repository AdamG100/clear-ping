import { createHmac, createPublicKey, constants, timingSafeEqual, verify, type JsonWebKeyInput } from 'node:crypto'

/** One of the provider's public keys, as its key set lists it. */
type JsonWebKey = { kid?: string; use?: string; kty?: string; [field: string]: unknown }
import { DEFAULT_NEW_ROLE, isRole, roleFromGroups, type Role } from './roles'
import { getJsonSetting, setJsonSetting } from './settings-store'

/**
 * Single sign-on with Authentik, or any OpenID Connect provider.
 *
 * The sign-in itself, the authorization code flow with PKCE and the checks of
 * the ID token, is Better Auth's (see auth.ts). What is here is the rest: the
 * settings, the provider's own description of itself, who may sign in and as
 * what, and signing out together with the provider, both ways.
 *
 * In Authentik: Applications → Applications → New Application, and create the
 * provider in that wizard. Confidential client, the redirect URI the
 * dashboard shows, and a signing key. The issuer is
 * https://<authentik>/application/o/<application slug>/. Logout tokens signed
 * with the client secret (HS256) are still accepted.
 */

export interface SsoConfig {
  enabled: boolean
  /** On the button: "Sign in with Authentik". */
  label: string
  issuer: string
  clientId: string
  clientSecret: string
  /** Only people in this group at the provider may sign in. Empty for everyone the provider lets through. */
  allowedGroup: string
  /** Make an account for someone signing in for the first time. Off, an account has to be linked first. */
  autoCreate: boolean
  /** Where the provider sends the browser back to, as the dashboard was reached when this was saved. */
  redirectUri: string
  /** Signing out of ClearPing, after signing in through the provider, signs out there too. */
  signOutAtProvider: boolean
  /**
   * Groups at the provider that make an account an admin, or an editor, set
   * again at every sign-in. Both empty, the provider has no say in roles.
   */
  adminGroup: string
  editorGroup: string
  /** The role an account made at its first sign-in starts with, where no group decides it. */
  newAccountRole: Role
}

const SETTING = 'sso.config'

export const SSO_DEFAULTS: SsoConfig = {
  enabled: false,
  label: 'Authentik',
  issuer: '',
  clientId: '',
  clientSecret: '',
  allowedGroup: '',
  autoCreate: true,
  redirectUri: '',
  signOutAtProvider: true,
  adminGroup: '',
  editorGroup: '',
  newAccountRole: DEFAULT_NEW_ROLE,
}

export const SSO_CALLBACK_PATH = '/api/auth/sso/callback'

export async function getSsoConfig(): Promise<SsoConfig> {
  return { ...SSO_DEFAULTS, ...((await getJsonSetting<Partial<SsoConfig>>(SETTING)) ?? {}) }
}

/** Ready to sign anyone in: switched on and with everything it needs. */
export function ssoUsable(config: SsoConfig): boolean {
  return config.enabled && !!config.issuer && !!config.clientId && !!config.clientSecret && !!config.redirectUri
}

/** What the dashboard is shown: everything but the secret, and whether there is one. */
export function publicSsoConfig(config: SsoConfig) {
  const { clientSecret, ...rest } = config
  return { ...rest, clientSecretSet: clientSecret !== '' }
}

/** Throws with a reason fit to show if a value will not do. An empty secret keeps the one saved. */
export async function saveSsoConfig(changes: Partial<SsoConfig>): Promise<SsoConfig> {
  const current = await getSsoConfig()
  const next: SsoConfig = { ...current }

  if (typeof changes.enabled === 'boolean') next.enabled = changes.enabled
  if (typeof changes.autoCreate === 'boolean') next.autoCreate = changes.autoCreate
  if (typeof changes.signOutAtProvider === 'boolean') next.signOutAtProvider = changes.signOutAtProvider
  if (typeof changes.label === 'string') next.label = changes.label.trim().slice(0, 40) || SSO_DEFAULTS.label
  if (typeof changes.clientId === 'string') next.clientId = changes.clientId.trim()
  if (typeof changes.clientSecret === 'string' && changes.clientSecret.trim()) next.clientSecret = changes.clientSecret.trim()
  if (typeof changes.allowedGroup === 'string') next.allowedGroup = changes.allowedGroup.trim()
  if (typeof changes.adminGroup === 'string') next.adminGroup = changes.adminGroup.trim()
  if (typeof changes.editorGroup === 'string') next.editorGroup = changes.editorGroup.trim()
  if (isRole(changes.newAccountRole)) next.newAccountRole = changes.newAccountRole
  if (typeof changes.issuer === 'string') {
    const issuer = changes.issuer.trim()
    if (issuer && !isHttpUrl(issuer)) throw new Error('The issuer has to be an http(s) address')
    next.issuer = issuer
  }
  if (typeof changes.redirectUri === 'string') {
    if (changes.redirectUri && !isHttpUrl(changes.redirectUri)) throw new Error('The redirect URI has to be an http(s) address')
    next.redirectUri = changes.redirectUri
  }
  if (next.enabled && !ssoUsable(next)) {
    throw new Error('Single sign-on needs an issuer, a client ID and a client secret before it can be turned on')
  }

  await setJsonSetting(SETTING, next)
  return next
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

// ─── The provider ───────────────────────────────────────────────────────────

export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

type FetchFn = typeof fetch
const TIMEOUT_MS = 10_000
const CACHE_MS = 60 * 60 * 1000

interface Cache {
  discovery: Map<string, { at: number; value: Discovery }>
  jwks: Map<string, { at: number; keys: JsonWebKey[] }>
}
const CACHE_KEY = Symbol.for('clearping.oidc-cache')
function cache(): Cache {
  const store = globalThis as typeof globalThis & { [CACHE_KEY]?: Cache }
  return (store[CACHE_KEY] ??= { discovery: new Map(), jwks: new Map() })
}

async function getJson(url: string, fetchFn: FetchFn): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`)
  return (await response.json()) as Record<string, unknown>
}

/** The provider's own description of itself, from its well-known address. */
export async function discover(issuer: string, fetchFn: FetchFn = fetch, fresh = false): Promise<Discovery> {
  const cached = cache().discovery.get(issuer)
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value

  const url = issuer.replace(/\/?$/, '/') + '.well-known/openid-configuration'
  const body = await getJson(url, fetchFn)
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof body[field] !== 'string') throw new Error(`The provider's configuration has no ${field}; is ${issuer} the issuer?`)
  }
  const value = body as unknown as Discovery
  // The issuer it says it is has to be the one configured, give or take the
  // last slash, or a token from some other issuer could be passed off here.
  if (value.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) {
    throw new Error(`The provider says its issuer is ${value.issuer}, not ${issuer}`)
  }
  cache().discovery.set(issuer, { at: Date.now(), value })
  return value
}

async function signingKeys(jwksUri: string, fetchFn: FetchFn, fresh = false): Promise<JsonWebKey[]> {
  const cached = cache().jwks.get(jwksUri)
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.keys
  const body = await getJson(jwksUri, fetchFn)
  const keys = Array.isArray(body.keys) ? (body.keys as JsonWebKey[]) : []
  cache().jwks.set(jwksUri, { at: Date.now(), keys })
  return keys
}

export interface Claims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat?: number
  nonce?: string
  azp?: string
  preferred_username?: string
  nickname?: string
  name?: string
  email?: string
  groups?: unknown
  [claim: string]: unknown
}

// ─── Tokens from the provider ───────────────────────────────────────────────

const HASH: Record<string, string> = { '256': 'sha256', '384': 'sha384', '512': 'sha512' }
/** Clocks differ; this much is forgiven. */
const SKEW_S = 120

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T
}

interface VerifyOptions {
  discovery: Discovery
  clientId: string
  clientSecret: string
  now?: number
  fetchFn?: FetchFn
}

/**
 * A token from the provider, with its signature, issuer and audience checked:
 * what an ID token and a logout token have in common. `what` names it in the
 * reasons given for refusing it.
 */
async function verifySigned(token: string, what: string, options: VerifyOptions): Promise<Claims> {
  const { discovery, clientId, clientSecret, fetchFn = fetch } = options

  const parts = token.split('.')
  if (parts.length !== 3) throw new Error(`The ${what} is not a signed token`)
  const [headerPart, payloadPart, signaturePart] = parts
  let header: { alg?: string; kid?: string }
  try {
    header = decodePart(headerPart)
  } catch {
    throw new Error(`The ${what} cannot be read`)
  }
  const signed = Buffer.from(`${headerPart}.${payloadPart}`)
  const signature = Buffer.from(signaturePart, 'base64url')

  const alg = header.alg ?? ''
  const family = alg.slice(0, 2)
  const hash = HASH[alg.slice(2)]
  if (!hash || !['HS', 'RS', 'PS', 'ES'].includes(family)) throw new Error(`The ${what} is signed with ${alg || 'nothing'}, which is not accepted`)

  let valid: boolean
  if (family === 'HS') {
    const expected = createHmac(hash, clientSecret).update(signed).digest()
    valid = expected.length === signature.length && timingSafeEqual(expected, signature)
  } else {
    const pick = (keys: JsonWebKey[]) =>
      keys.find(key => (header.kid ? key.kid === header.kid : true) && (!key.use || key.use === 'sig'))
    let jwk = pick(await signingKeys(discovery.jwks_uri, fetchFn))
    // A key the provider has rotated in since the list was last read.
    if (!jwk) jwk = pick(await signingKeys(discovery.jwks_uri, fetchFn, true))
    if (!jwk) throw new Error(`The ${what} is signed with a key the provider does not list`)
    valid = verify(
      hash,
      signed,
      {
        key: createPublicKey({ key: jwk as JsonWebKeyInput['key'], format: 'jwk' }),
        ...(family === 'PS' ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : {}),
        ...(family === 'ES' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
      },
      signature
    )
  }
  if (!valid) throw new Error(`The ${what} signature does not check out`)

  const claims = decodePart<Claims>(payloadPart)
  if (claims.iss !== discovery.issuer) throw new Error(`The ${what} is from another issuer`)
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(clientId)) throw new Error(`The ${what} is for another application`)
  if (audience.length > 1 && claims.azp !== undefined && claims.azp !== clientId) throw new Error(`The ${what} is for another application`)
  return claims
}

// ─── Signing out ────────────────────────────────────────────────────────────

/**
 * Where the provider tells ClearPing someone has signed out there (OpenID
 * Connect Back-Channel Logout). In Authentik it is the provider's Logout URI,
 * with the logout method set to back-channel.
 */
export const SSO_LOGOUT_PATH = '/api/auth/sso/logout'

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'
/** A logout token older than this is not taken: it is news, or it is a replay. */
const LOGOUT_TOKEN_MAX_AGE_S = 10 * 60

/** Who a logout token signs out: one session at the provider, or everything of one person's. */
export interface LogoutClaims {
  iss: string
  sub?: string
  sid?: string
}

/** Logout tokens already acted on, so that one sent again is refused. */
const SEEN_KEY = Symbol.for('clearping.oidc-logout-seen')
function seenLogoutTokens(): Map<string, number> {
  const store = globalThis as typeof globalThis & { [SEEN_KEY]?: Map<string, number> }
  return (store[SEEN_KEY] ??= new Map())
}

/**
 * A logout token, checked as the specification asks: signed by the provider,
 * for this application, recent, carrying the logout event, naming a person or
 * a session, never a nonce (which would make it an ID token passed off as one),
 * and not seen before.
 */
export async function verifyLogoutToken(token: string, options: VerifyOptions): Promise<LogoutClaims> {
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  const claims = await verifySigned(token, 'logout token', options)

  if (typeof claims.iat !== 'number' || claims.iat - SKEW_S > now || claims.iat + LOGOUT_TOKEN_MAX_AGE_S < now) {
    throw new Error('The logout token is too old, or dated in the future')
  }
  if (typeof claims.exp === 'number' && claims.exp + SKEW_S < now) throw new Error('The logout token has expired')
  const events = claims.events
  if (!events || typeof events !== 'object' || !(LOGOUT_EVENT in events)) throw new Error('The token is not a logout token')
  if ('nonce' in claims) throw new Error('A logout token has no nonce; this is not one')

  const sub = typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined
  const sid = typeof claims.sid === 'string' && claims.sid ? claims.sid : undefined
  if (!sub && !sid) throw new Error('The logout token does not say whose sign-in it ends')

  if (typeof claims.jti === 'string') {
    const seen = seenLogoutTokens()
    for (const [id, at] of seen) if (at + LOGOUT_TOKEN_MAX_AGE_S + SKEW_S < now) seen.delete(id)
    if (seen.has(claims.jti)) throw new Error('That logout token has been used already')
    seen.set(claims.jti, now)
  }
  return { iss: claims.iss, sub, sid }
}

/**
 * Where to send the browser to sign out at the provider as well
 * (RP-initiated logout), or null if the provider has nowhere for it.
 *
 * Authentik ends this application's session there, and, if the provider's
 * invalidation flow is one that logs out (`default-invalidation-flow`), the
 * person's whole Authentik session. It comes back to `returnTo` only if that
 * address is among the provider's post-logout redirect URIs; otherwise it
 * stays on its own signed-out page.
 */
export function endSessionUrl(discovery: Discovery, config: SsoConfig, idToken: string | null, returnTo: string): string | null {
  if (!discovery.end_session_endpoint) return null
  const url = new URL(discovery.end_session_endpoint)
  url.searchParams.set('client_id', config.clientId)
  // Without it, a provider that keeps a list of addresses to return to will
  // not use one: the hint is how it knows the request came from this application.
  if (idToken) {
    url.searchParams.set('id_token_hint', idToken)
    url.searchParams.set('post_logout_redirect_uri', returnTo)
  }
  return url.href
}

// ─── Who that is ────────────────────────────────────────────────────────────

/** The name to make an account under. */
export function usernameFrom(claims: Claims): string {
  return claims.preferred_username || claims.nickname || claims.email?.split('@')[0] || claims.name || claims.sub
}

export function groupsOf(claims: Claims): string[] {
  return Array.isArray(claims.groups) ? claims.groups.filter((group): group is string => typeof group === 'string') : []
}

/**
 * The role the person's groups give them, or null if the settings map no
 * groups to roles. See roleFromGroups.
 */
export function ssoRole(claims: Claims, config: Pick<SsoConfig, 'adminGroup' | 'editorGroup'>): Role | null {
  return roleFromGroups(groupsOf(claims), config)
}

/** Whether the person may sign in here, going by the group the configuration asks for. */
export function inAllowedGroup(claims: Claims, allowedGroup: string): boolean {
  if (!allowedGroup) return true
  const wanted = allowedGroup.toLowerCase()
  return groupsOf(claims).some(group => group.toLowerCase() === wanted)
}
