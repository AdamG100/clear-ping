'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameRegion, RegionReading } from '@/lib/game-ping/catalogue'
import { cellKey, type Cell } from '@/lib/game-ping/results'
import type { ProbeId } from '@/types/probe-agent'

/** Tests the page has running at once. The dashboard has a limit of its own across everyone. */
const AT_ONCE = 4

/** Times a test the dashboard was too busy for is asked again, before it is shown as failed. */
const RETRIES = 3

export class DashboardError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null
  ) {
    super(message)
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    throw new DashboardError(
      (body as { error?: string } | null)?.error ?? `The dashboard answered ${response.status}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
    )
  }
  return body as T
}

/** Waits, or stops waiting the moment the run is stopped. Leaves no timer behind either way. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Runs a game's regions against the probes, a few at a time, and keeps a cell
 * for each. Stopping, a new game, or leaving the page aborts what is in
 * flight, so nothing keeps running or writing to a page no one is on.
 */
export function useRegionTest(game: string | undefined) {
  const [cells, setCells] = useState<ReadonlyMap<string, Cell>>(() => new Map())
  const [testing, setTesting] = useState(false)
  const run = useRef<AbortController | null>(null)

  const set = useCallback((key: string, cell: Cell) => {
    setCells(current => new Map(current).set(key, cell))
  }, [])

  const stop = useCallback(() => {
    run.current?.abort()
    run.current = null
    setTesting(false)
    // What was waiting or running is let go, so the grid shows only what came back.
    setCells(current => new Map([...current].filter(([, cell]) => cell.state !== 'running' && cell.state !== 'queued')))
  }, [])

  const clear = useCallback(() => {
    run.current?.abort()
    run.current = null
    setTesting(false)
    setCells(new Map())
  }, [])

  // A new game starts clean.
  useEffect(() => clear, [game, clear])

  const start = useCallback(
    async (regions: readonly GameRegion[], probes: readonly ProbeId[]) => {
      if (!game) return
      run.current?.abort()
      const abort = new AbortController()
      run.current = abort
      setTesting(true)

      // Region by region, so the grid fills from the top, each across every probe.
      const jobs = regions.flatMap(region => probes.map(probe => ({ region: region.id, probe, key: cellKey(region.id, probe) })))
      setCells(new Map(jobs.map(job => [job.key, { state: 'queued' } as const])))

      let next = 0
      const worker = async () => {
        while (!abort.signal.aborted && next < jobs.length) {
          const { region, probe, key } = jobs[next++]
          set(key, { state: 'running' })
          const query = new URLSearchParams({ region, probe })
          for (let attempt = 0; ; attempt++) {
            try {
              const reading = await getJson<RegionReading>(`/api/game-ping/${encodeURIComponent(game)}/test?${query}`, abort.signal)
              if (!abort.signal.aborted) set(key, { state: 'done', reading })
              break
            } catch (error) {
              if (abort.signal.aborted) return
              // Busy across everyone using the page: wait as the dashboard asks, then ask again.
              if (error instanceof DashboardError && error.status === 429 && attempt < RETRIES) {
                await pause((error.retryAfter ?? 5) * 1000, abort.signal)
                continue
              }
              set(key, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
              break
            }
          }
        }
      }
      await Promise.all(Array.from({ length: AT_ONCE }, worker))
      if (run.current === abort) {
        run.current = null
        setTesting(false)
      }
    },
    [game, set]
  )

  return { cells, testing, start, stop }
}
