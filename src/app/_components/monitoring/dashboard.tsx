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

  // Auto-refresh targets every 30 seconds to show status changes quickly
  useEffect(() => {
    const interval = setInterval(() => {
      loadTargets()
    }, 30000) // 30 seconds

    return () => clearInterval(interval)
  }, [loadTargets])

  const addTarget = useCallback(async (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => {
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
        await loadTargets()
      }
    } catch (error) {
      console.error('Failed to add target:', error)
    }
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

function useTargetMeasurements(targetId: string | null, timeRange: TimeRange) {
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
          '5h': 5,
          '24h': 24,
          '7d': 168,
          '30d': 720,
          '360d': 8640
        }
        const hours = hoursMap[timeRange]

        const response = await fetch(`/api/targets/${targetId}/measurements?hours=${hours}`)
        if (response.ok) {
          const result = await response.json()
          // API returns { measurements, statistics }, we need just measurements
          const data = result.measurements || result
          
          // Create a full time series for the selected range with appropriate intervals
          const now = new Date()
          const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000)
          
          // Dynamic intervals based on time range for optimal visualization
          let intervalMinutes: number
          let maxPoints: number
          if (hours <= 1) {
            intervalMinutes = 1      // 1h: 1-minute intervals
            maxPoints = 60
          } else if (hours <= 3) {
            intervalMinutes = 3      // 3h: 3-minute intervals  
            maxPoints = 60
          } else if (hours <= 24) {
            intervalMinutes = 5      // 5h, 24h: 5-minute intervals
            maxPoints = hours <= 5 ? 60 : 288
          } else if (hours <= 168) {
            intervalMinutes = 15     // 7d: 15-minute intervals
            maxPoints = 672
          } else if (hours <= 720) {
            intervalMinutes = 60     // 30d: 1-hour intervals
            maxPoints = 720
          } else {
            intervalMinutes = 240    // 360d: 4-hour intervals
            maxPoints = 2160
          }
          
          // Create time series with actual measurements filled in
          const dataPoints: DataPoint[] = []
          const measurements = Array.isArray(data) ? data : []
          
          for (let i = 0; i < maxPoints; i++) {
            const timestamp = new Date(startTime.getTime() + (i * intervalMinutes * 60 * 1000))
            
            // Find actual measurement within this interval (within half interval)
            const actualData = measurements.find((m: ProbeMeasurement) => {
              const dataTime = new Date(m.timestamp).getTime()
              const pointTime = timestamp.getTime()
              return Math.abs(dataTime - pointTime) < (intervalMinutes * 60 * 1000 / 2)
            })
            
            if (actualData) {
              // Use actual measurement data
              dataPoints.push({
                timestamp,
                latency: actualData.latency,
                packetLoss: actualData.packetLoss,
                isOnline: actualData.success
              })
            } else {
              // Use null data for missing periods
              dataPoints.push({
                timestamp,
                latency: null,
                packetLoss: null,
                isOnline: null
              })
            }
          }
          
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
  useEffect(() => {
    if (!targetId) return

    const interval = setInterval(() => {
      loadMeasurementsRef.current()
    }, 30000) // 30 seconds

    return () => clearInterval(interval)
  }, [targetId]) // Remove loadMeasurements from dependencies to prevent interval restart

  return { 
    measurements, 
    loading, 
    reload: loadMeasurements, 
    manualReload: () => loadMeasurements(true),
    initialLoad 
  }
}

function calculateStats(data: DataPoint[]): Omit<TargetStatistics, 'targetId' | 'lastProbe'> & { jitter: number; currentLatency: number; currentPacketLoss: number; currentIsOnline: boolean } {
  if (data.length === 0) {
    return {
      avgLatency: 0,
      minLatency: 0,
      maxLatency: 0,
      packetLoss: 0,
      uptime: 0,
      jitter: 0,
      currentLatency: 0,
      currentPacketLoss: 0,
      currentIsOnline: false
    }
  }

  // Use all data for the selected time range for statistics
  const validLatencies = data.filter(d => d.latency !== null).map(d => d.latency as number)
  const validOnlineData = data.filter(d => d.isOnline !== null)
  const onlineCount = validOnlineData.filter(d => d.isOnline).length
  
  const avgLatency = validLatencies.length > 0
    ? validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length
    : 0
  
  const minLatency = validLatencies.length > 0 ? Math.min(...validLatencies) : 0
  const maxLatency = validLatencies.length > 0 ? Math.max(...validLatencies) : 0
  
  // Calculate packet loss using time-weighted average (more recent = higher weight)
  const packetLossData = data
    .filter(d => d.packetLoss !== null)
    .map(d => ({ packetLoss: d.packetLoss as number, timestamp: d.timestamp }))
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()) // Most recent first

  let packetLoss = 0
  if (packetLossData.length > 0) {
    const now = Date.now()
    let totalWeight = 0
    let weightedSum = 0

    // Use exponential decay: more recent measurements have exponentially higher weight
    packetLossData.forEach((data) => {
      const ageHours = (now - data.timestamp.getTime()) / (1000 * 60 * 60)
      // Exponential decay factor: recent measurements get ~10x weight of hour-old measurements
      const weight = Math.exp(-ageHours * 2.3) // ln(10) ≈ 2.3 for 10x decay per hour
      weightedSum += data.packetLoss * weight
      totalWeight += weight
    })

    packetLoss = totalWeight > 0 ? weightedSum / totalWeight : 0
  }
  
  const uptime = data.length > 0 ? (onlineCount / data.length) * 100 : 0
  
  // Calculate jitter (variation in latency)
  let jitter = 0
  if (validLatencies.length > 1) {
    const diffs = validLatencies.slice(1).map((lat, i) => Math.abs(lat - validLatencies[i]))
    jitter = diffs.reduce((a, b) => a + b, 0) / diffs.length
  }

  // Get the most recent measurement values
  const sortedData = [...data].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  const latestData = sortedData[0]
  const currentLatency = latestData?.latency ?? 0
  const currentPacketLoss = latestData?.packetLoss ?? 0
  
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
    jitter,
    currentLatency,
    currentPacketLoss,
    currentIsOnline
  }
}

export function Dashboard() {
  const { targets, packetLossData, addTarget, updateTarget, deleteTarget, isLoaded, reloadTargets } = useTargets()
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<TimeRange>('5h')
  const [probing, setProbing] = useState(false)
  const [initialAppLoad, setInitialAppLoad] = useState(true)

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

  const selectedTarget = useMemo(() => {
    return targets.find(t => t.id === selectedTargetId) || null
  }, [targets, selectedTargetId])

  const { measurements, loading, reload, manualReload, initialLoad } = useTargetMeasurements(selectedTargetId, timeRange)

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

  const handleRefresh = useCallback(async () => {
    if (selectedTargetId) {
      await manualReload()
    }
  }, [selectedTargetId, manualReload])

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

  // Transform targets to match the expected format
  const transformedTargets = useMemo(() => {
    return targets.map(t => ({
      ...t,
      address: t.host,
      type: (t.probeType === 'dns' ? 'dns' : 'ip') as 'ip' | 'domain' | 'dns',
      isOnline: t.status !== 'error',
      lastCheck: t.updatedAt,
      avgLatency: 0,
      packetLoss: packetLossData[t.id] || (t.status === 'error' ? 100 : 0)
    }))
  }, [targets, packetLossData])

  return (
    <div className="flex h-screen bg-background">
      <Sidebar
        targets={transformedTargets}
        selectedTargetId={selectedTargetId}
        onSelectTarget={setSelectedTargetId}
        onAddTarget={addTarget}
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
        ) : measurements.length > 0 && stats ? (
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
                  avgLatency={stats.avgLatency}
                  minLatency={stats.minLatency}
                  maxLatency={stats.maxLatency}
                  packetLoss={stats.packetLoss}
                  currentLatency={stats.currentLatency}
                  currentPacketLoss={stats.currentPacketLoss}
                  currentIsOnline={stats.currentIsOnline}
                />
              </div>

              <div className="p-6">
                <LatencyChart data={measurements} />
              </div>
            </>
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
                <h2 className="text-lg font-semibold text-foreground mb-2">No Data Available</h2>
                <p className="text-muted-foreground mb-4">
                  This target has no measurement data yet. Click the probe button to collect data.
                </p>
                <Button onClick={handleProbe} disabled={probing}>
                  {probing ? (
                    <>
                      <Activity className="w-4 h-4 mr-2 animate-spin" />
                      Probing...
                    </>
                  ) : (
                    <>
                      <Activity className="w-4 h-4 mr-2" />
                      Probe Now
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
      </main>
    </div>
  )
}
