'use client'

import { useEffect } from 'react'

/**
 * Starts the service worker (`public/sw.js`), which is what gives the
 * installed app a page of its own to show when the server cannot be reached.
 *
 * Only in a production build: in development it would sit between the browser
 * and a server that is restarted and rebuilt all day. And only where the
 * browser offers one at all, which is over HTTPS or on localhost. Reached over
 * plain HTTP the app works exactly as before, without the offline page.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return

    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(error => {
      console.error('Could not start the service worker', error)
    })
  }, [])

  return null
}
