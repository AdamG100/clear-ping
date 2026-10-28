'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BgpOverview, BgpPrefixDetail } from '@/types/bgp'

/**
 * BGP monitoring as the routing pages see it, asked for again every few
 * seconds while a page is open and the tab is in view: the routes change as
 * RIS Live delivers them, and the page is meant to be watched.
 */
const REFRESH_MS = 8_000

function usePolled<T>(url: string | null, what: string, reportError: (title: string, error?: unknown) => void) {
  const [data, setData] = useState<T | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  // When it arrived: what "3 minutes ago" is counted from.
  const [fetchedAt, setFetchedAt] = useState(0)
  const asking = useRef(false)
  const reported = useRef(false)

  const load = useCallback(async () => {
    if (!url || asking.current) return
    asking.current = true
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.ok) {
        setData(await response.json())
        setFetchedAt(Date.now())
        setMissing(null)
        reported.current = false
      } else if (response.status === 404 || response.status === 409) {
        setMissing((await response.json().catch(() => null))?.error ?? 'Not found')
      } else if (!reported.current) {
        // Once, not every few seconds while the server is unwell.
        reported.current = true
        reportError(`Could not load ${what}`, `Server responded ${response.status}`)
      }
    } catch (error) {
      if (!reported.current) {
        reported.current = true
        reportError(`Could not load ${what}`, error)
      }
    } finally {
      asking.current = false
    }
  }, [url, what, reportError])

  useEffect(() => {
    // The first right away, from a timer as the rest are.
    const first = setTimeout(() => void load(), 0)
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [load])

  return { data, missing, fetchedAt, reload: load, setData }
}

/** Said on the window when BGP monitoring is turned on or off, so the sidebar follows at once. */
const ROUTING_CHANGED = 'clearping:routing-changed'

export function announceRoutingChanged(): void {
  window.dispatchEvent(new Event(ROUTING_CHANGED))
}

/**
 * BGP monitoring at a glance, for the sidebar and the overview: null until
 * read. Asked every minute, and at once when it is turned on or off; quietly,
 * as the routing page is where what is wrong is said.
 */
export function useRoutingGlance(): BgpOverview | null {
  const [overview, setOverview] = useState<BgpOverview | null>(null)
  useEffect(() => {
    const load = async () => {
      if (document.hidden) return
      try {
        const response = await fetch('/api/bgp', { cache: 'no-store' })
        if (response.ok) setOverview((await response.json()) as BgpOverview)
      } catch {
        // Said on the routing page; here it is only a glance.
      }
    }
    const reload = () => void load()
    // After the first render, as every fetch here starts.
    const first = setTimeout(reload, 0)
    const timer = setInterval(reload, 60_000)
    window.addEventListener(ROUTING_CHANGED, reload)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
      window.removeEventListener(ROUTING_CHANGED, reload)
    }
  }, [])
  return overview
}

/** For the sidebar: whether BGP monitoring is on (null until known), and how many prefixes are not as normal. */
export function useRoutingStatus(): { enabled: boolean | null; trouble: number } {
  const overview = useRoutingGlance()
  return {
    enabled: overview?.enabled ?? null,
    trouble: overview?.enabled ? overview.prefixes.filter(each => !['normal', 'learning'].includes(each.status.state)).length : 0,
  }
}

export function useBgpOverview(reportError: (title: string, error?: unknown) => void) {
  return usePolled<BgpOverview>('/api/bgp', 'BGP monitoring', reportError)
}

export function useBgpPrefix(id: string, reportError: (title: string, error?: unknown) => void) {
  return usePolled<BgpPrefixDetail>(`/api/bgp/${encodeURIComponent(id)}`, 'the prefix', reportError)
}
