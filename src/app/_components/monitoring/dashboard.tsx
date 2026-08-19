'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type {
  Target,
  TimeRange,
  DataPoint,
  TargetStatistics,
  BucketedMeasurement,
  GroupOrder,
  LatestMeasurement,
  SparklinePoint,
} from '@/types/probe'
import { TIME_RANGE_CONFIG } from '@/types/probe'
import { Sidebar } from './sidebar'
import StatsCards from './stats-cards'
import { TimeRangeSelector } from './time-range-selector'
import { SmokeTrace } from './smoke-trace'
import { ReadoutSkeleton, TraceSkeleton } from './skeleton'
import { buildSeries } from '@/lib/series'
import { useToast } from '@/components/ui/toast'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { AlertsPanel } from './alerts-panel'
import { Button } from '@/components/ui/button'
import { RefreshCw } from 'lucide-react'

const REFRESH_INTERVAL_MS = 30_000

function useTargets(reportError: (title: string, error?: unknown) => void) {
  const [targets, setTargets] = useState<Target[]>([])
  const [latest, setLatest] = useState<Record<string, LatestMeasurement>>({})
  const [series, setSeries] = useState<Record<string, SparklinePoint[]>>({})
  const [groupOrders, setGroupOrders] = useState<GroupOrder[]>([])
  const [isLoaded, setIsLoaded] = useState(false)

  const loadTargets = useCallback(async () => {
    try {
      const response = await fetch('/api/targets?packetLoss=true')
      if (response.ok) {
        const data = await response.json()
        setTargets(data.targets || data)

        const rawLatest: Record<string, Omit<LatestMeasurement, 'timestamp'> & { timestamp: string }> =
          data.latest || {}
        const parsed: Record<string, LatestMeasurement> = {}
        for (const [id, entry] of Object.entries(rawLatest)) {
          parsed[id] = { ...entry, timestamp: new Date(entry.timestamp) }
        }
        setLatest(parsed)
        setSeries(data.series || {})

        if (data.groupOrders) {
          setGroupOrders(data.groupOrders)
        }
      } else {
        reportError('Could not load targets', `Server responded ${response.status}`)
      }
    } catch (error) {
      reportError('Could not load targets', error)
    } finally {
      setIsLoaded(true)
    }
  }, [reportError])

  useEffect(() => {
    // The callback is async and awaits its fetch before touching state, so
    // nothing is set synchronously here; the rule cannot see across the
    // await. Fetching on mount is the intended use of an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTargets()
  }, [loadTargets])

  const addTarget = useCallback(async (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>): Promise<Target | null> => {
    try {
      const response = await fetch('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: target.name,
          host: target.address || target.host,
          probeType: target.type === 'dns' ? 'dns' : target.probeType || 'ping',
          interval: target.interval || 300,
          status: 'active',
          group: target.group,
        }),
      })
      if (response.ok) {
        const created = await response.json()
        await loadTargets()
        return created as Target
      }
      const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
      reportError('Could not add target', error)
    } catch (error) {
      reportError('Could not add target', error)
    }
    return null
  }, [loadTargets, reportError])

  const updateTarget = useCallback(async (id: string, updates: Partial<Target>) => {
    try {
      const response = await fetch(`/api/targets/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      })
      if (response.ok) {
        await loadTargets()
      } else {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError('Could not save changes', error)
      }
    } catch (error) {
      reportError('Could not save changes', error)
    }
  }, [loadTargets, reportError])

  const deleteTarget = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/targets/${id}`, {
        method: 'DELETE',
      })
      if (response.ok) {
        await loadTargets()
      } else {
        reportError('Could not delete target', `Server responded ${response.status}`)
      }
    } catch (error) {
      reportError('Could not delete target', error)
    }
  }, [loadTargets, reportError])

  const reorderGroups = useCallback(async (orders: GroupOrder[]) => {
    // Optimistic update
    setGroupOrders(orders)
    try {
      await fetch('/api/targets/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: orders }),
      })
    } catch (error) {
      reportError('Could not save group order', error)
    }
  }, [reportError])

  const reorderTargets = useCallback(async (updates: { id: string; sortOrder: number; group?: string }[]) => {
    const updateMap = new Map(updates.map(u => [u.id, u]))
    setTargets(prev => prev.map(t => {
      const u = updateMap.get(t.id)
      if (!u) return t
      return { ...t, sortOrder: u.sortOrder, group: u.group === undefined ? t.group : (u.group || undefined) }
    }))
    try {
      await fetch('/api/targets/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: updates }),
      })
    } catch (error) {
      reportError('Could not save target order', error)
    }
  }, [reportError])

  return { targets, latest, series, groupOrders, addTarget, updateTarget, deleteTarget, reorderGroups, reorderTargets, isLoaded, reloadTargets: loadTargets }
}

interface RangeSnapshot {
  points: DataPoint[]
  statistics: TargetStatistics | null
}

/**
 * Load and cache a target's measurements per time range.
 *
 * Switching ranges keeps the previous range's data on screen until the new
 * data arrives, and serves an already-seen range from cache immediately while
 * revalidating behind it. Tearing the chart down and remounting it on every
 * tab press is what made switching feel like a page load.
 */
function useTargetMeasurements(
  targetId: string | null,
  timeRange: TimeRange,
  probeIntervalSeconds: number,
  reportError: (title: string, error?: unknown) => void
) {
  // The snapshot carries the target it belongs to. Keeping stale data across a
  // *range* change is the point of this hook, but keeping it across a *target*
  // change would show one host's history under another host's name.
  const [snapshot, setSnapshot] = useState<(RangeSnapshot & { owner: string }) | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pending, setPending] = useState(false)

  // Keyed by target *and* range, so flicking between two targets is instant
  // rather than re-fetching each time. Clearing the cache whenever the target
  // changed meant every switch paid a full round trip and showed a spinner.
  const cacheRef = useRef(new Map<string, RangeSnapshot>())
  const cacheKey = `${targetId}:${timeRange}`

  const isForCurrentTarget = snapshot !== null && snapshot.owner === targetId

  // Only the newest request may write state: switching ranges quickly can
  // otherwise land a slow earlier response on top of a fast later one.
  const requestIdRef = useRef(0)

  const loadMeasurements = useCallback(async (isManualRefresh = false) => {
    if (!targetId) {
      setSnapshot(null)
      setPending(false)
      return
    }

    const requestId = ++requestIdRef.current
    const cached = cacheRef.current.get(cacheKey)

    if (cached) {
      // Show it straight away, then revalidate behind it.
      setSnapshot({ ...cached, owner: targetId })
      setPending(false)
    } else {
      setPending(true)
    }

    if (isManualRefresh) setRefreshing(true)

    try {
      const hours = TIME_RANGE_CONFIG[timeRange].hours
      const response = await fetch(`/api/targets/${targetId}/measurements?hours=${hours}`)
      if (!response.ok) {
        reportError('Could not load measurements', `Server responded ${response.status}`)
        return
      }

      const result = await response.json()
      const buckets: BucketedMeasurement[] = Array.isArray(result.buckets) ? result.buckets : []

      const next: RangeSnapshot = {
        points: buildSeries(buckets, probeIntervalSeconds, result.bucketMs ?? 60_000),
        statistics: result.statistics
          ? {
              ...result.statistics,
              lastProbe: result.statistics.lastProbe ? new Date(result.statistics.lastProbe) : null,
            }
          : null,
      }

      // Bounded: oldest entries drop out so a long session cannot grow the
      // cache without limit.
      if (cacheRef.current.size >= 40) {
        cacheRef.current.delete(cacheRef.current.keys().next().value!)
      }
      cacheRef.current.set(cacheKey, next)
      if (requestId === requestIdRef.current) setSnapshot({ ...next, owner: targetId })
    } catch (error) {
      reportError('Could not load measurements', error)
    } finally {
      if (requestId === requestIdRef.current) {
        setPending(false)
        setRefreshing(false)
      }
    }
  }, [targetId, timeRange, cacheKey, probeIntervalSeconds, reportError])

  const loadMeasurementsRef = useRef(loadMeasurements)
  useEffect(() => {
    loadMeasurementsRef.current = loadMeasurements
  }, [loadMeasurements])

  useEffect(() => {
    loadMeasurementsRef.current()
  }, [targetId, timeRange, probeIntervalSeconds])

  return {
    points: isForCurrentTarget ? snapshot.points : [],
    statistics: isForCurrentTarget ? snapshot.statistics : null,
    refreshing,
    /** A fetch is in flight with nothing cached to show for this range. */
    pending,
    /** True only before the first result for the current target has arrived. */
    initialLoad: !isForCurrentTarget,
    reload: loadMeasurements,
    manualReload: useCallback(() => loadMeasurements(true), [loadMeasurements]),
  }
}

/** Values describing the target's state right now, from the newest bucket that actually has data. */
function currentReadings(points: DataPoint[]) {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]
    if (point.sampleCount > 0) {
      return {
        latency: point.latency,
        packetLoss: point.packetLoss ?? (point.isOnline === false ? 100 : 0),
        jitter: point.jitter,
        isOnline: point.isOnline === true,
      }
    }
  }
  return { latency: null, packetLoss: null, jitter: null, isOnline: false }
}

export function Dashboard() {
  const { notify, reportError } = useToast()
  const { targets, latest, series, groupOrders, addTarget, updateTarget, deleteTarget, reorderGroups, reorderTargets, isLoaded, reloadTargets } = useTargets(reportError)
  const [timeRange, setTimeRange] = useState<TimeRange>('1h')
  const [probing, setProbing] = useState(false)

  // The remembered selection is read once, lazily, so there is no post-mount
  // effect writing state back into the component. localStorage is unavailable
  // during SSR, hence the guard rather than a plain initialiser.
  const [selectedTargetId, setSelectedTargetIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('selectedTargetId')
  })

  // Persisting belongs with the act of choosing, not in an effect watching the
  // value afterwards.
  const setSelectedTargetId = useCallback((id: string | null) => {
    setSelectedTargetIdState(id)
    if (typeof window === 'undefined') return
    if (id) localStorage.setItem('selectedTargetId', id)
    else localStorage.removeItem('selectedTargetId')
  }, [])

  // Fall back to the first target once loading finishes, and recover if the
  // remembered target has since been deleted. Resolved during render so the
  // pane never paints a frame with nothing selected.
  const resolvedTargetId =
    isLoaded && targets.length > 0 && (!selectedTargetId || !targets.some(t => t.id === selectedTargetId))
      ? targets[0].id
      : selectedTargetId

  if (resolvedTargetId !== selectedTargetId) {
    setSelectedTargetIdState(resolvedTargetId)
  }

  const selectedTarget = useMemo(() => {
    return targets.find(t => t.id === selectedTargetId) || null
  }, [targets, selectedTargetId])

  const { points, statistics, refreshing, pending, reload, manualReload, initialLoad } =
    useTargetMeasurements(selectedTargetId, timeRange, selectedTarget?.interval ?? 300, reportError)

  // One timer drives both the target list and the selected target's chart, so
  // the sidebar indicator and the graph never disagree about what "now" is.
  const reloadRef = useRef(reload)
  const reloadTargetsRef = useRef(reloadTargets)
  useEffect(() => {
    reloadRef.current = reload
    reloadTargetsRef.current = reloadTargets
  }, [reload, reloadTargets])

  useEffect(() => {
    const interval = setInterval(async () => {
      await reloadTargetsRef.current()
      await reloadRef.current()
    }, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  const handleRefresh = useCallback(async () => {
    await Promise.all([reloadTargets(), manualReload()])
  }, [reloadTargets, manualReload])

  const handleProbe = useCallback(async () => {
    if (!selectedTargetId || probing) return

    setProbing(true)
    try {
      const response = await fetch(`/api/targets/${selectedTargetId}/probe`, { method: 'POST' })
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError('Probe failed', error)
        return
      }

      const { result } = await response.json()
      notify({
        tone: result?.success ? 'success' : 'error',
        title: result?.success ? 'Probe complete' : 'Target did not respond',
        detail: result?.success
          ? `${result.latency}ms, ${result.packetLoss ?? 0}% loss`
          : result?.errorMessage,
      })
      // The probe runs to completion server-side before responding, so the new
      // measurement is already stored by the time we reload.
      await Promise.all([reload(), reloadTargets()])
    } catch (error) {
      reportError('Probe failed', error)
    } finally {
      setProbing(false)
    }
  }, [selectedTargetId, probing, reload, reloadTargets, notify, reportError])

  // Pausing stops the scheduler probing a target without deleting its history.
  // The 'paused' status existed in the type from the start but nothing could
  // ever set it.
  const handleTogglePaused = useCallback(
    async (target: Target) => {
      const nextStatus = target.status === 'paused' ? 'active' : 'paused'
      await updateTarget(target.id, { status: nextStatus })
      notify({
        tone: 'info',
        title: nextStatus === 'paused' ? `Paused ${target.name}` : `Resumed ${target.name}`,
        detail:
          nextStatus === 'paused'
            ? 'No further probes will run until it is resumed.'
            : `Probing every ${target.interval}s.`,
      })
    },
    [updateTarget, notify]
  )

  const current = useMemo(() => currentReadings(points), [points])

  // The time of the newest real probe — not the newest chart bucket, which
  // always sits at the current wall-clock time whether or not anything ran.
  const lastUpdated = useMemo(() => {
    if (selectedTargetId && latest[selectedTargetId]) return latest[selectedTargetId].timestamp
    return statistics?.lastProbe ?? undefined
  }, [selectedTargetId, latest, statistics])

  const transformedTargets = useMemo(() => {
    return targets.map(t => {
      const lastMeasurement = latest[t.id]
      return {
        ...t,
        address: t.host,
        type: (t.probeType === 'dns' ? 'dns' : 'ip') as 'ip' | 'domain' | 'dns',
        // Reachability comes from the last measurement. `status` only records
        // whether the user paused the target, so deriving online/offline from
        // it marked every target — including dead ones — as online.
        isOnline: lastMeasurement ? lastMeasurement.success : undefined,
        lastCheck: lastMeasurement?.timestamp,
        avgLatency: lastMeasurement?.latency ?? undefined,
        packetLoss: lastMeasurement?.packetLoss,
        isNew: !lastMeasurement,
      }
    })
  }, [targets, latest])

  const showEmptyState = !selectedTarget
  // Only the very first load for a target blanks the pane. Switching ranges
  // keeps the previous range on screen and dims it, so the layout never
  // collapses and reflows underneath the pointer.
  const showSpinner = !!selectedTarget && initialLoad
  const hasMeasurements = !!statistics && statistics.sampleCount > 0

  return (
    <div className="flex h-screen bg-background">
      <Sidebar
        targets={transformedTargets}
        selectedTargetId={selectedTargetId}
        onSelectTarget={setSelectedTargetId}
        onAddTarget={addTarget}
        onUpdateTarget={updateTarget}
        onDeleteTarget={deleteTarget}
        onTogglePaused={handleTogglePaused}
        series={series}
        groupOrders={groupOrders}
        onReorderGroups={reorderGroups}
        onReorderTargets={reorderTargets}
      />

      <main className="flex-1 overflow-auto">
        {showEmptyState ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <svg viewBox="0 0 120 40" className="mx-auto mb-5 h-10 w-32" fill="none" aria-hidden="true">
                <path
                  d="M2 28 L14 26 L26 30 L38 12 L50 22 L62 18 L74 20 L86 8 L98 24 L118 22"
                  stroke="var(--signal-none)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.6"
                />
              </svg>
              <h2 className="mb-2 text-lg font-semibold tracking-tight text-foreground">
                Pick a path to inspect
              </h2>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                Choose a target from the sidebar to see its latency spread and packet loss, or add
                one to start measuring.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  {selectedTarget.name}
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-mono text-muted-foreground">{selectedTarget.host}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    {selectedTarget.probeType === 'ping' ? 'ICMP' : 'DNS'}
                  </span>
                  {selectedTarget.status === 'paused' && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      Paused
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <TimeRangeSelector value={timeRange} onChange={setTimeRange} busy={pending} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleProbe}
                  disabled={probing}
                  className="shrink-0"
                >
                  {probing ? 'Probing…' : 'Probe now'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="shrink-0"
                  aria-label="Refresh measurements"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                  <span className="ml-2 hidden sm:inline">Refresh</span>
                </Button>
              </div>
            </header>

            <div
              // Dimmed rather than unmounted while new data loads. Pointer
              // events are suppressed so a tooltip cannot be opened on data
              // that is about to be replaced.
              className={
                'space-y-6 transition-opacity duration-200 motion-reduce:transition-none ' +
                (pending && !showSpinner ? 'opacity-50 pointer-events-none' : 'opacity-100')
              }
              aria-busy={pending}
            >
              {showSpinner ? (
                <ReadoutSkeleton />
              ) : (
                <StatsCards statistics={statistics} current={current} lastUpdated={lastUpdated} />
              )}

              {/* Fixed minimum height: the trace and the empty-state message
                  occupy the same space, so swapping between them cannot make
                  the page jump. */}
              <section className="min-h-[26rem] rounded-xl border border-border bg-card p-5">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">Latency &amp; packet loss</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Each band holds more of the packets than the one inside it. Dense means
                      they arrived together; a wide haze means the path is unpredictable.
                    </p>
                  </div>
                  {lastUpdated && !showSpinner && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      last probe{' '}
                      {lastUpdated.toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </p>
                  )}
                </div>

                {showSpinner ? (
                  <TraceSkeleton />
                ) : hasMeasurements ? (
                  <ErrorBoundary label="Trace">
                    <SmokeTrace data={points} timeRange={timeRange} />
                  </ErrorBoundary>
                  ) : (
                    <div className="flex h-[20rem] flex-col items-center justify-center gap-2 text-center">
                      <p className="text-sm text-foreground">Nothing measured in this window yet</p>
                      <p className="max-w-sm text-xs text-muted-foreground">
                        Probes run every {selectedTarget.interval}s. Use Probe now to take a reading
                        immediately, or pick a wider time range.
                      </p>
                    </div>
                  )}
                </section>

                <ErrorBoundary label="Alerts">
                  <AlertsPanel
                key={selectedTarget.id}
                targetId={selectedTarget.id}
                targetName={selectedTarget.name}
              />
                </ErrorBoundary>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
