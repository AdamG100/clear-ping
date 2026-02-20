'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { Target, TimeRange, DataPoint, TargetStatistics, ProbeMeasurement } from '@/types/probe'
import { Sidebar } from './sidebar'
import StatsCards from './stats-cards'
import { TimeRangeSelector } from './time-range-selector'
import { LatencyChart } from './latency-chart'
import { Button } from '@/components/ui/button'
import { Activity, RefreshCw } from 'lucide-react'

function useTargets() {
  const [targets, setTargets] = useState<Target[]>([])
  const [packetLossData, setPacketLossData] = useState<Record<string, number>>({})
  const [isLoaded, setIsLoaded] = useState(false)

  const loadTargets = useCallback(async () => {
    try {
      const response = await fetch('/api/targets?packetLoss=true')
      if (response.ok) {
        const data = await response.json()
        setTargets(data.targets || data)
        
        // Load packet loss data from API response
        const packetLossMap = data.packetLoss || {}
        setPacketLossData(packetLossMap)
      }
    } catch (error) {
      console.error('Failed to load targets:', error)
    } finally {
      setIsLoaded(true)
    }
  }, [])

  useEffect(() => {
    loadTargets()
  }, [loadTargets])

  // Remove auto-refresh from useTargets - will be handled centrally
  // useEffect(() => {
  //   const interval = setInterval(() => {
  //     loadTargets()
  //   }, 30000) // 30 seconds
  //   return () => clearInterval(interval)
  // }, [loadTargets])

  const addTarget = useCallback(async (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>): Promise<Target | null> => {
    try {
      const response = await fetch('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: target.name,
          host: target.address || target.host,
          probeType: target.type === 'dns' ? 'dns' : target.probeType || 'ping',
          interval: target.interval || 300, // Use provided interval or default to 5 minutes
          status: 'active',
          group: target.group,
        }),
      })
      if (response.ok) {
        const created = await response.json()
        await loadTargets()
        return created as Target
      }
    } catch (error) {
      console.error('Failed to add target:', error)
    }
    return null
  }, [loadTargets])

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
      }
    } catch (error) {
      console.error('Failed to update target:', error)
    }
  }, [loadTargets])

  const deleteTarget = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/targets/${id}`, {
        method: 'DELETE',
      })
      if (response.ok) {
        await loadTargets()
      }
    } catch (error) {
      console.error('Failed to delete target:', error)
    }
  }, [loadTargets])

  return { targets, packetLossData, addTarget, updateTarget, deleteTarget, isLoaded, reloadTargets: loadTargets }
}

function useTargetMeasurements(targetId: string | null, timeRange: TimeRange, target: Target | null) {
  const [measurements, setMeasurements] = useState<DataPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [initialLoad, setInitialLoad] = useState(true)

  const loadMeasurements = useCallback(async (isManualRefresh = false) => {
    if (!targetId) {
      setMeasurements([])
      return
    }

    if (isManualRefresh) {
      setLoading(true)
    }
    // Don't show loading state on time range changes to prevent flash
    // Keep existing data visible during transition
    try {        const hoursMap: Record<TimeRange, number> = {
          '1h': 1,
          '3h': 3,
          '6h': 6,
          '24h': 24,
          '7d': 168,
          '30d': 720
        }
        const hours = hoursMap[timeRange]

        const response = await fetch(`/api/targets/${targetId}/measurements?hours=${hours}`)
        if (response.ok) {
          const result = await response.json()
          // API returns { measurements, statistics }, we need just measurements
          const data = result.measurements || result
          
          // Create a full time series aligned with probe intervals
          const now = new Date()
          const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000)
          
          // Use consistent chart intervals for display (not target probe intervals)
          const chartIntervals: Record<TimeRange, number> = {
            '1h': 5,   // 5-minute bars for 1 hour (12 bars)
            '3h': 5,   // 5-minute bars for 3 hours (36 bars)
            '6h': 10,  // 10-minute bars for 6 hours (36 bars)
            '24h': 30, // 30-minute bars for 24 hours (48 bars)
            '7d': 120, // 2-hour bars for 7 days (84 bars)
            '30d': 360 // 6-hour bars for 30 days (120 bars)
          }
          const chartIntervalMinutes = chartIntervals[timeRange]
          
          // Calculate max points based on time range and chart interval
          const totalMinutes = hours * 60
          const maxPoints = Math.min(288, Math.floor(totalMinutes / chartIntervalMinutes)) // Cap at 288 points
          
          // Create time series aligned with chart intervals
          const dataPoints: DataPoint[] = []
          const measurements = Array.isArray(data) ? data : []
          
          for (let i = 0; i < maxPoints; i++) {
            // Calculate timestamp aligned with chart intervals
            const minutesFromStart = i * chartIntervalMinutes
            const timestamp = new Date(startTime.getTime() + (minutesFromStart * 60 * 1000))
            
            // Find actual measurement within this chart interval window
            const actualData = measurements.find((m: ProbeMeasurement) => {
              const dataTime = new Date(m.timestamp).getTime()
              const pointTime = timestamp.getTime()
              // Allow measurements within half the chart interval of the expected time
              const tolerance = (chartIntervalMinutes * 60 * 1000) / 2
              return Math.abs(dataTime - pointTime) < tolerance
            })
            
            if (actualData) {
              // Use actual measurement data but with calculated timestamp for consistent spacing
              dataPoints.push({
                timestamp: timestamp, // Use calculated timestamp for consistent chart spacing
                latency: actualData.latency,
                packetLoss: actualData.packetLoss,
                jitter: actualData.jitter,
                isOnline: actualData.success
              })
            } else {
              // Use null data for missing chart intervals
              dataPoints.push({
                timestamp,
                latency: null,
                packetLoss: null,
                jitter: null,
                isOnline: null
              })
            }
          }
          
          // Sort by timestamp (most recent first for stats calculation)
          dataPoints.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          
          setMeasurements(dataPoints)
          setInitialLoad(false)
          setLoading(false)
        }
      } catch (error) {
        console.error('Failed to load measurements:', error)
        setInitialLoad(false)
        setLoading(false)
      }
  }, [targetId, timeRange])

  // Use ref to store the latest loadMeasurements function for the interval
  const loadMeasurementsRef = useRef(loadMeasurements)

  // Update ref whenever loadMeasurements changes
  useEffect(() => {
    loadMeasurementsRef.current = loadMeasurements
  }, [loadMeasurements])

  useEffect(() => {
    loadMeasurementsRef.current()
  }, [targetId, timeRange])

  // Auto-refresh data every 30 seconds to show probe results quickly
  // Remove this - will be handled centrally
  // useEffect(() => {
  //   if (!targetId) return

  //   const interval = setInterval(() => {
  //     loadMeasurementsRef.current()
  //   }, 30000) // 30 seconds

  //   return () => clearInterval(interval)
  // }, [targetId, timeRange]) // Restart interval when target or time range changes

  return { 
    measurements, 
    loading, 
    reload: loadMeasurements, 
    manualReload: () => loadMeasurements(true),
    initialLoad 
  }
}

function calculateStats(data: DataPoint[]): Omit<TargetStatistics, 'targetId' | 'lastProbe'> & { jitter: number; minJitter: number; maxJitter: number; currentLatency: number; currentPacketLoss: number; currentJitter: number; currentIsOnline: boolean } {
  if (data.length === 0) {
    return {
      avgLatency: 0,
      minLatency: 0,
      maxLatency: 0,
      packetLoss: 0,
      uptime: 0,
      jitter: 0,
      minJitter: 0,
      maxJitter: 0,
      currentLatency: 0,
      currentPacketLoss: 0,
      currentJitter: 0,
      currentIsOnline: false
    }
  }

  // Use all data for the selected time range for statistics
  const validLatencies = data.filter(d => d.latency !== null).map(d => d.latency as number)
  const validJitters = data.filter(d => d.jitter !== null).map(d => d.jitter as number)
  // For jitter statistics, treat null values as 0 (no variation)
  const allJitters = data.map(d => d.jitter ?? 0)
  const validOnlineData = data.filter(d => d.isOnline !== null)
  const onlineCount = validOnlineData.filter(d => d.isOnline).length
  
  const avgLatency = validLatencies.length > 0
    ? validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length
    : 0
  
  const minLatency = validLatencies.length > 0 ? Math.min(...validLatencies) : 0
  const maxLatency = validLatencies.length > 0 ? Math.max(...validLatencies) : 0

  const avgJitter = allJitters.length > 0
    ? allJitters.reduce((a, b) => a + b, 0) / allJitters.length
    : 0

  const minJitter = validJitters.length > 0 ? Math.min(...validJitters) : 0
  const maxJitter = validJitters.length > 0 ? Math.max(...validJitters) : 0
  
  // Calculate packet loss using time-weighted average (more recent = higher weight)
  // Use packetLoss field directly, defaulting to 100% for offline measurements
  const packetLossData = data
    .map(d => ({ 
      packetLoss: d.packetLoss ?? (d.isOnline === false ? 100 : 0), 
      timestamp: d.timestamp 
    }))
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()) // Most recent first

  let packetLoss = 0
  if (packetLossData.length > 0) {
    const now = Date.now()
    let totalWeight = 0
    let weightedSum = 0

    // Use stronger exponential decay: recent measurements get exponentially higher weight
    // Very recent measurements (within minutes) get dramatically higher weight
    packetLossData.forEach((data) => {
      const ageMinutes = (now - data.timestamp.getTime()) / (1000 * 60)
      // Exponential decay factor: measurements from 10 minutes ago get ~100x less weight
      // This makes recent failures much more prominent in the average
      const weight = Math.exp(-ageMinutes * 0.23) // ln(100) ≈ 4.6, so 4.6/20min ≈ 0.23
      weightedSum += data.packetLoss * weight
      totalWeight += weight
    })

    packetLoss = totalWeight > 0 ? weightedSum / totalWeight : 0

    // Apply recency bias: if recent measurements show significant loss, boost the overall percentage
    const veryRecentData = packetLossData.filter(d => {
      const ageMinutes = (now - d.timestamp.getTime()) / (1000 * 60)
      return ageMinutes <= 5 // Last 5 minutes
    })
    
    if (veryRecentData.length > 0) {
      const recentAvgLoss = veryRecentData.reduce((sum, d) => sum + d.packetLoss, 0) / veryRecentData.length
      // If recent measurements show >20% loss, bias toward that value
      if (recentAvgLoss > 20) {
        const biasFactor = Math.min(0.9, recentAvgLoss / 100) // Scale bias with loss severity
        packetLoss = Math.max(packetLoss, recentAvgLoss * biasFactor)
      }
    }
  }
  
  const uptime = data.length > 0 ? (onlineCount / data.length) * 100 : 0

  // Get the most recent measurement values
  const sortedData = [...data].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  const latestData = sortedData[0]
  const currentLatency = latestData?.latency ?? 0
  const currentPacketLoss = latestData?.isOnline === false ? 100 : (latestData?.packetLoss ?? 0)
  const currentJitter = latestData?.jitter ?? null
  
  // Determine current online status: check if there have been any successful measurements in the last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const recentMeasurements = data.filter(d => d.timestamp >= oneHourAgo)
  const hasRecentSuccessfulMeasurements = recentMeasurements.some(d => d.isOnline === true)
  const currentIsOnline = hasRecentSuccessfulMeasurements

  return {
    avgLatency,
    minLatency,
    maxLatency,
    packetLoss,
    uptime,
    jitter: avgJitter,
    minJitter,
    maxJitter,
    currentLatency,
    currentPacketLoss,
    currentJitter: latestData?.jitter ?? 0,
    currentIsOnline
  }
}

export function Dashboard() {
  const { targets, packetLossData, addTarget, updateTarget, deleteTarget, isLoaded, reloadTargets } = useTargets()
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<TimeRange>('1h')
  const [probing, setProbing] = useState(false)
  const [initialAppLoad, setInitialAppLoad] = useState(true)
  const [newTargetIds, setNewTargetIds] = useState<Map<string, number>>(new Map())
  const [isPollingNewTarget, setIsPollingNewTarget] = useState(false)

  // Initialize selectedTargetId from localStorage after mount
  useEffect(() => {
    const saved = localStorage.getItem('selectedTargetId')
    if (saved) {
      setSelectedTargetId(saved)
    }
  }, [])

  // Save selectedTargetId to localStorage when it changes
  useEffect(() => {
    if (selectedTargetId) {
      localStorage.setItem('selectedTargetId', selectedTargetId)
    } else {
      localStorage.removeItem('selectedTargetId')
    }
  }, [selectedTargetId])

  // Show initial loading for 2 seconds on app start if we have a saved target
  useEffect(() => {
    if (selectedTargetId && initialAppLoad) {
      const timer = setTimeout(() => {
        setInitialAppLoad(false)
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [selectedTargetId, initialAppLoad])

  // Set initial target selection
  useEffect(() => {
    if (isLoaded && targets.length > 0 && !selectedTargetId) {
      // Use setTimeout to avoid synchronous setState in effect
      setTimeout(() => setSelectedTargetId(targets[0].id), 0)
    } else if (isLoaded && targets.length > 0 && selectedTargetId) {
      // Validate that the saved target still exists
      const targetExists = targets.some(t => t.id === selectedTargetId)
      if (!targetExists) {
        // Saved target no longer exists, select the first available
        setTimeout(() => setSelectedTargetId(targets[0].id), 0)
      }
    }
  }, [isLoaded, targets, selectedTargetId])

  const handleAddTarget = useCallback(async (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => {
    const result = await addTarget(target)
    if (result) {
      // Track this as a new target
      setNewTargetIds(prev => {
        const currentMap = prev instanceof Map ? prev : new Map()
        return new Map(currentMap).set(result.id, Date.now())
      })
    }
    return result
  }, [addTarget])

  // Clear new target status when they get probed (have packet loss data) and have been new for at least 5 seconds
  useEffect(() => {
    const now = Date.now()
    setNewTargetIds(prev => {
      // Handle migration from Set to Map
      const currentMap = prev instanceof Map ? prev : new Map()
      const updated = new Map(currentMap)
      Object.keys(packetLossData).forEach(targetId => {
        const addedTime = updated.get(targetId)
        if (addedTime && now - addedTime > 5000) { // 5 seconds
          updated.delete(targetId)
        }
      })
      return updated
    })
  }, [packetLossData])

  const selectedTarget = useMemo(() => {
    return targets.find(t => t.id === selectedTargetId) || null
  }, [targets, selectedTargetId])

  // Track when a new target is selected for polling animation
  useEffect(() => {
    if (selectedTargetId && newTargetIds.has(selectedTargetId)) {
      setIsPollingNewTarget(true)
      // Clear the polling state after a delay
      const timer = setTimeout(() => setIsPollingNewTarget(false), 3000)
      return () => clearTimeout(timer)
    }
  }, [selectedTargetId, newTargetIds])

  const { measurements, loading, reload, manualReload, initialLoad } = useTargetMeasurements(selectedTargetId, timeRange, selectedTarget)

  // Refresh measurements when targets data updates (indicating new probe results)
  const prevPacketLossRef = useRef(packetLossData)
  useEffect(() => {
    const prevPacketLoss = prevPacketLossRef.current
    const currentPacketLoss = packetLossData[selectedTargetId || '']

    // Only refresh if the packet loss for the selected target changed
    if (selectedTargetId && currentPacketLoss !== prevPacketLoss?.[selectedTargetId]) {
      reload()
    }

    prevPacketLossRef.current = packetLossData
  }, [packetLossData, selectedTargetId, reload])

  // Centralized polling system - sync all components every 30 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      // Update targets/sidebar data
      await reloadTargets()
      
      // Update measurements/charts/stats for selected target
      if (selectedTargetId) {
        await reload()
      }
    }, 30000) // 30 seconds

    return () => clearInterval(interval)
  }, [reloadTargets, reload, selectedTargetId])

  const handleRefresh = useCallback(async () => {
    // Sync refresh: update both targets and measurements
    await reloadTargets() // Update sidebar indicators
    if (selectedTargetId) {
      await manualReload() // Update charts and stats
    }
  }, [reloadTargets, selectedTargetId, manualReload])

  const handleRefreshTargets = useCallback(async () => {
    await reloadTargets()
  }, [reloadTargets])

  const handleProbe = useCallback(async () => {
    if (!selectedTargetId || probing) return
    
    setProbing(true)
    try {
      const response = await fetch(`/api/targets/${selectedTargetId}/probe`, {
        method: 'POST',
      })
      if (response.ok) {
        // Wait a moment for the probe to complete, then reload measurements
        setTimeout(() => {
          reload()
          setProbing(false)
        }, 1500)
      } else {
        console.error('Probe request failed')
        setProbing(false)
      }
    } catch (error) {
      console.error('Failed to probe target:', error)
      setProbing(false)
    }
  }, [selectedTargetId, probing, reload])

  const stats = useMemo(() => {
    if (measurements.length === 0) return null
    return calculateStats(measurements)
  }, [measurements])

  // Get the latest measurement timestamp for last updated display
  const lastUpdated = useMemo(() => {
    if (measurements.length === 0) return undefined
    const sortedMeasurements = [...measurements].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    return sortedMeasurements[0]?.timestamp
  }, [measurements])

  // Transform targets to match the expected format
  const transformedTargets = useMemo(() => {
    return targets.map(t => ({
      ...t,
      address: t.host,
      type: (t.probeType === 'dns' ? 'dns' : 'ip') as 'ip' | 'domain' | 'dns',
      isOnline: t.status !== 'error',
      lastCheck: t.updatedAt,
      avgLatency: 0,
      packetLoss: packetLossData[t.id] || (t.status === 'error' ? 100 : 0),
      isNew: newTargetIds.has(t.id)
    }))
  }, [targets, packetLossData, newTargetIds])

  return (
    <div className="flex h-screen bg-background">
      <Sidebar
        targets={transformedTargets}
        selectedTargetId={selectedTargetId}
        onSelectTarget={setSelectedTargetId}
        onAddTarget={handleAddTarget}
        onUpdateTarget={updateTarget}
        onDeleteTarget={deleteTarget}
        onRefresh={handleRefreshTargets}
      />

      <main className="flex-1 overflow-auto">
        {!selectedTarget ? (
          selectedTargetId && initialAppLoad ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                <span className="text-muted-foreground">Loading measurements...</span>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                  <svg
                    className="h-8 w-8 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-foreground mb-2">No Target Selected</h2>
                <p className="text-muted-foreground">
                  Select a target from the sidebar or add a new one to start monitoring.
                </p>
              </div>
            </div>
          )
        ) : (loading || initialLoad) ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <span className="text-muted-foreground">Loading measurements...</span>
            </div>
          </div>
        ) : (
            <>
              <div className="p-6 pb-0">
                <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                  <div>
                    <div className="flex items-center gap-3">
                      <h1 className="text-2xl font-bold text-foreground">{selectedTarget.name}</h1>
                    </div>
                    <p className="text-muted-foreground mt-1">
                      {selectedTarget.host} <span className="text-muted-foreground/50">|</span>{' '}
                      <span className="uppercase text-xs">{selectedTarget.probeType === 'ping' ? 'ICMP' : selectedTarget.probeType}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRefresh}
                      disabled={loading}
                      className="shrink-0"
                    >
                      <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                      <span className="ml-2 hidden sm:inline">Refresh</span>
                    </Button>
                  </div>
                </header>

                <StatsCards
                  avgLatency={stats?.avgLatency ?? 0}
                  minLatency={stats?.minLatency ?? 0}
                  maxLatency={stats?.maxLatency ?? 0}
                  packetLoss={stats?.packetLoss ?? 0}
                  currentLatency={stats?.currentLatency ?? 0}
                  currentPacketLoss={stats?.currentPacketLoss ?? 0}
                  jitter={stats?.jitter ?? 0}
                  minJitter={stats?.minJitter ?? 0}
                  maxJitter={stats?.maxJitter ?? 0}
                  currentJitter={stats?.currentJitter ?? 0}
                  lastUpdated={lastUpdated}
                  isPolling={isPollingNewTarget}
                />
              </div>

              {measurements.length > 0 && (
                <div className="p-6">
                  <LatencyChart data={measurements} isPolling={isPollingNewTarget} />
                </div>
              )}
            </>
          )}
      </main>
    </div>
  )
}
