'use client'

import { useEffect } from 'react'

/**
 * Sends the page to sign in when the API says it needs to.
 *
 * With sign-in on, a session can end under an open dashboard: it runs out, or
 * the password is changed elsewhere, which signs every other session out. The
 * next request it makes is refused, and the page would otherwise sit there
 * failing quietly every few seconds. Watching every response from one place
 * means no request has to remember to.
 *
 * Not for the security settings and the sign-in API, which answer "sign in"
 * as part of what they show, nor for the MCP address, which wants a key.
 */

const ASKS_ITS_OWN = ['/api/auth/', '/api/security', '/api/mcp']

function guardedPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(raw, window.location.href)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return null
  return ASKS_ITS_OWN.some(prefix => url.pathname.startsWith(prefix)) ? null : url.pathname
}

export function SessionWatcher() {
  useEffect(() => {
    const original = window.fetch
    let leaving = false

    window.fetch = async (input, init) => {
      const response = await original(input, init)
      if (response.status === 401 && !leaving && window.location.pathname !== '/login' && guardedPath(input)) {
        leaving = true
        const here = window.location.pathname + window.location.search
        window.location.assign(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`)
      }
      return response
    }
    return () => {
      window.fetch = original
    }
  }, [])

  return null
}
