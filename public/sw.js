/*
 * ClearPing's service worker.
 *
 * It does one thing: when a page cannot be fetched, it answers with a page of
 * ClearPing's own instead of leaving the browser to show its error. Installed
 * as an app there is no address bar and no reload button, so the browser's
 * error page is a dead end.
 *
 * It deliberately caches nothing else. Every reading the app shows comes from
 * the server, and an old copy of the dashboard over a server that cannot be
 * reached would show a network's health as it was, looking as if it were now.
 * The app's scripts and styles are named after their contents and already kept
 * by the browser's own cache.
 *
 * Plain JavaScript in `public/`, not part of the build: a service worker has
 * to be served from the root of the site, at an address that never changes.
 */

const CACHE_PREFIX = 'clearping-'
/* Change the number when offline.html changes, so the new one is fetched. */
const CACHE = CACHE_PREFIX + 'offline-v2'
const OFFLINE_URL = '/offline.html'

/* What a reverse proxy answers with when the app behind it is not running. */
const UNREACHABLE = [502, 503, 504]

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `reload`: straight from the server, not from the browser's cache.
      .then(cache => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name)
      }
      // Lets the browser start fetching a page while this worker is still
      // waking up, so being installed never makes opening the app slower.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable()
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', event => {
  // Pages only. Everything else goes to the network as if this were not here.
  if (event.request.mode !== 'navigate') return

  event.respondWith(
    (async () => {
      try {
        const response = (await event.preloadResponse) || (await fetch(event.request))
        if (!UNREACHABLE.includes(response.status)) return response
      } catch {
        // No network, or nothing listening at the other end.
      }
      return (await caches.match(OFFLINE_URL)) || Response.error()
    })()
  )
})
