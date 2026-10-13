'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { extractShareCode } from '@/lib/target-share'

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

const readCode = () => extractShareCode(window.location.hash)
/** The server is never sent what follows the `#`, so it has nothing to read. */
const noCode = () => null

/**
 * The share code in the page's address, when the page was opened from a share
 * link, and a way to take it back out once it has been dealt with.
 *
 * Read from the address itself rather than copied into state on arrival, so a
 * link pasted over the address of a page that is already open is seen too.
 */
export function useIncomingShareCode(): [code: string | null, clear: () => void] {
  const code = useSyncExternalStore(subscribe, readCode, noCode)

  const clear = useCallback(() => {
    if (!readCode()) return
    // Replaced, not navigated away from: going back should not bring the
    // import up a second time.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    // Rewriting the address this way is silent, so say that it changed.
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])

  return [code, clear]
}
