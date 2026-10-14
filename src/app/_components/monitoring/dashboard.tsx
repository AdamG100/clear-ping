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
  TargetDefinition,
  TimeWindow,
} from '@/types/probe'
import { TIME_RANGE_CONFIG } from '@/types/probe'
import { Sidebar } from './sidebar'
import { MobileTopBar } from './mobile-top-bar'
import { useSidebarDrawer } from './use-sidebar-drawer'
import { PANE, PANE_ACTION, PANE_ACTIONS, PANE_HEADER, PANE_TITLE } from './pane-layout'
import StatsCards from './stats-cards'
import { TimeRangeSelector } from './time-range-selector'
import { SmokeTrace } from './smoke-trace'
import { PaneSkeleton, ReadoutSkeleton, TraceSkeleton } from './skeleton'
import { buildSeries, MIN_WINDOW_MS } from '@/lib/series'
import { addressFamilyFor, FAMILY_LABEL, isDualStack, targetTypeFor } from '@/lib/host'
import { alertTitle } from '@/lib/alert-delivery'
import { probeVocabulary } from '@/lib/probe-labels'
import { DNS_QUERIES_PER_PROBE, nameRecordType, targetAddressLabel } from '@/lib/probe-config'
import { groupLabel, isWithinGroup, rebaseGroupPath } from '@/lib/group-path'
import { buildSidebarLayout, targetsWithin } from '@/lib/sidebar-layout'
import { useToast } from '@/components/notifications'
import { ErrorBoundary } from '@/components/error-boundary'
import { AlertsView, type AlertResponse } from './alerts-view'
import { SettingsPage } from './settings-page'
import { useDashboardPage } from './use-dashboard-page'
import { useSignedIn } from './use-signed-in'
import { DEFAULT_SETTINGS_SECTION, isSettingsSection, type DashboardPage } from '@/lib/dashboard-pages'
import { ProbeDetailsPanel } from './probe-details'
import { TraceroutePanel } from './traceroute-panel'
import { ComparePanel } from './compare-panel'
import { FamilySection } from './family-section'
import { formatWindowEdge } from './chart-brush'
import { ChartLine } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'

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
  // Every group there is, as paths: a group is there whether or not a target is in it.
  const [groups, setGroups] = useState<string[]>([])
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

        setGroups(data.groups || [])
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

  const importTargets = useCallback(async (definitions: TargetDefinition[]): Promise<boolean> => {
    try {
      const response = await fetch('/api/targets/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: definitions }),
      })
      if (response.ok) {
        await loadTargets()
        return true
      }
      const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
      reportError('Could not import the targets', error)
    } catch (error) {
      reportError('Could not import the targets', error)
    }
    return false
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

  const deleteTargets = useCallback(async (ids: string[]): Promise<number | null> => {
    try {
      const response = await fetch('/api/targets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (response.ok) {
        const { deleted } = await response.json()
        await loadTargets()
        return deleted
      }
      const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
      reportError('Could not delete the targets', error)
    } catch (error) {
      reportError('Could not delete the targets', error)
    }
    return null
  }, [loadTargets, reportError])

  const reorderGroups = useCallback(async (orders: GroupOrder[]) => {
    // Optimistic update. Only one level of the tree is saved at a time, so
    // the positions of every other group are kept as they were.
    const reordered = new Set(orders.map(order => order.groupName))
    setGroupOrders(previous => [...previous.filter(order => !reordered.has(order.groupName)), ...orders])
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

  /** Make a change to the groups themselves; true if it was made. */
  const changeGroups = useCallback(async (method: 'POST' | 'PUT' | 'DELETE', body: object, failure: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/groups', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        await loadTargets()
        return true
      }
      const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
      reportError(failure, error)
    } catch (error) {
      reportError(failure, error)
    }
    return false
  }, [loadTargets, reportError])

  const createGroup = useCallback(
    (group: string) => changeGroups('POST', { group }, 'Could not create the group'),
    [changeGroups]
  )

  const moveGroup = useCallback(
    (from: string, to: string) => changeGroups('PUT', { from, to }, 'Could not move the group'),
    [changeGroups]
  )

  const deleteGroup = useCallback(
    (group: string) => changeGroups('DELETE', { group }, 'Could not delete the group'),
    [changeGroups]
  )

  return { targets, latest, series, groups, groupOrders, createGroup, deleteGroup, addTarget, importTargets, updateTarget, deleteTarget, deleteTargets, reorderGroups, reorderTargets, moveGroup, isLoaded, reloadTargets: loadTargets }
}

function useAlerts(reportError: (title: string, error?: unknown) => void) {
  const [alerts, setAlerts] = useState<AlertResponse[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/alerts')
      if (response.ok) setAlerts((await response.json()).alerts ?? [])
      else reportError('Could not load alerts', `Server responded ${response.status}`)
    } catch (error) {
      reportError('Could not load alerts', error)
    } finally {
      setLoaded(true)
    }
  }, [reportError])

  useEffect(() => {
    // As with the targets: nothing is set before the fetch has been awaited.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return { alerts, loaded, reload: load }
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

  const loadMeasurements = useCallback(async () => {
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
      if (requestId === requestIdRef.current) setPending(false)
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
    /** A fetch is in flight with nothing cached to show for this range. */
    pending,
    /** True only before the first result for the current target has arrived. */
    initialLoad: !isForCurrentTarget,
    reload: loadMeasurements,
  }
}

type FamilyView = 'both' | AddressFamily

const FAMILY_VIEWS: { value: string; view: FamilyView; label: string }[] = [
  { value: 'both', view: 'both', label: 'Compare' },
  { value: '4', view: 4, label: 'IPv4' },
  { value: '6', view: 6, label: 'IPv6' },
]

/**
 * Which side of a dual-stack target is on screen: the two families against
 * each other, or one of them in full.
 */
function FamilySwitch({ value, onChange }: { value: FamilyView; onChange: (view: FamilyView) => void }) {
  return (
    <SegmentedControl
      label="Address family"
      value={String(value)}
      onValueChange={chosen => onChange(FAMILY_VIEWS.find(option => option.value === chosen)?.view ?? 'both')}
      options={FAMILY_VIEWS.map(({ value: option, label }) => ({ value: option, label }))}
    />
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

/**
 * Which alerts are watching the target on screen, and a way to the place they
 * are managed. Alerts are no longer made here, but a target's page should
 * still say whether anything would tell you if it broke.
 */
function TargetAlerts({
  alerts,
  targetId,
  onManage,
}: {
  alerts: AlertResponse[]
  targetId: string
  onManage: () => void
}) {
  const watching = alerts.filter(alert => alert.targets.some(entry => entry.targetId === targetId))

  return (
    <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-3xl border border-border bg-card px-4 py-4 @2xl/main:px-6">
      <h2 className="text-sm font-medium text-foreground">Alerts</h2>
      {watching.length === 0 ? (
        <p className="text-xs text-muted-foreground">No alert is watching this target.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {watching.map(alert => {
            const firing = alert.enabled && alert.targets.some(entry => entry.targetId === targetId && entry.state === 'firing')
            return (
              <li key={alert.id}>
                <Badge tone={firing ? 'danger' : alert.enabled ? 'success' : 'neutral'}>
                  {alertTitle(alert)}
                  {firing ? ': firing' : !alert.enabled ? ': muted' : ''}
                </Badge>
              </li>
            )
          })}
        </ul>
      )}
      <span className="ml-auto">
        <Button variant="secondary" size="sm" onClick={onManage}>
          Manage alerts
        </Button>
      </span>
    </section>
  )
}

export function Dashboard() {
  const { notify, reportError } = useToast()
  const { targets, latest, series, groups, groupOrders, createGroup, deleteGroup, addTarget, importTargets, updateTarget, deleteTarget, deleteTargets, reorderGroups, reorderTargets, moveGroup, isLoaded, reloadTargets } = useTargets(reportError)
  const { alerts, loaded: alertsLoaded, reload: reloadAlerts } = useAlerts(reportError)
  // A page (alerts, settings) takes the place of a target or a group in the
  // main pane. Which one is part of the address.
  const { page, goTo } = useDashboardPage()
  const showingAlerts = page?.kind === 'alerts'
  // A viewer is shown everything and offered nothing to change.
  const readOnly = useSignedIn()?.role === 'viewer'
  // On a narrow screen the sidebar is a drawer over the page. Choosing
  // anything in it is the reason it was opened, so every choice closes it.
  // On a wide one it sits beside the page and can be collapsed to a rail of icons.
  const {
    open: sidebarOpen,
    show: showSidebar,
    hide: hideSidebar,
    collapsed: sidebarCollapsed,
    collapse: collapseSidebar,
    expand: expandSidebar,
  } = useSidebarDrawer()
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
    goTo(null)
    setZoom(null)
    setFamilyView('both')
    hideSidebar()
    if (typeof window === 'undefined') return
    localStorage.removeItem('selectedGroup')
    if (id) localStorage.setItem('selectedTargetId', id)
    else localStorage.removeItem('selectedTargetId')
  }, [hideSidebar, goTo])

  const selectGroup = useCallback((groupName: string) => {
    setSelectedGroupState(groupName)
    goTo(null)
    setZoom(null)
    hideSidebar()
    if (typeof window !== 'undefined') localStorage.setItem('selectedGroup', groupName)
  }, [hideSidebar, goTo])

  const openPage = useCallback((next: DashboardPage) => {
    goTo(next)
    hideSidebar()
  }, [goTo, hideSidebar])
  const openAlerts = useCallback(() => openPage({ kind: 'alerts' }), [openPage])
  // Takes anything, because it is handed straight to buttons as their click
  // handler, and an event is not a section: only a real one is taken.
  const openSettings = useCallback(
    (section?: unknown) =>
      openPage({ kind: 'settings', section: isSettingsSection(section) ? section : DEFAULT_SETTINGS_SECTION }),
    [openPage]
  )

  // A group on screen keeps being on screen under its new name.
  const handleMoveGroup = useCallback(async (from: string, to: string) => {
    if (!(await moveGroup(from, to))) return
    if (selectedGroup && isWithinGroup(selectedGroup, from)) {
      const moved = rebaseGroupPath(selectedGroup, from, to)
      setSelectedGroupState(moved)
      if (typeof window !== 'undefined') localStorage.setItem('selectedGroup', moved)
    }
  }, [moveGroup, selectedGroup])

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
  // A DNS target asking more than one resolver: besides the chart of all its
  // queries together, each resolver gets a line of its own to be compared by.
  const targetResolvers = useMemo(
    () => (selectedTarget?.probeType === 'dns' ? selectedTarget.probeConfig?.resolvers ?? [] : []),
    [selectedTarget]
  )
  const comparesResolvers = targetResolvers.length > 1
  // The record those resolvers are asked for over one family, or over the
  // only one there is. It is the IP version that chooses between A and AAAA.
  const recordAsked = (family: AddressFamily | null) =>
    nameRecordType(
      selectedTarget?.probeConfig?.recordType,
      family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : selectedTarget?.ipVersion
    )
  const questionAsked = (family: AddressFamily | null) =>
    selectedTarget && targetResolvers.length > 0 ? `the ${recordAsked(family)} record of ${selectedTarget.host}` : undefined
  // One resolver's line on a chart of them: what each point is, and what the
  // two figures that are not times are figures of.
  const resolverChart = {
    description:
      `One line for each resolver, on a shared scale. A point is one probe: the average of the ${DNS_QUERIES_PER_PROBE} ` +
      'queries that probe sent to that resolver. The strips underneath mark the probes in which it failed to answer some or all of them.',
    note:
      'Failed is the share of the queries sent to that resolver that got no usable answer. Uptime is the share of probes in which it answered at least one.',
  }

  // The members of the group on screen, in sidebar order, including those of
  // the groups inside it; null when it is a target that is on screen (or the
  // remembered group no longer exists).
  const groupTargets = useMemo(() => {
    if (!selectedGroup) return null
    const ids = targetsWithin(buildSidebarLayout(targets, groupOrders), selectedGroup)
    if (ids.length === 0) return null

    const byId = new Map(targets.map(target => [target.id, target]))
    return ids.map(id => byId.get(id)).filter((target): target is Target => !!target)
  }, [selectedGroup, targets, groupOrders])

  // A comparison loads its own data, so the single-series fetch stands down.
  const singleSeriesTargetId = groupTargets || comparingFamilies ? null : selectedTargetId

  const { points, statistics, window: shownWindow, pending, reload, initialLoad } =
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
  const reloadAlertsRef = useRef(reloadAlerts)
  useEffect(() => {
    reloadRef.current = reload
    reloadTargetsRef.current = reloadTargets
    reloadAlertsRef.current = reloadAlerts
  }, [reload, reloadTargets, reloadAlerts])

  useEffect(() => {
    const interval = setInterval(async () => {
      await reloadTargetsRef.current()
      await reloadRef.current()
      await reloadAlertsRef.current()
    }, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

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

  const handleImportTargets = useCallback(
    async (definitions: TargetDefinition[]) => {
      const added = await importTargets(definitions)
      if (added) {
        notify({
          tone: 'success',
          title: `Imported ${definitions.length} target${definitions.length === 1 ? '' : 's'}`,
          detail: 'Their first readings will be in shortly.',
        })
      }
      return added
    },
    [importTargets, notify]
  )

  const handleDeleteTargets = useCallback(
    async (ids: string[]) => {
      const deleted = await deleteTargets(ids)
      if (deleted === null) return false
      notify({
        tone: 'info',
        title: `Deleted ${deleted} target${deleted === 1 ? '' : 's'}`,
        detail: 'Their history, alert rules and saved routes went with them.',
      })
      return true
    },
    [deleteTargets, notify]
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

  // Alerts that are firing on at least one target, for the sidebar's count.
  const firingAlerts = useMemo(
    () => alerts.filter(alert => alert.enabled && alert.targets.some(entry => entry.state === 'firing')).length,
    [alerts]
  )

  // Before the list of targets has arrived, "nothing selected" only means
  // "not known yet". Saying so with the empty state flashed "Pick a path to
  // inspect" on every refresh, ahead of the target that was selected all along.
  const showLoadingState = !isLoaded && !page
  const showEmptyState = !selectedTarget && !groupTargets && !page
  // Only the very first load for a target blanks the pane. Switching ranges
  // keeps the previous range on screen and dims it, so the layout never
  // collapses and reflows underneath the pointer.
  const showSpinner = !!selectedTarget && initialLoad
  const hasMeasurements = !!statistics && statistics.sampleCount > 0

  return (
    // `dvh`, not `vh`: on a phone `vh` is the height with the browser's bars
    // tucked away, so the bottom of the page sat underneath them.
    <div className="flex h-dvh bg-background">
      <Sidebar
        open={sidebarOpen}
        onClose={hideSidebar}
        collapsed={sidebarCollapsed}
        onCollapse={collapseSidebar}
        onExpand={expandSidebar}
        targets={transformedTargets}
        selectedTargetId={groupTargets || page ? null : selectedTargetId}
        onSelectTarget={setSelectedTargetId}
        selectedGroup={groupTargets && !page ? selectedGroup : null}
        onSelectGroup={selectGroup}
        onMoveGroup={handleMoveGroup}
        alertsOpen={showingAlerts}
        onOpenAlerts={openAlerts}
        settingsOpen={page?.kind === 'settings'}
        onOpenSettings={openSettings}
        readOnly={readOnly}
        firingAlerts={firingAlerts}
        onAddTarget={addTarget}
        onImportTargets={handleImportTargets}
        onDeleteTargets={handleDeleteTargets}
        onUpdateTarget={updateTarget}
        onDeleteTarget={deleteTarget}
        onTogglePaused={handleTogglePaused}
        series={series}
        groups={groups}
        groupOrders={groupOrders}
        onReorderGroups={reorderGroups}
        onCreateGroup={createGroup}
        onDeleteGroup={deleteGroup}
        onReorderTargets={reorderTargets}
        loading={!isLoaded}
      />

      {/* Behind an open drawer the page cannot be used, by pointer or by
          keyboard, until the drawer is closed. */}
      <div className="flex min-w-0 flex-1 flex-col" inert={sidebarOpen}>
      <MobileTopBar
        sidebarOpen={sidebarOpen}
        onOpenSidebar={showSidebar}
        alertsOpen={showingAlerts}
        onOpenAlerts={openAlerts}
        firingAlerts={firingAlerts}
      />

      {/* The gutter is kept whether or not the page is long enough to scroll.
          Otherwise the scrollbar arriving with the last panels narrows the
          pane, and everything in it, charts included, shifts sideways.
          The pane is a container: what is inside is laid out from the pane's
          own width, not the screen's (see pane-layout.ts). */}
      <main className="@container/main flex-1 overflow-x-hidden overflow-y-auto scrollbar-gutter-stable pb-(--safe-bottom) pr-(--safe-right) max-lg:pl-(--safe-left) lg:pt-(--safe-top)">
        {showLoadingState ? (
          <PaneSkeleton />
        ) : showEmptyState ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<ChartLine size={24} strokeWidth={1.75} />}
              title="Pick a path to inspect"
              description="Choose a target from the sidebar to see its latency spread and packet loss, or add one to start measuring."
            />
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
          {showingAlerts ? (
          <motion.div
            key="alerts"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <ErrorBoundary label="Alerts">
              <AlertsView
                alerts={alerts}
                loaded={alertsLoaded}
                targets={transformedTargets}
                groupOrders={groupOrders}
                onChanged={reloadAlerts}
                onSelectTarget={setSelectedTargetId}
                readOnly={readOnly}
              />
            </ErrorBoundary>
          </motion.div>
          ) : page?.kind === 'settings' ? (
          <motion.div
            key="settings"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <ErrorBoundary label="Settings">
              {/* The section is part of the address but not of the history:
                  going back leaves Settings rather than stepping through it. */}
              <SettingsPage section={page.section} onSection={section => goTo({ kind: 'settings', section }, 'replace')} />
            </ErrorBoundary>
          </motion.div>
          ) : groupTargets ? (
          <motion.div
            key={`group:${selectedGroup}`}
            className={PANE}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <header className={PANE_HEADER}>
              <div className="min-w-0">
                <h1 className={PANE_TITLE}>{groupLabel(selectedGroup ?? '')}</h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    {groupTargets.length} target{groupTargets.length === 1 ? '' : 's'} on one chart
                  </span>
                  <Badge size="sm">Group</Badge>
                </p>
              </div>
              <div className={PANE_ACTIONS}>
                <TimeRangeSelector value={timeRange} onChange={handleTimeRangeChange} />
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
            className={PANE}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <header className={PANE_HEADER}>
              <div className="min-w-0">
                <h1 className={PANE_TITLE}>
                  {selectedTarget.name}
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="break-all font-mono text-muted-foreground">{targetAddressLabel(selectedTarget)}</span>
                  {/* Where a domain pointed on its last probe: the address the
                      readings below were actually taken against. */}
                  {selectedTarget.resolvedAddress && (
                    <span className="break-all font-mono text-muted-foreground/70">
                      <span aria-hidden="true">→ </span>
                      <span className="sr-only">resolves to </span>
                      {selectedTarget.resolvedAddress}
                    </span>
                  )}
                  <Badge size="sm">{methodLabel}</Badge>
                  {(addressFamily || dualStack) && <Badge size="sm">{dualStack ? 'IPv4 + IPv6' : `IPv${addressFamily}`}</Badge>}
                  {selectedTarget.status === 'paused' && <Badge size="sm" tone="warning">Paused</Badge>}
                </p>
              </div>
              <div className={PANE_ACTIONS}>
                <TimeRangeSelector value={timeRange} onChange={handleTimeRangeChange} busy={pending} />
                {!readOnly && (
                  <span className={PANE_ACTION}>
                    <Button variant="secondary" size="sm" className="w-full" onClick={handleProbe} loading={probing}>
                      Probe now
                    </Button>
                  </span>
                )}
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
                'space-y-4 transition-opacity duration-200 motion-reduce:transition-none @2xl/main:space-y-6 ' +
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
                    description={
                      targetResolvers.length > 0
                        // Two lines for a target that asks five resolvers needs
                        // saying: each is all of them at once, not any one.
                        ? `Every probe looks the name up twice: its ${recordAsked(4)} record is the IPv4 line and its ${recordAsked(6)} record the IPv6 line. ` +
                          `Each line is ${targetResolvers.length === 1 ? 'the resolver' : `all ${targetResolvers.length} resolvers together`}: ` +
                          `a point is the median of the ${targetResolvers.length * DNS_QUERIES_PER_PROBE} queries one probe sends for that record` +
                          `${comparesResolvers ? `, ${DNS_QUERIES_PER_PROBE} to each resolver. Open a family below to see its resolvers one by one` : ''}. ` +
                          'The strips underneath mark when some of those queries failed.'
                        : `The same target over each address family, on a shared scale. The strips underneath mark when each one had ${vocabulary.lossTitle.toLowerCase()}.`
                    }
                    lossLabel={selectedTarget.probeType === 'dns' ? 'Failed' : undefined}
                    note={
                      selectedTarget.probeType === 'dns'
                        ? 'Failed is the share of queries that got no usable answer. Uptime is the share of probes in which at least one query was answered.'
                        : undefined
                    }
                    nameSeries={(target, family) => (family ? FAMILY_LABEL[family] : target.name)}
                    showAddress={false}
                    reportError={reportError}
                  />
                  {([4, 6] as const).map(family => {
                    const familyLatest = latest[selectedTarget.id]?.byFamily?.[family]
                    // A table and a chart for each family is four boxes in a
                    // row; each family's are kept in one box of its own, which
                    // folds away. Any other probe has one small box a family.
                    if (targetResolvers.length === 0) {
                      return (
                        <ProbeDetailsPanel
                          key={family}
                          probeType={selectedTarget.probeType}
                          latest={familyLatest}
                          label={FAMILY_LABEL[family]}
                        />
                      )
                    }

                    return (
                    <FamilySection key={family} family={family} detail={`${recordAsked(family)} record`} latest={familyLatest}>
                      <ProbeDetailsPanel
                        probeType={selectedTarget.probeType}
                        latest={familyLatest}
                        resolverList={targetResolvers}
                        question={questionAsked(family)}
                      />
                      {comparesResolvers && (
                        <ComparePanel
                          targets={[selectedTarget]}
                          split="resolver"
                          splitFamily={family}
                          timeRange={timeRange}
                          zoom={zoom}
                          onZoom={handleZoom}
                          onResetZoom={handleResetZoom}
                          refreshKey={lastUpdated?.getTime()}
                          title={`Query time by resolver: ${FAMILY_LABEL[family]}, ${recordAsked(family)} record`}
                          description={resolverChart.description}
                          lossLabel="Failed"
                          note={resolverChart.note}
                          nameSeries={(target, _family, resolver) => resolver ?? target.name}
                          showAddress={false}
                          reportError={reportError}
                        />
                      )}
                    </FamilySection>
                    )
                  })}
                </>
              ) : (
              <>
              {/* No fade of its own. The placeholder and the cards are the
                  same boxes, and the figures inside the cards already come up
                  one by one; fading the whole row in from nothing as well
                  blinked the boxes out and back between the two. */}
              {showSpinner ? (
                <ReadoutSkeleton />
              ) : (
                <StatsCards
                  statistics={statistics}
                  current={current}
                  lastUpdated={lastUpdated}
                  vocabulary={vocabulary}
                  paused={selectedTarget.status === 'paused'}
                />
              )}

              <ProbeDetailsPanel
                probeType={selectedTarget.probeType}
                latest={latestReading}
                resolverList={targetResolvers}
                question={questionAsked(shownFamily)}
              />

              {/* Fixed minimum height: the trace and the empty-state message
                  occupy the same space, so swapping between them cannot make
                  the page jump. */}
              <section className="min-h-[26rem] rounded-xl border border-border bg-card p-4 @2xl/main:p-5">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-medium text-foreground">{vocabulary.chartTitle}</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Each band holds more of the {vocabulary.unit} than the one inside it. Dense means
                      they arrived together; a wide haze means the path is unpredictable.
                      {comparesResolvers &&
                        ` This is all ${targetResolvers.length} resolvers' queries together; the chart underneath draws them one by one.`}
                    </p>
                  </div>
                  {zoom ? (
                    // Shown from the moment of the drag, not once the data
                    // lands: it is also the way back out of a period that
                    // turns out to hold no measurements.
                    <p className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
                      <span>
                        {formatWindowEdge(zoom.start)} – {formatWindowEdge(zoom.end)}
                      </span>
                      <Button variant="secondary" size="sm" onClick={handleResetZoom}>
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

                {comparesResolvers && (
                  <ComparePanel
                    targets={[selectedTarget]}
                    split="resolver"
                    splitFamily={shownFamily ?? undefined}
                    timeRange={timeRange}
                    zoom={zoom}
                    onZoom={handleZoom}
                    onResetZoom={handleResetZoom}
                    refreshKey={lastUpdated?.getTime()}
                    title={`Query time by resolver: ${shownFamily ? `${FAMILY_LABEL[shownFamily]}, ` : ''}${recordAsked(shownFamily)} record`}
                    description={resolverChart.description}
                    lossLabel="Failed"
                    note={resolverChart.note}
                    nameSeries={(target, _family, resolver) => resolver ?? target.name}
                    showAddress={false}
                    reportError={reportError}
                  />
                )}
              </>
              )}

                <ErrorBoundary label="Route">
                  <TraceroutePanel
                    key={selectedTarget.id}
                    targetId={selectedTarget.id}
                    refreshKey={lastUpdated?.getTime()}
                    readOnly={readOnly}
                  />
                </ErrorBoundary>

                <TargetAlerts
                  alerts={alerts}
                  targetId={selectedTarget.id}
                  onManage={openAlerts}
                />
            </div>
          </motion.div>
          ) : null}
          </AnimatePresence>
          </MotionConfig>
        )}
      </main>
      </div>
    </div>
  )
}
