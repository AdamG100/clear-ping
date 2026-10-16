import { NextResponse, type NextRequest } from 'next/server'
import { decide, FACTOR_SETUP_PAGE, hostAllowed, identify, routeKind, securityPolicy } from '@/lib/security/access'

/**
 * The one place every page and API request passes through first, and so the
 * one place sign-in is enforced: a route added later is covered without
 * anyone remembering to. See src/lib/security/access.ts for the rules.
 *
 * With sign-in switched off, which is the default, this lets everything
 * through and only turns away a key that is wrong or that may only read.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  // The health check is asked by the container itself, at 127.0.0.1.
  if (pathname !== '/api/health') {
    const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0].trim() || null
    if (!hostAllowed(request.headers.get('host')) || (forwarded && !hostAllowed(forwarded))) {
      return NextResponse.json({ error: 'This address is not one ClearPing was set up to answer to (CLEARPING_ALLOWED_HOSTS)' }, { status: 421 })
    }
  }

  const open = routeKind(pathname) === 'open'

  // Open paths need no identity, only to not be a way in for another site.
  const [policy, identity] = open
    ? [{ loginRequired: false }, { actor: null, invalidKey: false }]
    : await Promise.all([securityPolicy(), identify(request)])
  const decision = decide({
    pathname,
    method: request.method,
    policy,
    identity,
    origin: request.headers.get('origin'),
    host: request.headers.get('host'),
    fetchSite: request.headers.get('sec-fetch-site'),
  })

  if (decision.allow) return NextResponse.next()
  if ('setup' in decision) {
    const setup = new URL(FACTOR_SETUP_PAGE, request.url)
    if (pathname !== '/') setup.searchParams.set('next', pathname + search)
    return NextResponse.redirect(setup)
  }
  if ('signIn' in decision) {
    const login = new URL('/login', request.url)
    if (pathname !== '/') login.searchParams.set('next', pathname + search)
    return NextResponse.redirect(login)
  }
  return NextResponse.json(
    { error: decision.message },
    { status: decision.status, headers: decision.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined }
  )
}

export const config = {
  // Everything but the files a signed-out browser still needs: the scripts and
  // styles the sign-in page is built from, the icons and manifest that make it
  // installable, and the service worker with the page it shows offline.
  matcher: [
    '/((?!_next/static|favicon\\.ico|icons/|manifest\\.webmanifest|sw\\.js|offline\\.html|robots\\.txt).*)',
  ],
}
