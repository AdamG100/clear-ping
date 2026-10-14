import { createHash, createHmac, createPublicKey, constants, timingSafeEqual, verify, type JsonWebKeyInput } from 'node:crypto'

/** One of the provider's public keys, as its key set lists it. */
type JsonWebKey = { kid?: string; use?: string; kty?: string; [field: string]: unknown }
import { newToken } from './secrets'
import { getJsonSetting, setJsonSetting } from './store'

/**
 * Single sign-on with Authentik, or any OpenID Connect provider.
 *
 * The authorization code flow with PKCE: ClearPing sends the browser to the
 * provider, the provider sends it back with a code, and ClearPing trades the
 * code for an ID token directly with the provider, checks the token's
 * signature, issuer, audience, expiry and nonce, and signs in the account
 * linked to the person it names.
 *
 * In Authentik: Applications → Providers → Create → OAuth2/OpenID Provider,
 * confidential client, with the redirect URI the dashboard shows. Its
 * issuer is https://<authentik>/application/o/<application slug>/. A signing
 * key is best; without one Authentik signs with the client secret (HS256),
 * which is accepted too.
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
  if (typeof changes.label === 'string') next.label = changes.label.trim().slice(0, 40) || SSO_DEFAULTS.label
  if (typeof changes.clientId === 'string') next.clientId = changes.clientId.trim()
  if (typeof changes.clientSecret === 'string' && changes.clientSecret.trim()) next.clientSecret = changes.clientSecret.trim()
  if (typeof changes.allowedGroup === 'string') next.allowedGroup = changes.allowedGroup.trim()
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

// ─── Going there and coming back ────────────────────────────────────────────

/** What the browser carries to the provider and back, in a cookie only the callback reads. */
export interface Pending {
  state: string
  nonce: string
  verifier: string
  next: string
  /** Signing in to link the provider to the account already signed in, rather than to sign in. */
  link: boolean
}

export const PENDING_COOKIE = 'clearping_sso'
export const PENDING_LIFETIME_S = 10 * 60

export function newPending(next: string, link: boolean): Pending {
  return { state: newToken(), nonce: newToken(), verifier: newToken(), next, link }
}

export function encodePending(pending: Pending): string {
  return Buffer.from(JSON.stringify(pending)).toString('base64url')
}

export function decodePending(value: string | null): Pending | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return typeof parsed?.state === 'string' && typeof parsed?.verifier === 'string' && typeof parsed?.nonce === 'string'
      ? { state: parsed.state, nonce: parsed.nonce, verifier: parsed.verifier, next: safeNext(parsed.next), link: parsed.link === true }
      : null
  } catch {
    return null
  }
}

/** A path on this site, or the dashboard. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/'
}

export function authorizationUrl(discovery: Discovery, config: SsoConfig, pending: Pending): string {
  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  // `profile` is where Authentik puts the username and the person's groups.
  url.searchParams.set('scope', 'openid profile email')
  url.searchParams.set('state', pending.state)
  url.searchParams.set('nonce', pending.nonce)
  url.searchParams.set('code_challenge', createHash('sha256').update(pending.verifier).digest('base64url'))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.href
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

/** Trade the code for the person's claims: the ID token, checked, and what the userinfo address adds to it. */
export async function redeemCode(
  code: string,
  pending: Pending,
  config: SsoConfig,
  fetchFn: FetchFn = fetch,
  now = Date.now()
): Promise<Claims> {
  const discovery = await discover(config.issuer, fetchFn)
  const response = await fetchFn(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: pending.verifier,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const tokens = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || typeof tokens.id_token !== 'string') {
    const said = typeof tokens.error_description === 'string' ? tokens.error_description : typeof tokens.error === 'string' ? tokens.error : `HTTP ${response.status}`
    throw new Error(`The provider would not complete the sign-in: ${said}`)
  }

  const claims = await verifyIdToken(tokens.id_token, {
    discovery,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    nonce: pending.nonce,
    now,
    fetchFn,
  })

  // The ID token may leave out the profile; the userinfo address has it.
  if (discovery.userinfo_endpoint && typeof tokens.access_token === 'string') {
    const info = await fetchFn(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(answer => (answer.ok ? answer.json() : null))
      .catch(() => null)
    if (info && info.sub === claims.sub) return { ...info, ...claims, groups: claims.groups ?? info.groups }
  }
  return claims
}

// ─── The ID token ───────────────────────────────────────────────────────────

const HASH: Record<string, string> = { '256': 'sha256', '384': 'sha384', '512': 'sha512' }
/** Clocks differ; this much is forgiven. */
const SKEW_S = 120

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T
}

export async function verifyIdToken(
  token: string,
  options: { discovery: Discovery; clientId: string; clientSecret: string; nonce: string; now?: number; fetchFn?: FetchFn }
): Promise<Claims> {
  const { discovery, clientId, clientSecret, nonce, fetchFn = fetch } = options
  const now = Math.floor((options.now ?? Date.now()) / 1000)

  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('The ID token is not a signed token')
  const [headerPart, payloadPart, signaturePart] = parts
  const header = decodePart<{ alg?: string; kid?: string }>(headerPart)
  const signed = Buffer.from(`${headerPart}.${payloadPart}`)
  const signature = Buffer.from(signaturePart, 'base64url')

  const alg = header.alg ?? ''
  const family = alg.slice(0, 2)
  const hash = HASH[alg.slice(2)]
  if (!hash || !['HS', 'RS', 'PS', 'ES'].includes(family)) throw new Error(`The ID token is signed with ${alg || 'nothing'}, which is not accepted`)

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
    if (!jwk) throw new Error('The ID token is signed with a key the provider does not list')
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
  if (!valid) throw new Error('The ID token signature does not check out')

  const claims = decodePart<Claims>(payloadPart)
  if (claims.iss !== discovery.issuer) throw new Error('The ID token is from another issuer')
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(clientId)) throw new Error('The ID token is for another application')
  if (audience.length > 1 && claims.azp !== undefined && claims.azp !== clientId) throw new Error('The ID token is for another application')
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new Error('The ID token has expired')
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > now) throw new Error('The ID token is dated in the future')
  if (claims.nonce !== nonce) throw new Error('The ID token is not the answer to this sign-in')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('The ID token does not say who it is for')
  return claims
}

// ─── Who that is ────────────────────────────────────────────────────────────

/** The name to make an account under. */
export function usernameFrom(claims: Claims): string {
  return claims.preferred_username || claims.nickname || claims.email?.split('@')[0] || claims.name || claims.sub
}

export function groupsOf(claims: Claims): string[] {
  return Array.isArray(claims.groups) ? claims.groups.filter((group): group is string => typeof group === 'string') : []
}

/** Whether the person may sign in here, going by the group the configuration asks for. */
export function inAllowedGroup(claims: Claims, allowedGroup: string): boolean {
  if (!allowedGroup) return true
  const wanted = allowedGroup.toLowerCase()
  return groupsOf(claims).some(group => group.toLowerCase() === wanted)
}
