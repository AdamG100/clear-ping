'use client'

import { useState, useMemo, useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type {
  AddressFamily,
  FamilyReading,
  ProbeReading,
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
import { DEFAULT_LOCAL_PROBE_NAME, LOCAL_PROBE } from '@/types/probe-agent'
import { probeIdsOf } from '@/lib/targets/probes'
import { probeSummaries } from '../targets/probe-checklist'
import { COMPARE_PROBES, ProbeSwitch } from '../targets/probe-switch'
import { NetworkLine, ProbeChips } from '../targets/monitor-network'
import type { ProbeAgentOutage, ProbeAgentSummary, ProbeId } from '@/types/probe-agent'
import { TIME_RANGE_CONFIG } from '@/types/probe'
import { Sidebar, SIDEBAR_FOLD_MS, SIDEBAR_FOLD_PX } from '../sidebar/sidebar'
import { DeleteProgress } from './delete-progress'
import { MobileTopBar } from './mobile-top-bar'
import { onSidebarFold, useSidebarDrawer } from '../sidebar/use-sidebar-drawer'
import { PANE, PANE_ACTION, PANE_ACTIONS, PANE_HEADER, PANE_TITLE } from './pane-layout'
import StatsCards from '../targets/stats-cards'
import { LossBreakdown } from '../targets/loss-breakdown'
import { SilentServerNote } from '../targets/silent-server'
import { TimeRangeSelector } from '../charts/time-range-selector'
import { SmokeTrace } from '../charts/smoke-trace'
import { PaneSkeleton, ReadoutSkeleton, TraceSkeleton } from './skeleton'
import { buildSeries, MIN_WINDOW_MS } from '@/lib/charts/series'
import { addressFamilyFor, FAMILY_LABEL, isDualStack, targetTypeFor } from '@/lib/probes/host'
import { alertTitle } from '@/lib/alerts/delivery'
import { probeVocabulary } from '@/lib/probes/labels'
import { DNS_QUERIES_PER_PROBE, nameRecordType, targetAddressLabel } from '@/lib/probes/config'
import { groupLabel, isWithinGroup, normalizeGroupPath, rebaseGroupPath } from '@/lib/targets/group-path'
import { buildSidebarLayout, groupsInOrder, targetsWithin, UNGROUPED } from '@/lib/targets/sidebar-layout'
import { useToast } from '@/components/notifications'
import { ErrorBoundary } from '@/components/error-boundary'
import { AlertsView, type AlertResponse } from '../alerts/alerts-view'
import { SettingsPage } from '../settings/settings-page'
import { MaintenanceToast } from '../settings/maintenance-toast'
import { AddTargetPage, EditTargetPage } from '../targets/target-page'
import { SetupAdvice } from './setup-advice'
import { useDashboardPage } from './use-dashboard-page'
import { useSignedIn } from './use-signed-in'
import { DEFAULT_SETTINGS_SECTION, isSettingsSection, pathOf, type DashboardPage } from '@/lib/dashboard-pages'
import { ProbeDetailsPanel } from '../targets/probe-details'
import { agentDown, holdReason, type ProbeFromFilter } from '../targets/probed-from'
import { TraceroutePanel } from '../targets/traceroute-panel'
import { CopyAddress } from './copy-address'
import { ComparePanel } from '../charts/compare-panel'
import { PatchNotesPage } from './patch-notes'
import { OverviewPage } from './overview'
import { PrefixPage } from '../routing/prefix-page'
import { RoutingPage } from '../routing/routing-page'
import { useRoutingStatus } from '../routing/use-bgp'
import { FamilySection } from './family-section'
import { formatWindowEdge } from '../charts/chart-brush'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { inDisplayZone } from '@/lib/time-zone'
import { Masked } from '../privacy/masked'

/** Content that replaces a placeholder fades in over it instead of cutting. */
const FADE_IN = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const

const REFRESH_INTERVAL_MS = 30_000
/** How many targets one delete request carries, and so how often the progress moves. */
const DELETE_BATCH = 5

function useTargets(reportError: (title: string, error?: unknown) => void) {
  const [targets, setTargets] = useState<Target[]>([])
  const [latest, setLatest] = useState<Record<string, LatestMeasurement>>({})
  const [series, setSeries] = useState<Record<string, SparklinePoint[]>>({})
  // Every group there is, as paths: a group is there whether or not a target is in it.
  const [groups, setGroups] = useState<string[]>([])
  const [groupOrders, setGroupOrders] = useState<GroupOrder[]>([])
  // The machines targets can be probed from, besides this one.
  const [probeAgents, setProbeAgents] = useState<ProbeAgentSummary[]>([])
  // What the local probe is called: Settings can rename it.
  const [localProbeName, setLocalProbeName] = useState(DEFAULT_LOCAL_PROBE_NAME)
  const [isLoaded, setIsLoaded] = useState(false)

  const loadTargets = useCallback(async () => {
    try {
      const response = await fetch('/api/targets?packetLoss=true')
      if (response.ok) {
        const data = await response.json()
        setTargets(data.targets || data)
        setProbeAgents(data.probeAgents || [])
        if (typeof data.localProbeName === 'string') setLocalProbeName(data.localProbeName)

        // Timestamps arrive as text, including the ones inside each family's
        // reading of a target probed over both.
        type RawReading = Omit<FamilyReading, 'timestamp'> & { timestamp: string }
        type RawProbeReading = RawReading & { byFamily?: Partial<Record<AddressFamily, RawReading>> }
        const rawLatest: Record<string, RawProbeReading & { byProbe?: Record<string, RawProbeReading> }> =
          data.latest || {}
        const parseReading = (entry: RawReading): FamilyReading => ({ ...entry, timestamp: new Date(entry.timestamp) })
        const parseWithFamilies = ({ byFamily, ...entry }: RawProbeReading): ProbeReading => {
          const reading: ProbeReading = parseReading(entry)
          if (byFamily) {
            reading.byFamily = {}
            for (const family of [4, 6] as const) {
              const one = byFamily[family]
              if (one) reading.byFamily[family] = parseReading(one)
            }
          }
          return reading
        }

        const parsed: Record<string, LatestMeasurement> = {}
        for (const [id, { byProbe, ...entry }] of Object.entries(rawLatest)) {
          parsed[id] = parseWithFamilies(entry)
          if (byProbe) {
            parsed[id].byProbe = Object.fromEntries(Object.entries(byProbe).map(([probe, reading]) => [probe, parseWithFamilies(reading)]))
          }
        }
        setLatest(parsed)
        setSeries(data.series || {})

        setGroups(data.groups || [])
        if (data.groupOrders) {
          setGroupOrders(data.groupOrders)
        }
      } else {
        reportError('Could not load monitors', `Server responded ${response.status}`)
      }
    } catch (error) {
      reportError('Could not load monitors', error)
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
          probes: target.probes?.length ? target.probes.map(probe => probe.id) : [target.probeAgentId ?? LOCAL_PROBE],
        }),
      })
      if (response.ok) {
        const created = await response.json()
        await loadTargets()
        return created as Target
      }
      const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
      reportError('Could not add monitor', error)
    } catch (error) {
      reportError('Could not add monitor', error)
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
      reportError('Could not import the monitors', error)
    } catch (error) {
      reportError('Could not import the monitors', error)
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
        // The API takes the probes as a list of ids.
        body: JSON.stringify({ ...updates, probes: updates.probes?.map(probe => probe.id), probeAgentId: undefined }),
      })
      if (response.ok) {
        await loadTargets()
        return true
      } else {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError('Could not save changes', error)
      }
    } catch (error) {
      reportError('Could not save changes', error)
    }
    return false
  }, [loadTargets, reportError])

  const deleteTargets = useCallback(async (
    ids: string[],
    groups: string[] = [],
    onProgress?: (done: number, total: number) => void
  ): Promise<{ targets: number; groups: number } | null> => {
    // In batches rather than one request: a long list takes the server a while,
    // and a request per batch is what lets the progress be told as it goes.
    // The groups go with the last, once everything in them is gone; on their
    // own when only empty groups were chosen.
    const deleted = { targets: 0, groups: 0 }
    let failed = false
    try {
      for (let start = 0; start < Math.max(ids.length, 1); start += DELETE_BATCH) {
        const last = start + DELETE_BATCH >= ids.length
        const response = await fetch('/api/targets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids.slice(start, start + DELETE_BATCH), groups: last ? groups : [] }),
        })
        if (!response.ok) {
          const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
          reportError('Could not delete the monitors', error)
          failed = true
          break
        }
        const result = await response.json()
        deleted.targets += result.deleted
        deleted.groups += result.groupsRemoved
        // The list follows along, so the targets and the groups they leave
        // empty drop out of the sidebar as they go.
        await loadTargets()
        onProgress?.(Math.min(start + DELETE_BATCH, ids.length), ids.length)
      }
    } catch (error) {
      reportError('Could not delete the monitors', error)
      failed = true
    }
    // Whatever was deleted before a failure is gone, so the list is shown as it is.
    await loadTargets()
    return failed ? null : deleted
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
      reportError('Could not save monitor order', error)
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

  /** Measure every target in a group, including the groups inside it, from the same probes. */
  const setGroupProbe = useCallback(async (group: string, probes: ProbeId[]): Promise<boolean> => {
    try {
      const response = await fetch('/api/groups/probe', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group, probes }),
      })
      if (response.ok) {
        await loadTargets()
        return true
      }
      const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
      reportError('Could not change which probes measure the group', error)
    } catch (error) {
      reportError('Could not change which probes measure the group', error)
    }
    return false
  }, [loadTargets, reportError])

  return { targets, latest, series, groups, groupOrders, probeAgents, localProbeName, createGroup, deleteGroup, setGroupProbe, addTarget, importTargets, updateTarget, deleteTargets, reorderGroups, reorderTargets, moveGroup, isLoaded, reloadTargets: loadTargets }
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
  /** The whole period the points were read for: the chart spans it, readings or not. */
  span: TimeWindow | null
  /** When the target's probe agent could not be reached: gaps that are the agent's, not the target's. */
  outages: ProbeAgentOutage[]
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
  family: AddressFamily | null,
  /** One probe of a monitor measured from several. */
  probe?: string
) {
  // The snapshot carries the target it belongs to. Keeping stale data across a
  // *range* change is the point of this hook, but keeping it across a *target*
  // change would show one host's history under another host's name.
  const [snapshot, setSnapshot] = useState<(RangeSnapshot & { owner: string }) | null>(null)
  const [pending, setPending] = useState(false)

  // Keyed by target *and* range, so flicking between two targets is instant
  // rather than re-fetching each time. Clearing the cache whenever the target
  // changed meant every switch paid a full round trip and showed a spinner.
  // Held in state, not a ref, so that what has been seen can be read while
  // rendering: a view that has been seen before is shown in the same render
  // that switches to it, with no frame of placeholder in between.
  const [cache] = useState(() => new Map<string, RangeSnapshot>())
  // A family is its own series, so it owns its snapshot the way a target does:
  // IPv4's history must not sit under the IPv6 tab while IPv6 loads.
  const owner = targetId ? `${targetId}:${family ?? 'all'}:${probe ?? ''}` : null
  const cacheKey = `${owner}:${timeRange}:${zoom ? `${zoom.start}-${zoom.end}` : 'all'}`

  // What is on screen: what was last loaded for this target and family, or
  // failing that, what has been loaded before for exactly this view.
  const cachedView = owner && !(snapshot !== null && snapshot.owner === owner) ? cache.get(cacheKey) : undefined
  const shown = snapshot !== null && snapshot.owner === owner ? snapshot : cachedView ? { ...cachedView, owner: owner as string } : null
  const isForCurrentTarget = shown !== null

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
    const cached = cache.get(cacheKey)

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
      const query = `${period}${family ? `&family=${family}` : ''}${probe ? `&probe=${encodeURIComponent(probe)}` : ''}`
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
        span: typeof result.start === 'number' && typeof result.end === 'number' ? { start: result.start, end: result.end } : null,
        outages: Array.isArray(result.probeAgentOutages) ? result.probeAgentOutages : [],
      }

      // Bounded: oldest entries drop out so a long session cannot grow the
      // cache without limit.
      if (cache.size >= 40) {
        cache.delete(cache.keys().next().value!)
      }
      cache.set(cacheKey, next)
      if (requestId === requestIdRef.current) setSnapshot({ ...next, owner })
    } catch (error) {
      reportError('Could not load measurements', error)
    } finally {
      if (requestId === requestIdRef.current) setPending(false)
    }
  }, [targetId, owner, family, probe, timeRange, zoom, cache, cacheKey, probeIntervalSeconds, reportError])

  const loadMeasurementsRef = useRef(loadMeasurements)
  useEffect(() => {
    loadMeasurementsRef.current = loadMeasurements
  }, [loadMeasurements])

  useEffect(() => {
    loadMeasurementsRef.current()
  }, [targetId, family, probe, timeRange, zoom, probeIntervalSeconds])

  return {
    points: shown ? shown.points : [],
    statistics: shown ? shown.statistics : null,
    /** The zoom window the points on screen belong to; null when unzoomed. */
    window: shown ? shown.window : null,
    span: shown ? shown.span : null,
    outages: shown ? shown.outages : [],
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
/** Whether the probes are several, so that saying which see an alert says something. */
const monitorProbeCount = (_alert: AlertResponse, names: ReadonlyMap<string, string>) => names.size

function TargetAlerts({
  alerts,
  targetId,
  probeNames,
  onManage,
}: {
  alerts: AlertResponse[]
  targetId: string
  /** What each probe is called, to say which see it. */
  probeNames: ReadonlyMap<string, string>
  onManage: () => void
}) {
  const watching = alerts.filter(alert => alert.targets.some(entry => entry.targetId === targetId))

  return (
    <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-3xl border border-border bg-card px-4 py-4 @2xl/main:px-6">
      <h2 className="text-sm font-medium text-foreground">Alerts</h2>
      {watching.length === 0 ? (
        <p className="text-xs text-muted-foreground">No alert is watching this monitor.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {watching.map(alert => {
            const entry = alert.targets.find(each => each.targetId === targetId)
            const firing = alert.enabled && entry?.state === 'firing'
            // With more than one probe, which of them see it.
            const seenBy = firing && (entry?.breachingProbes?.length ?? 0) > 0 && monitorProbeCount(alert, probeNames) > 1
              ? ` from ${entry!.breachingProbes!.map(probe => probeNames.get(probe) ?? probe).join(', ')}`
              : ''
            return (
              <li key={alert.id}>
                <Badge tone={firing ? 'danger' : alert.enabled ? 'success' : 'neutral'}>
                  {alertTitle(alert)}
                  {firing ? `: firing${seenBy}` : !alert.enabled ? ': muted' : ''}
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

const noSubscription = () => () => {}

/**
 * A value kept in the tab's storage, or null on the server and while the
 * page hydrates. Storage says nothing when it changes, so this is read again
 * whenever the dashboard renders; what it is used for is chosen in state.
 */
function useRemembered(key: string): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => sessionStorage.getItem(key),
    () => null
  )
}

export function Dashboard() {
  const { notify, reportError } = useToast()
  const { targets, latest, series, groups, groupOrders, probeAgents, localProbeName, createGroup, deleteGroup, setGroupProbe, addTarget, importTargets, updateTarget, deleteTargets, reorderGroups, reorderTargets, moveGroup, isLoaded, reloadTargets } = useTargets(reportError)
  // The sidebar's "probed from" filter: every target, this server's, or one probe agent's.
  const [probeFrom, setProbeFrom] = useState<ProbeFromFilter>('all')
  const { alerts, loaded: alertsLoaded, reload: reloadAlerts } = useAlerts(reportError)
  // A delete under way, which carries on in the background, and the targets
  // in it, greyed in the list until they are gone.
  const [deleteJob, setDeleteJob] = useState<{ title: string; ids: Set<string>; done: number; total: number } | null>(null)
  // A page (alerts, settings) takes the place of a target or a group in the
  // main pane. Which one is part of the address.
  const { page, goTo } = useDashboardPage()
  // The list of alerts, or the form for one in its place.
  const showingAlerts = page?.kind === 'alerts' || page?.kind === 'alert-new' || page?.kind === 'alert-edit'
  const alertEditor = page?.kind === 'alert-new' ? 'new' : page?.kind === 'alert-edit' ? page.id : null
  const targetPage = page?.kind === 'target-new' || page?.kind === 'target-edit' ? page : null
  // A viewer is shown everything and offered nothing to change.
  const signedIn = useSignedIn()
  const readOnly = signedIn?.role === 'viewer'
  // BGP monitoring, a tool of its own: its list, or one prefix in full.
  const routingPrefix = page?.kind === 'routing-prefix' ? page.id : null
  const showingRouting = page?.kind === 'routing' || routingPrefix !== null
  const routing = useRoutingStatus()
  // On a narrow screen the sidebar is a drawer over the page. Choosing
  // anything in it is the reason it was opened, so every choice closes it.
  // On a wide one it sits beside the page and can be collapsed to a rail of icons.
  const {
    open: sidebarOpen,
    show: showSidebar,
    hide: hideSidebar,
    collapse: collapseSidebar,
    expand: expandSidebar,
  } = useSidebarDrawer()
  // While the sidebar folds or unfolds, the page beside it is held at the
  // width it is going to have and slides with the sidebar's edge. Left to
  // follow the edge, it was laid out afresh on every frame, every chart on it
  // redrawn at each new width, and the fold stuttered.
  // Done as the fold is asked for, before anything is drawn, and without
  // redrawing the page.
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = onSidebarFold(collapsed => {
      const pane = paneRef.current
      if (!pane) return
      clearTimeout(timer)
      pane.style.width = ''
      if (!window.matchMedia('(min-width: 64rem)').matches) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const now = pane.getBoundingClientRect().width
      pane.style.width = `${now + (collapsed ? 1 : -1) * SIDEBAR_FOLD_PX}px`
      timer = setTimeout(() => {
        pane.style.width = ''
      }, SIDEBAR_FOLD_MS)
    })
    return () => {
      stop()
      clearTimeout(timer)
    }
  }, [])
  const [timeRange, setTimeRange] = useState<TimeRange>('1h')
  // A period picked out by dragging across the chart. It narrows the range
  // rather than replacing it, and is dropped whenever the range or the target
  // changes: a window chosen on one trace means nothing on another.
  const [zoom, setZoom] = useState<TimeWindow | null>(null)
  const [probing, setProbing] = useState(false)
  // For a target probed over both address families: which is on screen.
  const [familyView, setFamilyView] = useState<FamilyView>('both')
  // Which of a monitor's probes is on screen, kept for the monitor it was chosen on.
  const [probeChoice, setProbeChoice] = useState<{ targetId: string | null; view: string }>({ targetId: null, view: '' })

  // Remembered for the tab, not for good: a reload stays on what was being
  // looked at, and opening ClearPing afresh starts at the overview.
  //
  // What is remembered stands until something is chosen (undefined until
  // then). It is read through useSyncExternalStore, not in a state
  // initialiser: the server has no storage and renders nothing remembered,
  // and the first render in the browser has to match it, or hydration fails.
  // The remembered one is put on screen straight after.
  const rememberedTargetId = useRemembered('selectedTargetId')
  const rememberedGroup = useRemembered('selectedGroup')
  const [chosenTargetId, setSelectedTargetIdState] = useState<string | null | undefined>(undefined)
  const selectedTargetId = chosenTargetId === undefined ? rememberedTargetId : chosenTargetId

  // A group can be on screen instead of a target: every target in it on one
  // chart. The target selection is kept underneath, so leaving the group view
  // (or the group disappearing) lands back on something.
  const [chosenGroup, setSelectedGroupState] = useState<string | null | undefined>(undefined)
  const selectedGroup = chosenGroup === undefined ? rememberedGroup : chosenGroup

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
    sessionStorage.removeItem('selectedGroup')
    if (id) sessionStorage.setItem('selectedTargetId', id)
    else sessionStorage.removeItem('selectedTargetId')
  }, [hideSidebar, goTo])

  const selectGroup = useCallback((groupName: string) => {
    setSelectedGroupState(groupName)
    goTo(null)
    setZoom(null)
    hideSidebar()
    if (typeof window !== 'undefined') sessionStorage.setItem('selectedGroup', groupName)
  }, [hideSidebar, goTo])

  const openPage = useCallback((next: DashboardPage) => {
    goTo(next)
    hideSidebar()
  }, [goTo, hideSidebar])
  const openOverview = useCallback(() => openPage({ kind: 'overview' }), [openPage])
  const openAlerts = useCallback(() => openPage({ kind: 'alerts' }), [openPage])
  const openRouting = useCallback(() => openPage({ kind: 'routing' }), [openPage])
  const openRoutingSettings = useCallback(() => openPage({ kind: 'settings', section: 'routing' }), [openPage])
  const openProbeAgentSettings = useCallback(() => openPage({ kind: 'settings', section: 'probes' }), [openPage])
  // Routing is turned on in Settings, which is an admin's. Before anyone has
  // signed in (no accounts yet), Settings is where an account is made first.
  const canTurnOnRouting = !signedIn || signedIn.role === 'admin'
  const openRoutingPrefix = useCallback((id: string) => goTo({ kind: 'routing-prefix', id }), [goTo])
  const openPatchNotes = useCallback(() => openPage({ kind: 'patch-notes' }), [openPage])
  const openAlertEditor = useCallback(
    (which: 'new' | string) => goTo(which === 'new' ? { kind: 'alert-new' } : { kind: 'alert-edit', id: which }),
    [goTo]
  )
  const closeAlertEditor = useCallback(() => goTo({ kind: 'alerts' }), [goTo])

  // Adding and editing a target are pages of their own (see target-page.tsx).
  const savedLayout = useMemo(() => buildSidebarLayout(targets, groupOrders, groups), [targets, groupOrders, groups])
  // Every group a target could be put in, including ones that hold only other
  // groups, in the order the sidebar lists them.
  const availableGroups = useMemo(() => groupsInOrder(savedLayout).filter(group => group !== UNGROUPED), [savedLayout])
  const openAddTarget = useCallback(
    (options?: { group?: string; from?: string }) => openPage({ kind: 'target-new', group: options?.group, from: options?.from }),
    [openPage]
  )
  const openEditTarget = useCallback((id: string) => openPage({ kind: 'target-edit', id }), [openPage])
  const closeTargetPage = useCallback(() => goTo(null), [goTo])

  // A copy goes directly under what it was copied from, as long as it was left
  // in the same group: at the far end of a long group it would look as though
  // nothing had happened. Whatever was added is then the target on screen.
  const handleAddTarget = useCallback(
    async (source: Target | null, copy: Parameters<typeof addTarget>[0]) => {
      const created = await addTarget(copy)
      if (!created) return

      if (source && normalizeGroupPath(created.group) === normalizeGroupPath(source.group)) {
        const group = normalizeGroupPath(source.group)
        const siblings = (savedLayout.items[group || UNGROUPED] ?? []).filter(id => id !== created.id)
        const position = siblings.indexOf(source.id)
        if (position !== -1) {
          const ordered = [...siblings.slice(0, position + 1), created.id, ...siblings.slice(position + 1)]
          void reorderTargets(ordered.map((id, sortOrder) => ({ id, sortOrder })))
        }
      }
      setSelectedTargetId(created.id)
    },
    [addTarget, savedLayout, reorderTargets, setSelectedTargetId]
  )

  const handleSaveTarget = useCallback(
    async (id: string, updates: Partial<Target>) => {
      if (await updateTarget(id, updates)) goTo(null)
    },
    [updateTarget, goTo]
  )
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
      if (typeof window !== 'undefined') sessionStorage.setItem('selectedGroup', moved)
    }
  }, [moveGroup, selectedGroup])

  // Let go of a remembered target that has since been deleted, once the list
  // has arrived to say so. Nothing selected is the overview.
  if (isLoaded && selectedTargetId && !targets.some(t => t.id === selectedTargetId)) {
    setSelectedTargetIdState(null)
  }

  const selectedTarget = useMemo(() => {
    return targets.find(t => t.id === selectedTargetId) || null
  }, [targets, selectedTargetId])
  // The probes it is measured from: with more than one, the page shows one at a
  // time (the first, until another is chosen) or all of them against each other.
  const monitorProbeIds = useMemo(() => (selectedTarget ? probeIdsOf(selectedTarget) : []), [selectedTarget])
  const multiProbe = monitorProbeIds.length > 1
  const probeList = useMemo(() => probeSummaries(probeAgents, localProbeName), [probeAgents, localProbeName])
  const chosenView = probeChoice.targetId === selectedTargetId ? probeChoice.view : ''
  const comparingProbes = multiProbe && chosenView === COMPARE_PROBES
  const shownProbe = multiProbe && !comparingProbes && monitorProbeIds.includes(chosenView) ? chosenView : monitorProbeIds[0] ?? LOCAL_PROBE
  const probeNameOf = (id: string) => probeList.find(probe => probe.id === id)?.name ?? 'A removed probe agent'
  // Where the readings on screen come from, when that is not the local probe.
  const selectedAgent = shownProbe !== LOCAL_PROBE ? probeAgents.find(agent => agent.id === shownProbe) : undefined
  const selectedOnHold = selectedAgent ? agentDown(selectedAgent) : undefined

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
  const singleSeriesTargetId = groupTargets || comparingFamilies || comparingProbes ? null : selectedTargetId

  const { points, statistics, window: shownWindow, span: shownSpan, outages: agentOutages, pending, reload, initialLoad } =
    useTargetMeasurements(singleSeriesTargetId, timeRange, selectedTarget?.interval ?? 300, reportError, zoom, shownFamily, multiProbe ? shownProbe : undefined)

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
      // Nobody is looking at a hidden tab; it catches up when it is shown again.
      if (document.hidden) return
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
      const asked = comparingProbes ? '?probes=all' : multiProbe ? `?probe=${encodeURIComponent(shownProbe)}` : ''
      const response = await fetch(`/api/targets/${selectedTargetId}/probe${asked}`, { method: 'POST' })
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError('Reading failed', error)
        return
      }

      const { result } = await response.json()
      notify({
        tone: result?.success ? 'success' : 'error',
        title: result?.success ? 'Reading taken' : 'Reading failed',
        detail: result?.success
          ? vocabulary.summarize(result.latency, result.packetLoss ?? 0)
          : result?.errorMessage,
      })
      // The probe runs to completion server-side before responding, so the new
      // measurement is already stored by the time we reload.
      await Promise.all([reload(), reloadTargets()])
    } catch (error) {
      reportError('Reading failed', error)
    } finally {
      setProbing(false)
    }
  }, [selectedTargetId, probing, comparingProbes, multiProbe, shownProbe, reload, reloadTargets, notify, reportError, vocabulary])

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
          title: `Imported ${definitions.length} monitor${definitions.length === 1 ? '' : 's'}`,
          detail: 'Their first readings will be in shortly.',
        })
      }
      return added
    },
    [importTargets, notify]
  )

  const handleDeleteTargets = useCallback(
    async (ids: string[], groups: string[] = []) => {
      // One at a time: a second would be competing with the first for the
      // database, and the progress shown is the one's.
      if (deleteJob) {
        reportError('Monitors are already being deleted', 'Wait for that to finish first.')
        return false
      }

      // Runs on in the background; the caller is told it has started.
      const single = ids.length === 1 && groups.length === 0 ? targets.find(target => target.id === ids[0]) : undefined
      const title = single
        ? `Deleting ${single.name}`
        : ids.length > 0 ? `Deleting ${ids.length} monitor${ids.length === 1 ? '' : 's'}` : 'Deleting groups'
      const job = { title, ids: new Set(ids) }
      setDeleteJob({ ...job, done: 0, total: ids.length })
      void deleteTargets(ids, groups, (done, total) => setDeleteJob({ ...job, done, total })).then(deleted => {
        setDeleteJob(null)
        // A failure was reported where it happened.
        if (deleted === null) return
        const removed = [
          single && deleted.targets === 1 ? single.name : '',
          !single && deleted.targets > 0 ? `${deleted.targets} target${deleted.targets === 1 ? '' : 's'}` : '',
          deleted.groups > 0 ? `${deleted.groups} group${deleted.groups === 1 ? '' : 's'}` : '',
        ].filter(Boolean)
        notify({
          tone: 'info',
          title: removed.length > 0 ? `Deleted ${removed.join(' and ')}` : 'Nothing left to delete',
          detail: deleted.targets > 0
            ? `${deleted.targets === 1 ? 'Its' : 'Their'} history, alert rules and saved routes went with ${deleted.targets === 1 ? 'it' : 'them'}, and so did any group left empty.`
            : undefined,
        })
      })
      return true
    },
    [deleteJob, deleteTargets, notify, reportError, targets]
  )

  const handleDeleteTarget = useCallback(
    (id: string) => void handleDeleteTargets([id]),
    [handleDeleteTargets]
  )

  const current = useMemo(() => currentReadings(points), [points])

  // The newest reading of what is on screen: the target's, or one family's.
  const latestReading = useMemo(() => {
    const overall = selectedTargetId ? latest[selectedTargetId] : undefined
    const reading = multiProbe ? overall?.byProbe?.[shownProbe] ?? overall : overall
    return shownFamily ? reading?.byFamily?.[shownFamily] : reading
  }, [selectedTargetId, latest, shownFamily, multiProbe, shownProbe])

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

  const deletingIds = deleteJob?.ids
  const transformedTargets = useMemo(() => {
    const agentsById = new Map(probeAgents.map(agent => [agent.id, agent]))
    const names = new Map(probeSummaries(probeAgents, localProbeName).map(probe => [probe.id, probe.name]))
    return targets.map(t => {
      const lastMeasurement = latest[t.id]
      const probeAgent = t.probeAgentId ? agentsById.get(t.probeAgentId) : undefined
      const ids = probeIdsOf(t)
      // With several probes the monitor is on hold only when none of them can
      // take a reading; one that cannot is named in the note instead.
      const down = ids.filter(id => id !== LOCAL_PROBE && !!agentsById.get(id) && agentDown(agentsById.get(id)!))
      const onHold = ids.length > 1
        ? (down.length === ids.length ? 'No readings: none of its probes can take one' : undefined)
        : probeAgent ? holdReason(probeAgent) : undefined
      const byProbe = ids.length > 1 ? lastMeasurement?.byProbe : undefined
      const probeNote = ids.length > 1
        ? [
            ...ids.filter(id => down.includes(id)).map(id => `${names.get(id) ?? id} is offline`),
            ...ids.filter(id => !down.includes(id) && byProbe?.[id] && !byProbe[id].success).map(id => `No reply from ${names.get(id) ?? id}`),
          ].join('; ')
        : ''
      return {
        ...t,
        probeAgent,
        onHold,
        address: t.host,
        type: targetTypeFor(t.host, t.probeType),
        // Reachability comes from the last measurement. `status` only records
        // whether the user paused the target, so deriving online/offline from
        // it marked every target — including dead ones — as online.
        isOnline: lastMeasurement ? lastMeasurement.success : undefined,
        statusNote: probeNote
          ? probeNote
          : lastMeasurement?.byFamily
          ? ([4, 6] as const)
              .filter(family => lastMeasurement.byFamily?.[family])
              .map(family => `${FAMILY_LABEL[family]} ${lastMeasurement.byFamily![family]!.success ? 'answering' : 'not answering'}`)
              .join(', ')
          : undefined,
        lastCheck: lastMeasurement?.timestamp,
        avgLatency: lastMeasurement?.latency ?? undefined,
        packetLoss: lastMeasurement?.packetLoss,
        isNew: !lastMeasurement,
        deleting: deletingIds?.has(t.id),
      }
    })
  }, [targets, latest, probeAgents, localProbeName, deletingIds])

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

  // With nothing chosen to look at, on a fresh visit or once what was chosen
  // has gone, the dashboard is the overview. Before the list arrives only the
  // remembered choice can be gone by.
  const nothingChosen = !page && (isLoaded ? !selectedTarget && !groupTargets : !selectedTargetId && !selectedGroup)
  const showingOverview = page?.kind === 'overview' || nothingChosen
  // And its address says so, once the list is in. Not sooner: on the first
  // render Next.js has yet to take charge of the history, and an address
  // changed then is one it never hears of.
  const settledOnOverview = isLoaded && nothingChosen
  useEffect(() => {
    if (settledOnOverview) goTo({ kind: 'overview' }, 'replace')
  }, [settledOnOverview, goTo])

  // Moves on whenever anything is probed again, for the overview to catch up.
  const latestRefreshKey = useMemo(
    () => Math.max(0, ...Object.values(latest).map(reading => reading.timestamp.getTime())),
    [latest]
  )
  const showTargetsFrom = useCallback(
    (from: string) => {
      // The list of those targets is the sidebar's, which may be folded away
      // or, on a phone, a drawer to be opened.
      setProbeFrom(from)
      expandSidebar()
      showSidebar()
    },
    [expandSidebar, showSidebar]
  )
  // Only the very first load for a target blanks the pane. Switching ranges
  // keeps the previous range on screen and dims it, so the layout never
  // collapses and reflows underneath the pointer.
  const showSpinner = !!selectedTarget && initialLoad
  const hasMeasurements = !!statistics && statistics.sampleCount > 0

  return (
    // `dvh`, not `vh`: on a phone `vh` is the height with the browser's bars
    // tucked away, so the bottom of the page sat underneath them.
    <div className="flex h-dvh bg-background">
      {deleteJob && <DeleteProgress title={deleteJob.title} done={deleteJob.done} total={deleteJob.total} />}
      <MaintenanceToast />
      <Sidebar
        open={sidebarOpen}
        onClose={hideSidebar}
        onCollapse={collapseSidebar}
        onExpand={expandSidebar}
        targets={transformedTargets}
        selectedTargetId={groupTargets || page ? null : selectedTargetId}
        onSelectTarget={setSelectedTargetId}
        selectedGroup={groupTargets && !page ? selectedGroup : null}
        onSelectGroup={selectGroup}
        onMoveGroup={handleMoveGroup}
        overviewOpen={showingOverview}
        onOpenOverview={openOverview}
        routingOpen={showingRouting}
        onOpenRouting={openRouting}
        routingTrouble={routing.trouble}
        routingEnabled={routing.enabled !== false}
        onTurnOnRouting={canTurnOnRouting ? openRoutingSettings : undefined}
        alertsOpen={showingAlerts}
        onOpenAlerts={openAlerts}
        settingsOpen={page?.kind === 'settings'}
        onOpenSettings={openSettings}
        onOpenPatchNotes={openPatchNotes}
        readOnly={readOnly}
        firingAlerts={firingAlerts}
        onOpenAddTarget={openAddTarget}
        onOpenEditTarget={openEditTarget}
        onImportTargets={handleImportTargets}
        onDeleteTargets={handleDeleteTargets}
        onDeleteTarget={handleDeleteTarget}
        onTogglePaused={handleTogglePaused}
        series={series}
        groups={groups}
        groupOrders={groupOrders}
        onReorderGroups={reorderGroups}
        onCreateGroup={createGroup}
        onDeleteGroup={deleteGroup}
        onReorderTargets={reorderTargets}
        loading={!isLoaded}
        probeFrom={probeFrom}
        onProbeFromChange={setProbeFrom}
        probeAgents={probeAgents}
        localProbeName={localProbeName}
        onSetGroupProbe={readOnly ? undefined : setGroupProbe}
      />

      {/* Behind an open drawer the page cannot be used, by pointer or by
          keyboard, until the drawer is closed. */}
      <div className="flex min-w-0 flex-1 flex-col" inert={sidebarOpen}>
      <MobileTopBar
        sidebarOpen={sidebarOpen}
        onOpenSidebar={showSidebar}
        overviewOpen={showingOverview}
        onOpenOverview={openOverview}
        alertsOpen={showingAlerts}
        onOpenAlerts={openAlerts}
        firingAlerts={firingAlerts}
      />

      {/* The gutter is kept whether or not the page is long enough to scroll.
          Otherwise the scrollbar arriving with the last panels narrows the
          pane, and everything in it, charts included, shifts sideways.
          The pane is a container: what is inside is laid out from the pane's
          own width, not the screen's (see pane-layout.ts). */}
      <main className="flex-1 overflow-x-hidden overflow-y-auto scrollbar-gutter-stable pb-(--safe-bottom) pr-(--safe-right) max-lg:pl-(--safe-left) lg:pt-(--safe-top)">
        <div ref={paneRef} className="@container/main">
        <SetupAdvice pageKey={pathOf(page)} onSetupSso={() => openSettings('sso')} />
        {(showLoadingState || showEmptyState) && !showingOverview ? (
          <PaneSkeleton />
        ) : (
          // Switching target fades the old pane out before the new one comes
          // in. The outgoing pane is kept exactly as it last rendered, so its
          // name and its data leave together, and by the time the incoming
          // one appears its measurements have usually arrived — a switch goes
          // from one finished page to another instead of flashing a skeleton
          // in between.
          <MotionConfig reducedMotion="user">
          <AnimatePresence mode="wait" initial={false}>
          {showingOverview ? (
          <motion.div
            key="overview"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <ErrorBoundary label="Overview">
              <OverviewPage
                onOpenProbeSettings={readOnly ? undefined : openProbeAgentSettings}
                targets={transformedTargets}
                latest={latest}
                probeAgents={probeAgents}
                localProbeName={localProbeName}
                alerts={alerts}
                groups={groups}
                groupOrders={groupOrders}
                loaded={isLoaded}
                refreshKey={latestRefreshKey}
                readOnly={readOnly}
                onSelectTarget={setSelectedTargetId}
                onSelectGroup={selectGroup}
                onShowTargetsFrom={showTargetsFrom}
                onAddTarget={() => openAddTarget()}
                onOpenRouting={openRouting}
                onOpenRoutingPrefix={openRoutingPrefix}
                reportError={reportError}
              />
            </ErrorBoundary>
          </motion.div>
          ) : showingAlerts ? (
          <motion.div
            // The list and each form are pages of their own, and change over
            // as the other pages do.
            key={pathOf(page)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <ErrorBoundary label="Alerts">
              <AlertsView
                probes={probeList}
                alerts={alerts}
                loaded={alertsLoaded}
                targets={transformedTargets}
                groupOrders={groupOrders}
                onChanged={reloadAlerts}
                onSelectTarget={setSelectedTargetId}
                readOnly={readOnly}
                editor={alertEditor}
                onOpenEditor={openAlertEditor}
                onCloseEditor={closeAlertEditor}
              />
            </ErrorBoundary>
          </motion.div>
          ) : showingRouting ? (
          <motion.div
            key={pathOf(page)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <ErrorBoundary label="Routing">
              {routingPrefix ? (
                <PrefixPage
                  id={routingPrefix}
                  readOnly={readOnly}
                  targets={transformedTargets}
                  onBack={openRouting}
                  onSelectTarget={setSelectedTargetId}
                  onAddProbeAgent={canTurnOnRouting ? openProbeAgentSettings : undefined}
                  reportError={reportError}
                />
              ) : (
                <RoutingPage
                  readOnly={readOnly}
                  targets={transformedTargets}
                  groupOrders={groupOrders}
                  onOpenPrefix={openRoutingPrefix}
                  onTurnOn={canTurnOnRouting ? openRoutingSettings : undefined}
                  reportError={reportError}
                />
              )}
            </ErrorBoundary>
          </motion.div>
          ) : page?.kind === 'patch-notes' ? (
          <motion.div
            key="patch-notes"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <ErrorBoundary label="Patch notes">
              <PatchNotesPage />
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
              <SettingsPage
                section={page.section}
                onOpenRouting={openRouting}
                onProbesChanged={() => void reloadTargets()}
                onSection={section => goTo({ kind: 'settings', section }, 'replace')}
                onShowTargetsFrom={agentId => {
                  // The list of that agent's targets is in the sidebar, which
                  // on a phone is a drawer to be opened.
                  setProbeFrom(agentId)
                  goTo(null)
                  showSidebar()
                }}
              />
            </ErrorBoundary>
          </motion.div>
          ) : targetPage ? (
          <motion.div
            key={`target-form:${pathOf(targetPage)}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <ErrorBoundary label="Monitors">
              {readOnly ? (
                <div className="flex h-full items-center justify-center p-6">
                  <EmptyState title="This account can look but not change" description="Ask an admin or editor to add or change monitors." />
                </div>
              ) : !isLoaded ? (
                <PaneSkeleton />
              ) : targetPage.kind === 'target-new' ? (
                <AddTargetPage
                  availableGroups={availableGroups}
                  probeAgents={probeAgents}
                  localProbeName={localProbeName}
                  group={targetPage.group ?? ''}
                  template={targetPage.from ? targets.find(target => target.id === targetPage.from) ?? null : null}
                  onAddTarget={copy =>
                    handleAddTarget(targetPage.from ? targets.find(target => target.id === targetPage.from) ?? null : null, copy)
                  }
                  onClose={closeTargetPage}
                />
              ) : (
                <EditTargetPage
                  target={targets.find(target => target.id === targetPage.id) ?? null}
                  availableGroups={availableGroups}
                  probeAgents={probeAgents}
                  localProbeName={localProbeName}
                  onSave={handleSaveTarget}
                  onClose={closeTargetPage}
                />
              )}
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
                    {groupTargets.length} monitor{groupTargets.length === 1 ? '' : 's'} on one chart
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
              // A line measured from a probe agent says so: from there, the
              // same host can look quite different.
              nameSeries={(target, family) => {
                const from = target.probeAgentId ? probeAgents.find(agent => agent.id === target.probeAgentId)?.name : undefined
                return [target.name, family ? FAMILY_LABEL[family] : null, from].filter(Boolean).join(' · ')
              }}
              title={`${groupVocabulary?.latencyTitle ?? 'Median latency'}, compared`}
              description={
                'One line per monitor, on a shared scale. The strips underneath mark when each one ' +
                (groupVocabulary ? `had ${groupVocabulary.lossTitle.toLowerCase()}.` : 'lost packets or failed.')
              }
              onSelectTarget={setSelectedTargetId}
              probeAgents={probeAgents}
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
                  <Masked text value={selectedTarget.name} />
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  {/* Each with a way to copy it. The domain or IP alone, not
                      the URL or port the label may wrap it in. */}
                  <span className="flex min-w-0 items-center gap-0.5">
                    <span className="break-all font-mono text-muted-foreground"><Masked text value={targetAddressLabel(selectedTarget)} /></span>
                    <CopyAddress value={selectedTarget.host} />
                  </span>
                  {/* Where a domain pointed on its last probe: the address the
                      readings below were actually taken against. */}
                  {selectedTarget.resolvedAddress && (
                    <span className="flex min-w-0 items-center gap-0.5">
                      <span className="break-all font-mono text-muted-foreground/70">
                        <span aria-hidden="true">→ </span>
                        <span className="sr-only">resolves to </span>
                        <Masked value={selectedTarget.resolvedAddress} />
                      </span>
                      <CopyAddress value={selectedTarget.resolvedAddress} />
                    </span>
                  )}
                  <Badge size="sm">{methodLabel}</Badge>
                  {(addressFamily || dualStack) && <Badge size="sm">{dualStack ? 'IPv4 + IPv6' : `IPv${addressFamily}`}</Badge>}
                  {selectedTarget.status === 'paused' && <Badge size="sm" tone="warning">Paused</Badge>}
                </p>
                {/* Who runs the address the readings on screen were taken against. */}
                <div className="mt-1.5">
                  <NetworkLine
                    targetId={selectedTarget.id}
                    probe={multiProbe ? shownProbe : undefined}
                    family={shownFamily}
                    refreshKey={selectedTarget.resolvedAddress ?? ''}
                  />
                </div>
                {/* Said only once there is somewhere else it could be from. */}
                {probeAgents.length > 0 && (
                  <ProbeChips
                    className="mt-1.5"
                    probes={monitorProbeIds.map(id => probeList.find(probe => probe.id === id) ?? { id, name: probeNameOf(id), local: false, state: 'offline' as const })}
                  />
                )}
              </div>
              <div className={PANE_ACTIONS}>
                <TimeRangeSelector value={timeRange} onChange={handleTimeRangeChange} busy={pending} />
                {!readOnly && (
                  <span className={PANE_ACTION}>
                    <Button variant="secondary" size="sm" className="w-full" onClick={handleProbe} loading={probing}>
                      Measure now
                    </Button>
                  </span>
                )}
              </div>
            </header>

            {selectedOnHold && selectedTarget.status !== 'paused' && (
              <Alert tone="warning" title="No readings are being taken">
                It is measured by {selectedAgent?.name}, and {selectedOnHold}. The gap this leaves in the chart is the
                probe agent&apos;s, not {selectedTarget.name}&apos;s. Readings start again when it is back.
              </Alert>
            )}

            {multiProbe && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ProbeSwitch
                  probes={monitorProbeIds.map(id => probeList.find(probe => probe.id === id) ?? { id, name: probeNameOf(id), local: false, state: 'offline' as const })}
                  value={comparingProbes ? COMPARE_PROBES : shownProbe}
                  onChange={view => { setProbeChoice({ targetId: selectedTargetId, view }); setZoom(null) }}
                />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={comparingProbes ? COMPARE_PROBES : shownProbe}
                    className="text-xs text-muted-foreground"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: 0.18 } }}
                    exit={{ opacity: 0, transition: { duration: 0.08 } }}
                  >
                    {comparingProbes
                      ? 'Measured from every probe at once. Pick one for its full readings.'
                      : `Readings taken from ${probeNameOf(shownProbe)} only.`}
                  </motion.p>
                </AnimatePresence>
              </div>
            )}

            {dualStack && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <FamilySwitch value={familyView} onChange={view => { setFamilyView(view); setZoom(null) }} />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={familyView}
                    className="text-xs text-muted-foreground"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: 0.18 } }}
                    exit={{ opacity: 0, transition: { duration: 0.08 } }}
                  >
                    {comparingFamilies
                      ? 'Probed over both address families every time. Pick one for its full readings.'
                      : `Readings taken over ${FAMILY_LABEL[shownFamily ?? 4]} only.`}
                  </motion.p>
                </AnimatePresence>
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
              {/* The view is what is faded: the old one leaves quickly and the
                  new one comes up, so switching between Compare, a probe, IPv4 and IPv6
                  is a change of picture and not a cut. The route and the
                  alerts below belong to the target, not to the view, and stay. */}
              <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${familyView}|${comparingProbes ? COMPARE_PROBES : shownProbe}`}
                className="space-y-4 @2xl/main:space-y-6"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.2, 0, 0, 1] } }}
                exit={{ opacity: 0, transition: { duration: 0.1, ease: 'easeIn' } }}
              >
              {comparingProbes && !comparingFamilies ? (
                <ComparePanel
                  targets={[selectedTarget]}
                  timeRange={timeRange}
                  zoom={zoom}
                  onZoom={handleZoom}
                  onResetZoom={handleResetZoom}
                  refreshKey={lastUpdated?.getTime()}
                  title={`${vocabulary.latencyTitle}: each probe`}
                  description={`The same monitor from each probe that measures it, on a shared scale. The strips underneath mark when each one had ${vocabulary.lossTitle.toLowerCase()}.`}
                  lossLabel={selectedTarget.probeType === 'dns' ? 'Failed' : undefined}
                  probes="all"
                  probeNames={new Map(probeList.map(probe => [probe.id, probe.name]))}
                  nameSeries={(target, _family, _resolver, probeName) => probeName ?? target.name}
                  showAddress={false}
                  reportError={reportError}
                />
              ) : comparingFamilies ? (
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
                        : `The same monitor over each address family, on a shared scale. The strips underneath mark when each one had ${vocabulary.lossTitle.toLowerCase()}.`
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
                  unmeasured={selectedTarget.neverAnswered}
                  period={zoom ? 'in the zoomed period' : `over the last ${TIME_RANGE_CONFIG[timeRange].label.toLowerCase().replace(/^1 /, '')}`}
                />
              )}

              {/* A closed-port check that never got an answer has no loss to
                  analyse, only a server that cannot be measured this way. */}
              {!showSpinner && statistics && selectedTarget.neverAnswered && (
                <SilentServerNote
                  key={selectedTarget.id}
                  target={selectedTarget}
                  probes={statistics.sampleCount}
                  targets={targets}
                  readOnly={readOnly}
                  // Pinged from where the server is probed from, and put under it in its group.
                  onWatch={address => handleAddTarget(selectedTarget, {
                    name: `${selectedTarget.name} (last hop)`,
                    host: address,
                    probeType: 'ping',
                    ipVersion: 'auto',
                    probeConfig: {},
                    interval: selectedTarget.interval,
                    status: 'active',
                    group: selectedTarget.group,
                    probeAgentId: selectedTarget.probeAgentId ?? null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  })}
                  onShow={setSelectedTargetId}
                />
              )}

              {/* Only when there is loss to find the cause of. */}
              {!showSpinner && statistics && statistics.lossyProbes + statistics.failedProbes > 0 && !selectedTarget.neverAnswered && (
                <LossBreakdown
                  targetId={selectedTarget.id}
                  zoom={zoom}
                  hours={TIME_RANGE_CONFIG[timeRange].hours}
                  family={shownFamily}
                  probe={multiProbe ? shownProbe : undefined}
                  refreshKey={statistics.lastProbe?.getTime()}
                  vocabulary={vocabulary}
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
                      {lastUpdated.toLocaleTimeString('en-US', inDisplayZone({
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      }))}
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
                        span={shownSpan}
                        onZoom={handleZoom}
                        onResetZoom={handleResetZoom}
                        noLossLabel={vocabulary.noLoss}
                        agentOutages={agentOutages}
                      />
                    </motion.div>
                  </ErrorBoundary>
                  ) : (
                    <div className="flex h-[20rem] flex-col items-center justify-center gap-2 text-center">
                      <p className="text-sm text-foreground">Nothing measured in this window yet</p>
                      <p className="max-w-sm text-xs text-muted-foreground">
                        {zoom
                          ? 'No probe ran in the period you selected. Reset the zoom to return to the full range.'
                          : `Probes run every ${selectedTarget.interval}s. Use Measure now to take a reading immediately, or pick a wider time range.`}
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
              </motion.div>
              </AnimatePresence>

                {/* Where the loss breakdown's "Trace the route" goes. */}
                <div id="route" className="scroll-mt-4">
                  <ErrorBoundary label="Route">
                    <TraceroutePanel
                      key={`${selectedTarget.id}:${shownProbe}`}
                      targetId={selectedTarget.id}
                      name={selectedTarget.name}
                      host={selectedTarget.host}
                      ipVersion={selectedTarget.ipVersion}
                      tracedFrom={selectedAgent?.name ?? (multiProbe ? probeNameOf(shownProbe) : undefined)}
                      probe={multiProbe ? shownProbe : undefined}
                      refreshKey={lastUpdated?.getTime()}
                      readOnly={readOnly}
                    />
                  </ErrorBoundary>
                </div>

                <TargetAlerts
                  alerts={alerts}
                  targetId={selectedTarget.id}
                  probeNames={new Map(probeList.map(probe => [probe.id, probe.name]))}
                  onManage={openAlerts}
                />
            </div>
          </motion.div>
          ) : null}
          </AnimatePresence>
          </MotionConfig>
        )}
        </div>
      </main>
      </div>
    </div>
  )
}
