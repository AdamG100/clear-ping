/**
 * Which other websites may call the API from a visitor's browser (CORS).
 *
 * A browser lets a page read an answer from another site only if that site
 * says so. ClearPing says so for the addresses an admin lists under Settings →
 * Access, and for no one else: there is no "any website", since that would let
 * any page a visitor opens read a ClearPing on their private network.
 *
 * Even a listed page never acts as a signed-in account: its requests are taken
 * without the session cookie, so it has to send a key. Pure: how a request
 * arrives and what is stored are the proxy's and the settings'.
 */

const MAX_ORIGINS = 20

/** What a page from a listed address may send, and use. */
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOWED_HEADERS = 'Authorization, X-API-Key, Content-Type, MCP-Protocol-Version, Accept'
const PREFLIGHT_MAX_AGE = '600'

/** The API paths a listed page may reach: all but sign-in, whose cookie it must never be handed. */
export function corsPath(pathname: string): boolean {
  return pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/') && pathname !== '/api/health'
}

/**
 * The list an admin typed, each entry made into an origin (`https://home.example.com`,
 * `http://192.168.1.20:8080`), or the reason it cannot be one. Pages are
 * identified by their origin alone, so a path, query or login in an entry is
 * refused rather than quietly dropped.
 */
export function parseCorsOrigins(input: unknown): { origins: string[] } | { error: string } {
  if (!Array.isArray(input) || input.some(entry => typeof entry !== 'string')) {
    return { error: 'corsOrigins is a list of web addresses' }
  }
  const origins = new Set<string>()
  for (const entry of input as string[]) {
    const text = entry.trim()
    if (!text) continue
    if (text.includes('*')) return { error: `"${text}": a wildcard would let any website read this ClearPing. List each address.` }
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return { error: `"${text}" is not a web address. Write it like https://home.example.com` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: `"${text}" must start with http:// or https://` }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      return { error: `"${text}" should be the site alone, such as ${url.origin}, with no path` }
    }
    origins.add(url.origin)
  }
  if (origins.size > MAX_ORIGINS) return { error: `At most ${MAX_ORIGINS} websites can be listed` }
  return { origins: [...origins] }
}

/**
 * The origin to answer with when a request comes from a listed website other
 * than ClearPing's own pages, and null otherwise (including for ClearPing's
 * own pages, which need none of this).
 */
export function corsOrigin(origin: string | null, host: string | null, allowed: readonly string[]): string | null {
  if (!origin || !allowed.includes(origin)) return null
  try {
    if (host && new URL(origin).host.toLowerCase() === host.toLowerCase()) return null
  } catch {
    return null
  }
  return origin
}

/** The headers that let a listed page read an answer. Never credentials: it sends a key, not a cookie. */
export function corsHeaders(origin: string, preflight?: { privateNetwork: boolean }): Record<string, string> {
  const headers: Record<string, string> = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS
    headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS
    headers['Access-Control-Max-Age'] = PREFLIGHT_MAX_AGE
    // A page on the internet asking a ClearPing on a private address: browsers ask first.
    if (preflight.privateNetwork) headers['Access-Control-Allow-Private-Network'] = 'true'
  }
  return headers
}
