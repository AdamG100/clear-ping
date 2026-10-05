'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type {
  AddressFamily,
  FamilyReading,
  Target,
  TimeRange,
  DataPoint,
  TargetStatistics,
  BucketedMeasurement,
  GroupOrder,
  LatestMeasurement,
  SparklinePoint,
  TimeWindow,
} from '@/types/probe'
import { TIME_RANGE_CONFIG } from '@/types/probe'
import { Sidebar } from './sidebar'
import StatsCards from './stats-cards'
import { TimeRangeSelector } from './time-range-selector'
import { SmokeTrace } from './smoke-trace'
import { ReadoutSkeleton, TraceSkeleton } from './skeleton'
import { buildSeries, MIN_WINDOW_MS } from '@/lib/series'
import { addressFamilyFor, FAMILY_LABEL, isDualStack, targetTypeFor } from '@/lib/host'
import { probeVocabulary } from '@/lib/probe-labels'
import { targetAddressLabel } from '@/lib/probe-config'
import { buildSidebarLayout } from '@/lib/sidebar-layout'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { AlertsPanel } from './alerts-panel'
import { ProbeDetailsPanel } from './probe-details'
import { TraceroutePanel } from './traceroute-panel'
import { ComparePanel } from './compare-panel'
import { formatWindowEdge } from './chart-brush'
import { Button } from '@/components/ui/button'
import { RefreshCw } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'

/** Content that replaces a placeholder fades in over it instead of cutting. */
const FADE_IN = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const

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

        // Timestamps arrive as text, including the ones inside each family's
        // reading of a target probed over both.
        type RawReading = Omit<FamilyReading, 'timestamp'> & { timestamp: string }
        const rawLatest: Record<string, RawReading & { byFamily?: Partial<Record<AddressFamily, RawReading>> }> =
          data.latest || {}
        const parseReading = (entry: RawReading): FamilyReading => ({ ...entry, timestamp: new Date(entry.timestamp) })

        const parsed: Record<string, LatestMeasurement> = {}
        for (const [id, { byFamily, ...entry }] of Object.entries(rawLatest)) {
          parsed[id] = parseReading(entry)
          if (byFamily) {
            parsed[id].byFamily = {}
            for (const family of [4, 6] as const) {
              const reading = byFamily[family]
              if (reading) parsed[id].byFamily[family] = parseReading(reading)
            }
          }
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
          probeType: target.probeType || 'ping',
          ipVersion: target.ipVersion ?? 'auto',
          probeConfig: target.probeConfig,
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
  /**
   * The zoom window these points were fetched for, or null for the whole
   * range. Travels with the data so the chart's axis always matches the points
   * drawn on it, including while the next window is still loading.
   */
  window: TimeWindow | null
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
  reportError: (title: string, error?: unknown) => void,
  zoom: TimeWindow | null,
  /** One side of a target probed over both address families; null for all of it. */
  family: AddressFamily | null
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
  // A family is its own series, so it owns its snapshot the way a target does:
  // IPv4's history must not sit under the IPv6 tab while IPv6 loads.
  const owner = targetId ? `${targetId}:${family ?? 'all'}` : null
  const cacheKey = `${owner}:${timeRange}:${zoom ? `${zoom.start}-${zoom.end}` : 'all'}`

  const isForCurrentTarget = snapshot !== null && snapshot.owner === owner

  // Only the newest request may write state: switching ranges quickly can
  // otherwise land a slow earlier response on top of a fast later one.
  const requestIdRef = useRef(0)

  const loadMeasurements = useCallback(async (isManualRefresh = false) => {
    if (!targetId || !owner) {
      setSnapshot(null)
      setPending(false)
      return
    }

    const requestId = ++requestIdRef.current
    const cached = cacheRef.current.get(cacheKey)

    if (cached) {
      // Show it straight away, then revalidate behind it.
      setSnapshot({ ...cached, owner })
      setPending(false)
    } else {
      setPending(true)
    }

    if (isManualRefresh) setRefreshing(true)

    try {
      const period = zoom
        ? `start=${zoom.start}&end=${zoom.end}`
        : `hours=${TIME_RANGE_CONFIG[timeRange].hours}`
      const query = family ? `${period}&family=${family}` : period
      const response = await fetch(`/api/targets/${targetId}/measurements?${query}`)
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
        window: zoom,
      }

      // Bounded: oldest entries drop out so a long session cannot grow the
      // cache without limit.
      if (cacheRef.current.size >= 40) {
        cacheRef.current.delete(cacheRef.current.keys().next().value!)
      }
      cacheRef.current.set(cacheKey, next)
      if (requestId === requestIdRef.current) setSnapshot({ ...next, owner })
    } catch (error) {
      reportError('Could not load measurements', error)
    } finally {
      if (requestId === requestIdRef.current) {
        setPending(false)
        setRefreshing(false)
      }
    }
  }, [targetId, owner, family, timeRange, zoom, cacheKey, probeIntervalSeconds, reportError])

  const loadMeasurementsRef = useRef(loadMeasurements)
  useEffect(() => {
    loadMeasurementsRef.current = loadMeasurements
  }, [loadMeasurements])

  useEffect(() => {
    loadMeasurementsRef.current()
  }, [targetId, family, timeRange, zoom, probeIntervalSeconds])

  return {
    points: isForCurrentTarget ? snapshot.points : [],
    statistics: isForCurrentTarget ? snapshot.statistics : null,
    /** The zoom window the points on screen belong to; null when unzoomed. */
    window: isForCurrentTarget ? snapshot.window : null,
    refreshing,
    /** A fetch is in flight with nothing cached to show for this range. */
    pending,
    /** True only before the first result for the current target has arrived. */
    initialLoad: !isForCurrentTarget,
    reload: loadMeasurements,
    manualReload: useCallback(() => loadMeasurements(true), [loadMeasurements]),
  }
}

type FamilyView = 'both' | AddressFamily

const FAMILY_VIEWS: { value: FamilyView; label: string }[] = [
  { value: 'both', label: 'Compare' },
  { value: 4, label: 'IPv4' },
  { value: 6, label: 'IPv6' },
]

/**
 * Which side of a dual-stack target is on screen: the two families against
 * each other, or one of them in full.
 */
function FamilySwitch({ value, onChange }: { value: FamilyView; onChange: (view: FamilyView) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-secondary p-1" role="tablist" aria-label="Address family">
      {FAMILY_VIEWS.map(option => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative cursor-pointer rounded-md px-3 py-1 text-xs font-medium',
              'transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {selected && (
              <motion.span
                layoutId="family-view-indicator"
                className="absolute inset-0 rounded-md bg-primary shadow-sm"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative z-10 whitespace-nowrap">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
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
  // A period picked out by dragging across the chart. It narrows the range
  // rather than replacing it, and is dropped whenever the range or the target
  // changes: a window chosen on one trace means nothing on another.
  const [zoom, setZoom] = useState<TimeWindow | null>(null)
  const [probing, setProbing] = useState(false)
  // For a target probed over both address families: which is on screen.
  const [familyView, setFamilyView] = useState<FamilyView>('both')

  // The remembered selection is read once, lazily, so there is no post-mount
  // effect writing state back into the component. localStorage is unavailable
  // during SSR, hence the guard rather than a plain initialiser.
  const [selectedTargetId, setSelectedTargetIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('selectedTargetId')
  })

  // A group can be on screen instead of a target: every target in it on one
  // chart. The target selection is kept underneath, so leaving the group view
  // (or the group disappearing) lands back on something.
  const [selectedGroup, setSelectedGroupState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('selectedGroup')
  })

  // Persisting belongs with the act of choosing, not in an effect watching the
  // value afterwards.
  const setSelectedTargetId = useCallback((id: string | null) => {
    setSelectedTargetIdState(id)
    setSelectedGroupState(null)
    setZoom(null)
    setFamilyView('both')
    if (typeof window === 'undefined') return
    localStorage.removeItem('selectedGroup')
    if (id) localStorage.setItem('selectedTargetId', id)
    else localStorage.removeItem('selectedTargetId')
  }, [])

  const selectGroup = useCallback((groupName: string) => {
    setSelectedGroupState(groupName)
    setZoom(null)
    if (typeof window !== 'undefined') localStorage.setItem('selectedGroup', groupName)
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

  // A DNS target's numbers are query times, not round trips; the page says so.
  const vocabulary = probeVocabulary(selectedTarget?.probeType ?? 'ping')
  // Probed over IPv4 and IPv6 side by side: two series rather than one.
  const dualStack = !!selectedTarget && isDualStack(selectedTarget.host, selectedTarget.ipVersion)
  const comparingFamilies = dualStack && familyView === 'both'
  const shownFamily: AddressFamily | null = dualStack && familyView !== 'both' ? familyView : null
  const addressFamily = selectedTarget && !dualStack
    ? addressFamilyFor(selectedTarget.resolvedAddress ?? selectedTarget.host, selectedTarget.ipVersion)
    : null
  // An HTTP target is one of two protocols, and which one matters: only HTTPS
  // has a certificate to watch.
  const usesHttps = selectedTarget?.probeType === 'http' && (selectedTarget.probeConfig?.scheme ?? 'https') === 'https'
  const methodLabel = selectedTarget?.probeType === 'http' ? (usesHttps ? 'HTTPS' : 'HTTP') : vocabulary.method

  // The members of the group on screen, in sidebar order; null when it is a
  // target that is on screen (or the remembered group no longer exists).
  const groupTargets = useMemo(() => {
    if (!selectedGroup) return null
    const ids = buildSidebarLayout(targets, groupOrders).items[selectedGroup]
    if (!ids || ids.length === 0) return null

    const byId = new Map(targets.map(target => [target.id, target]))
    return ids.map(id => byId.get(id)).filter((target): target is Target => !!target)
  }, [selectedGroup, targets, groupOrders])

  // A comparison loads its own data, so the single-series fetch stands down.
  const singleSeriesTargetId = groupTargets || comparingFamilies ? null : selectedTargetId

  const { points, statistics, window: shownWindow, refreshing, pending, reload, manualReload, initialLoad } =
    useTargetMeasurements(singleSeriesTargetId, timeRange, selectedTarget?.interval ?? 300, reportError, zoom, shownFamily)

  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    setTimeRange(range)
    setZoom(null)
  }, [])

  const handleZoom = useCallback((start: number, end: number) => {
    // A selection only a few pixels wide can span less than one probe. Widen
    // it about its centre rather than zooming into a window with nothing in it.
    const width = Math.max(end - start, MIN_WINDOW_MS)
    const centre = (start + end) / 2
    setZoom({ start: Math.round(centre - width / 2), end: Math.round(centre + width / 2) })
  }, [])

  const handleResetZoom = useCallback(() => setZoom(null), [])

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
        title: result?.success ? 'Probe complete' : 'Probe failed',
        detail: result?.success
          ? vocabulary.summarize(result.latency, result.packetLoss ?? 0)
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
  }, [selectedTargetId, probing, reload, reloadTargets, notify, reportError, vocabulary])

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

  // The newest reading of what is on screen: the target's, or one family's.
  const latestReading = useMemo(() => {
    const reading = selectedTargetId ? latest[selectedTargetId] : undefined
    return shownFamily ? reading?.byFamily?.[shownFamily] : reading
  }, [selectedTargetId, latest, shownFamily])

  // The time of the newest real probe — not the newest chart bucket, which
  // always sits at the current wall-clock time whether or not anything ran.
  const lastUpdated = useMemo(
    () => latestReading?.timestamp ?? statistics?.lastProbe ?? undefined,
    [latestReading, statistics]
  )

  // Moves on whenever any member of the group is probed again.
  const groupRefreshKey = useMemo(
    () => Math.max(0, ...(groupTargets ?? []).map(target => latest[target.id]?.timestamp.getTime() ?? 0)),
    [groupTargets, latest]
  )

  const groupVocabulary = useMemo(() => {
    const kinds = new Set((groupTargets ?? []).map(target => target.probeType))
    // Only a group of one kind can be described in that kind's words.
    return kinds.size === 1 ? probeVocabulary([...kinds][0]) : null
  }, [groupTargets])

  const transformedTargets = useMemo(() => {
    return targets.map(t => {
      const lastMeasurement = latest[t.id]
      return {
        ...t,
        address: t.host,
        type: targetTypeFor(t.host, t.probeType),
        // Reachability comes from the last measurement. `status` only records
        // whether the user paused the target, so deriving online/offline from
        // it marked every target — including dead ones — as online.
        isOnline: lastMeasurement ? lastMeasurement.success : undefined,
        statusNote: lastMeasurement?.byFamily
          ? ([4, 6] as const)
              .filter(family => lastMeasurement.byFamily?.[family])
              .map(family => `${FAMILY_LABEL[family]} ${lastMeasurement.byFamily![family]!.success ? 'answering' : 'not answering'}`)
              .join(', ')
          : undefined,
        lastCheck: lastMeasurement?.timestamp,
        avgLatency: lastMeasurement?.latency ?? undefined,
        packetLoss: lastMeasurement?.packetLoss,
        isNew: !lastMeasurement,
      }
    })
  }, [targets, latest])

  const showEmptyState = !selectedTarget && !groupTargets
  // Only the very first load for a target blanks the pane. Switching ranges
  // keeps the previous range on screen and dims it, so the layout never
  // collapses and reflows underneath the pointer.
  const showSpinner = !!selectedTarget && initialLoad
  const hasMeasurements = !!statistics && statistics.sampleCount > 0

  return (
    <div className="flex h-screen bg-background">
      <Sidebar
        targets={transformedTargets}
        selectedTargetId={groupTargets ? null : selectedTargetId}
        onSelectTarget={setSelectedTargetId}
        selectedGroup={groupTargets ? selectedGroup : null}
        onSelectGroup={selectGroup}
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
          // Switching target fades the old pane out before the new one comes
          // in. The outgoing pane is kept exactly as it last rendered, so its
          // name and its data leave together, and by the time the incoming
          // one appears its measurements have usually arrived — a switch goes
          // from one finished page to another instead of flashing a skeleton
          // in between.
          <MotionConfig reducedMotion="user">
          <AnimatePresence mode="wait" initial={false}>
          {groupTargets ? (
          <motion.div
            key={`group:${selectedGroup}`}
            className="p-6 space-y-6"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">{selectedGroup}</h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    {groupTargets.length} target{groupTargets.length === 1 ? '' : 's'} on one chart
                  </span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]">
                    Group
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-3">
                <TimeRangeSelector value={timeRange} onChange={handleTimeRangeChange} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={reloadTargets}
                  className="shrink-0"
                  aria-label="Refresh measurements"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span className="ml-2 hidden sm:inline">Refresh</span>
                </Button>
              </div>
            </header>

            <ComparePanel
              targets={groupTargets}
              timeRange={timeRange}
              zoom={zoom}
              onZoom={handleZoom}
              onResetZoom={handleResetZoom}
              refreshKey={groupRefreshKey}
              title={`${groupVocabulary?.latencyTitle ?? 'Median latency'}, compared`}
              description={
                'One line per target, on a shared scale. The strips underneath mark when each one ' +
                (groupVocabulary ? `had ${groupVocabulary.lossTitle.toLowerCase()}.` : 'lost packets or failed.')
              }
              onSelectTarget={setSelectedTargetId}
              reportError={reportError}
            />
          </motion.div>
          ) : selectedTarget ? (
          <motion.div
            key={selectedTarget.id}
            className="p-6 space-y-6"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  {selectedTarget.name}
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="break-all font-mono text-muted-foreground">{targetAddressLabel(selectedTarget)}</span>
                  {/* Where a domain pointed on its last probe: the address the
                      readings below were actually taken against. */}
                  {selectedTarget.resolvedAddress && (
                    <span className="font-mono text-muted-foreground/70">
                      <span aria-hidden="true">→ </span>
                      <span className="sr-only">resolves to </span>
                      {selectedTarget.resolvedAddress}
                    </span>
                  )}
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    {methodLabel}
                  </span>
                  {(addressFamily || dualStack) && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] tracking-[0.1em] text-muted-foreground">
                      {dualStack ? 'IPv4 + IPv6' : `IPv${addressFamily}`}
                    </span>
                  )}
                  {selectedTarget.status === 'paused' && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      Paused
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <TimeRangeSelector value={timeRange} onChange={handleTimeRangeChange} busy={pending} />
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

            {dualStack && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <FamilySwitch value={familyView} onChange={view => { setFamilyView(view); setZoom(null) }} />
                <p className="text-xs text-muted-foreground">
                  {comparingFamilies
                    ? 'Probed over both address families every time. Pick one for its full readings.'
                    : `Readings taken over ${FAMILY_LABEL[shownFamily ?? 4]} only.`}
                </p>
              </div>
            )}

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
              {comparingFamilies ? (
                <>
                  <ComparePanel
                    targets={[selectedTarget]}
                    timeRange={timeRange}
                    zoom={zoom}
                    onZoom={handleZoom}
                    onResetZoom={handleResetZoom}
                    refreshKey={lastUpdated?.getTime()}
                    title={`${vocabulary.latencyTitle}: IPv4 and IPv6`}
                    description={`The same target over each address family, on a shared scale. The strips underneath mark when each one had ${vocabulary.lossTitle.toLowerCase()}.`}
                    nameSeries={(target, family) => (family ? FAMILY_LABEL[family] : target.name)}
                    showAddress={false}
                    reportError={reportError}
                  />
                  {([4, 6] as const).map(family => (
                    <ProbeDetailsPanel
                      key={family}
                      probeType={selectedTarget.probeType}
                      latest={latest[selectedTarget.id]?.byFamily?.[family]}
                      label={FAMILY_LABEL[family]}
                    />
                  ))}
                </>
              ) : (
              <>
              <motion.div key={showSpinner ? 'loading' : 'ready'} {...FADE_IN}>
                {showSpinner ? (
                  <ReadoutSkeleton />
                ) : (
                  <StatsCards
                    statistics={statistics}
                    current={current}
                    lastUpdated={lastUpdated}
                    vocabulary={vocabulary}
                  />
                )}
              </motion.div>

              <ProbeDetailsPanel probeType={selectedTarget.probeType} latest={latestReading} />

              {/* Fixed minimum height: the trace and the empty-state message
                  occupy the same space, so swapping between them cannot make
                  the page jump. */}
              <section className="min-h-[26rem] rounded-xl border border-border bg-card p-5">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">{vocabulary.chartTitle}</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Each band holds more of the {vocabulary.unit} than the one inside it. Dense means
                      they arrived together; a wide haze means the path is unpredictable.
                    </p>
                  </div>
                  {zoom ? (
                    // Shown from the moment of the drag, not once the data
                    // lands: it is also the way back out of a period that
                    // turns out to hold no measurements.
                    <p className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                      <span>
                        {formatWindowEdge(zoom.start)} – {formatWindowEdge(zoom.end)}
                      </span>
                      <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={handleResetZoom}>
                        Reset zoom
                      </Button>
                    </p>
                  ) : lastUpdated && !showSpinner && (
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
                    {/* Keyed by the period on screen, so zooming in or back out
                        brings the redrawn trace up rather than swapping it in
                        a single frame. */}
                    <motion.div
                      key={shownWindow ? `${shownWindow.start}-${shownWindow.end}` : 'all'}
                      {...FADE_IN}
                    >
                      <SmokeTrace
                        data={points}
                        timeRange={timeRange}
                        window={shownWindow}
                        onZoom={handleZoom}
                        onResetZoom={handleResetZoom}
                        noLossLabel={vocabulary.noLoss}
                      />
                    </motion.div>
                  </ErrorBoundary>
                  ) : (
                    <div className="flex h-[20rem] flex-col items-center justify-center gap-2 text-center">
                      <p className="text-sm text-foreground">Nothing measured in this window yet</p>
                      <p className="max-w-sm text-xs text-muted-foreground">
                        {zoom
                          ? 'No probe ran in the period you selected. Reset the zoom to return to the full range.'
                          : `Probes run every ${selectedTarget.interval}s. Use Probe now to take a reading immediately, or pick a wider time range.`}
                      </p>
                    </div>
                  )}
                </section>
              </>
              )}

                <ErrorBoundary label="Route">
                  <TraceroutePanel
                    key={selectedTarget.id}
                    targetId={selectedTarget.id}
                    refreshKey={lastUpdated?.getTime()}
                  />
                </ErrorBoundary>

                <ErrorBoundary label="Alerts">
                  <AlertsPanel
                    key={selectedTarget.id}
                    targetId={selectedTarget.id}
                    targetName={selectedTarget.name}
                    hasCertificate={usesHttps}
                  />
                </ErrorBoundary>
            </div>
          </motion.div>
          ) : null}
          </AnimatePresence>
          </MotionConfig>
        )}
      </main>
    </div>
  )
}
