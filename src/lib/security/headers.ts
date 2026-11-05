/**
 * The security headers a page is sent with, by the proxy, since a nonce has to
 * be new for each request. The ones that never change are in next.config.ts.
 */

/** Half a year, for this name only: a neighbouring name may not have HTTPS. */
export const HSTS = 'max-age=15552000'

/**
 * Only scripts ClearPing wrote for this page run, and what they load: an
 * injected script has no nonce. Inline styles stay allowed, because the
 * components set them on elements, and a style attribute cannot carry a nonce.
 * No `upgrade-insecure-requests`: on a home network ClearPing is reached over
 * plain HTTP, and that would break every request the page makes.
 */
export function pageSecurityPolicy(nonce: string, development = false): string {
  return [
    "default-src 'self'",
    // React rebuilds error stacks with eval, under `next dev` only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? ' ws:' : ''}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
