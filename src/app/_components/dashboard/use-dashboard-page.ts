'use client'

import { useCallback, useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { pageFromPath, pathOf, type DashboardPage } from '@/lib/dashboard-pages'

/**
 * Which page the dashboard is showing, read from the address, and a way to
 * go to another.
 *
 * Going is `history.pushState`, which Next.js follows: the address changes
 * and `usePathname` with it, but nothing is loaded and the dashboard is not
 * mounted afresh, so its targets, charts and sidebar stay as they are. Back
 * and forward move between pages the same way.
 */
export function useDashboardPage(): {
  page: DashboardPage | null
  goTo: (page: DashboardPage | null, how?: 'push' | 'replace') => void
} {
  const pathname = usePathname()
  const page = useMemo(() => pageFromPath(pathname ?? '/'), [pathname])

  const goTo = useCallback((next: DashboardPage | null, how: 'push' | 'replace' = 'push') => {
    const path = pathOf(next)
    if (path === window.location.pathname) return
    if (how === 'push') window.history.pushState(null, '', path)
    else window.history.replaceState(null, '', path)
  }, [])

  return { page, goTo }
}
