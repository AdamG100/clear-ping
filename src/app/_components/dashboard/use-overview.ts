'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverviewReport } from '@/types/overview'

/**
 * Reading a whole day of every target is more work than anything else the
 * dashboard asks for, and a minute changes little of a day, so it is asked
 * for again at most this often, however often new readings arrive.
 */
const REFRESH_MS = 60_000

/**
 * The last 24 hours, for the overview, read again as new readings come in.
 * `refreshKey` moves on whenever any target has been probed.
 */
export function useOverview(refreshKey: number, reportError: (title: string, error?: unknown) => void) {
  const [report, setReport] = useState<OverviewReport | null>(null)
  const lastAsked = useRef(0)
  const asking = useRef(false)

  const load = useCallback(async () => {
    if (asking.current) return
    asking.current = true
    lastAsked.current = Date.now()
    try {
      const response = await fetch('/api/overview')
      if (response.ok) setReport(await response.json())
      else reportError('Could not load the overview', `Server responded ${response.status}`)
    } catch (error) {
      reportError('Could not load the overview', error)
    } finally {
      asking.current = false
    }
  }, [reportError])

  useEffect(() => {
    if (Date.now() - lastAsked.current < REFRESH_MS) return
    void load()
  }, [load, refreshKey])

  return report
}
