'use client'

import { useState, useMemo, useEffect } from 'react'
import { cn } from '@/lib/utils'
import type { Target, TargetType } from '@/types/probe'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { getPacketLossColor } from '@/lib/packet-loss-colors'

interface SidebarProps {
  targets: Target[]
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  onAddTarget: (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => void
  onUpdateTarget: (id: string, updates: Partial<Target>) => void
  onDeleteTarget: (id: string) => void
  onRefresh?: () => void
}

function StatusIndicator({ isOnline, packetLoss = 0, createdAt }: { isOnline: boolean; packetLoss?: number; createdAt?: Date | string }) {
  const [isVeryNew, setIsVeryNew] = useState(false)

  useEffect(() => {
    const updateIsVeryNew = () => {
      const veryNew = createdAt && (Date.now() - new Date(createdAt).getTime()) < 60000 // 60 seconds
      setIsVeryNew(!!veryNew)
    }

    updateIsVeryNew()
    const interval = setInterval(updateIsVeryNew, 5000) // Update every 5 seconds

    return () => clearInterval(interval)
  }, [createdAt])

  // Determine status based on online status and packet loss
  let statusColor = '#dc2626' // Default: offline/error (muted red)

  if (isVeryNew) {
    // New targets show grey until they have data
    statusColor = '#6b7280' // Grey for new/unprobed targets
  } else if (isOnline) {
    // Use packet loss colors for online targets
    statusColor = getPacketLossColor(packetLoss)
  }

  return (
    <span
      className="relative inline-flex shrink-0"
      aria-label={
        isVeryNew ? 'New target - waiting for data...' :
        isOnline
          ? packetLoss === 0
            ? 'Online'
            : `Online (${packetLoss.toFixed(1)}% packet loss)`
          : 'Offline'
      }
    >
      {/* Pulsing background ring */}
      <span
        className="absolute inline-flex h-2.5 w-2.5 rounded-full custom-ping"
        style={{ backgroundColor: statusColor }}
      />
      {/* Fixed center circle */}
      <span
        className="relative inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: statusColor }}
      />
    </span>
  )
}

function TypeBadge({ type }: { type: TargetType }) {
  const colors = {
    ip: 'bg-chart-2/20 text-chart-2',
    domain: 'bg-chart-1/20 text-chart-1',
    dns: 'bg-chart-3/20 text-chart-3',
  }

  return (
    <span className={cn('px-1.5 py-0.5 text-[10px] font-medium rounded uppercase', colors[type])}>
      {type}
    </span>
  )
}

export function Sidebar({
  targets,
  selectedTargetId,
  onSelectTarget,
  onAddTarget,
  onUpdateTarget,
  onDeleteTarget,
  onRefresh,
}: SidebarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [editingTarget, setEditingTarget] = useState<Target | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [isGroupDialogOpen, setIsGroupDialogOpen] = useState(false)
  const [newTarget, setNewTarget] = useState({
    name: '',
    address: '',
    type: 'ip' as TargetType,
    probeType: 'ping' as 'ping' | 'dns',
    interval: 300, // Default to 5 minutes
    group: '',
  })

  // Get available groups from existing targets
  const availableGroups = useMemo(() => {
    return [...new Set(targets.map(t => t.group).filter(Boolean))] as string[]
  }, [targets])

  const handleAddTarget = () => {
    if (newTarget.name && newTarget.address) {
      const targetData = {
        name: newTarget.name,
        host: newTarget.address,
        probeType: newTarget.probeType,
        interval: newTarget.interval,
        status: 'active' as const,
        group: newTarget.group || undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
        type: newTarget.type,
      }
      onAddTarget(targetData)
      setNewTarget({ 
        name: '', 
        address: '', 
        type: 'ip',
        probeType: 'ping',
        interval: 300,
        group: '',
      })
      setIsOpen(false)
    }
  }

  const handleEditTarget = () => {
    if (editingTarget) {
      const updates = {
        name: editingTarget.name,
        host: editingTarget.address || editingTarget.host,
        probeType: editingTarget.probeType,
        interval: editingTarget.interval,
        group: editingTarget.group || undefined,
        updatedAt: new Date(),
        type: editingTarget.type,
      }
      onUpdateTarget(editingTarget.id, updates)
      setIsEditOpen(false)
      setEditingTarget(null)
    }
  }

  const handleCreateGroup = () => {
    if (newGroupName.trim() && !availableGroups.includes(newGroupName.trim())) {
      // Groups are created implicitly when targets are assigned to them
      // For now, we'll just close the dialog - the group will be available when a target is assigned to it
      setNewGroupName('')
      setIsGroupDialogOpen(false)
    }
  }

  const openEditDialog = (target: Target) => {
    setEditingTarget({
      ...target,
      address: target.address || target.host,
    })
    setIsEditOpen(true)
  }

  // Group targets by their group
  const groupedTargets = targets.reduce((acc, target) => {
    const group = target.group || 'Ungrouped'
    if (!acc[group]) {
      acc[group] = []
    }
    acc[group].push(target)
    return acc
  }, {} as Record<string, Target[]>)

  const onlineCount = targets.filter(t => t.isOnline).length
  const offlineCount = targets.filter(t => !t.isOnline).length

  return (
    <aside className="w-72 bg-sidebar border-r border-sidebar-border flex flex-col h-full">
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 mb-4">
          <div className="h-8 w-8 rounded-lg bg-primary/20 flex items-center justify-center">
            <svg
              className="h-5 w-5 text-primary"
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
          <div>
            <h1 className="font-semibold text-sidebar-foreground">ClearICMP</h1>
            <p className="text-xs text-muted-foreground">Network Monitor</p>
          </div>
        </div>

        <div className="flex gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <StatusIndicator isOnline={true} />
            <span className="text-muted-foreground">{onlineCount} online</span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIndicator isOnline={false} />
            <span className="text-muted-foreground">{offlineCount} offline</span>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <nav className="p-2" aria-label="Targets">
          <div className="space-y-4">
            {Object.entries(groupedTargets).map(([groupName, groupTargets]) => (
              <div key={groupName}>
                <div className="flex items-center justify-between px-3 py-2">
                  <h3 className="text-sm font-medium text-sidebar-foreground uppercase tracking-wide">
                    {groupName}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {groupTargets.length}
                  </span>
                </div>
                <ul className="space-y-1 ml-2">
                  {groupTargets.map(target => (
                    <li key={target.id}>
                      <div
                        onClick={() => onSelectTarget(target.id)}
                        className={cn(
                          'w-full text-left px-3 py-2.5 rounded-lg transition-colors group cursor-pointer',
                          'hover:bg-sidebar-accent',
                          selectedTargetId === target.id && 'bg-sidebar-accent'
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <StatusIndicator isOnline={target.isOnline || false} packetLoss={target.packetLoss || 0} createdAt={target.createdAt} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm text-sidebar-foreground truncate">
                                {target.name}
                              </span>
                              {target.type && <TypeBadge type={target.type} />}
                            </div>
                            <span className="text-xs text-muted-foreground truncate block">
                              {target.address || target.host}
                            </span>
                          </div>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation()
                                openEditDialog(target)
                              }}
                              className="p-1 hover:bg-blue-500/20 rounded transition-colors cursor-pointer"
                              aria-label={`Edit ${target.name}`}
                            >
                              <svg
                                className="h-4 w-4 text-blue-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                aria-hidden="true"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation()
                                onDeleteTarget(target.id)
                              }}
                              className="p-1 hover:bg-destructive/20 rounded transition-colors cursor-pointer"
                              aria-label={`Delete ${target.name}`}
                            >
                              <svg
                                className="h-4 w-4 text-destructive"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                aria-hidden="true"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
      </ScrollArea>

      <div className="p-3 border-t border-sidebar-border space-y-2">
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            className="w-full"
          >
            <svg
              className="h-4 w-4 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Refresh Targets
          </Button>
        )}

        <Dialog open={isGroupDialogOpen} onOpenChange={setIsGroupDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="w-full" size="sm">
              <svg
                className="h-4 w-4 mr-2"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4"
                />
              </svg>
              Create Group
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border" suppressHydrationWarning>
            <DialogHeader>
              <DialogTitle className="text-card-foreground">Create New Group</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="groupName" className="text-card-foreground">Group Name</Label>
                <Input
                  id="groupName"
                  placeholder="e.g., Websites, DNS Servers, Production"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  className="bg-input border-border text-foreground"
                />
              </div>
              <Button onClick={handleCreateGroup} className="w-full">
                Create Group
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="w-full" size="sm">
              <svg
                className="h-4 w-4 mr-2"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Add Target
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border" suppressHydrationWarning>
            <DialogHeader>
              <DialogTitle className="text-card-foreground">Add New Target</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-card-foreground">Name</Label>
                <Input
                  id="name"
                  placeholder="e.g., Production Server"
                  value={newTarget.name}
                  onChange={e => setNewTarget({ ...newTarget, name: e.target.value })}
                  className="bg-input border-border text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="address" className="text-card-foreground">Address</Label>
                <Input
                  id="address"
                  placeholder="e.g., 192.168.1.1 or example.com"
                  value={newTarget.address}
                  onChange={e => setNewTarget({ ...newTarget, address: e.target.value })}
                  className="bg-input border-border text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="group" className="text-card-foreground">Group (Optional)</Label>
                <Input
                  id="group"
                  placeholder="e.g., Websites, DNS, Production"
                  value={newTarget.group}
                  onChange={e => setNewTarget({ ...newTarget, group: e.target.value })}
                  className="bg-input border-border text-foreground"
                />
                {availableGroups.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    <span className="text-xs text-muted-foreground">Available:</span>
                    {availableGroups.slice(0, 3).map(group => (
                      <button
                        key={group}
                        type="button"
                        onClick={() => setNewTarget({ ...newTarget, group })}
                        className="text-xs px-2 py-1 bg-muted rounded hover:bg-muted/80 transition-colors cursor-pointer"
                      >
                        {group}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Type a new group name or click an existing group
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="type" className="text-card-foreground">Type</Label>
                <Select
                  value={newTarget.type}
                  onValueChange={(value: TargetType) => setNewTarget({ ...newTarget, type: value })}
                >
                  <SelectTrigger id="type" className="bg-input border-border text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                    <SelectItem value="ip">IP Address</SelectItem>
                    <SelectItem value="domain">Domain</SelectItem>
                    <SelectItem value="dns">DNS Server</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="probeType" className="text-card-foreground">Probe Type</Label>
                <Select
                  value={newTarget.probeType}
                  onValueChange={(value: 'ping' | 'dns') => setNewTarget({ ...newTarget, probeType: value })}
                >
                  <SelectTrigger id="probeType" className="bg-input border-border text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                    <SelectItem value="ping">ICMP</SelectItem>
                    <SelectItem value="dns">DNS Query</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="interval" className="text-card-foreground">Probe Interval</Label>
                <Select
                  value={newTarget.interval.toString()}
                  onValueChange={(value) => setNewTarget({ ...newTarget, interval: parseInt(value) })}
                >
                  <SelectTrigger id="interval" className="bg-input border-border text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                    <SelectItem value="30">30 seconds (frequent)</SelectItem>
                    <SelectItem value="60">1 minute</SelectItem>
                    <SelectItem value="120">2 minutes</SelectItem>
                    <SelectItem value="300">5 minutes (default)</SelectItem>
                    <SelectItem value="600">10 minutes</SelectItem>
                    <SelectItem value="1800">30 minutes</SelectItem>
                    <SelectItem value="3600">1 hour</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  How often to automatically probe this target
                </p>
              </div>
              <Button onClick={handleAddTarget} className="w-full">
                Add Target
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogContent className="bg-card border-border" suppressHydrationWarning>
            <DialogHeader>
              <DialogTitle className="text-card-foreground">Edit Target</DialogTitle>
            </DialogHeader>
            {editingTarget && (
              <div className="space-y-4 pt-2">
                <div className="space-y-2">
                  <Label htmlFor="editName" className="text-card-foreground">Name</Label>
                  <Input
                    id="editName"
                    value={editingTarget.name}
                    onChange={e => setEditingTarget({ ...editingTarget, name: e.target.value })}
                    className="bg-input border-border text-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editAddress" className="text-card-foreground">Address</Label>
                  <Input
                    id="editAddress"
                    value={editingTarget.address || editingTarget.host}
                    onChange={e => setEditingTarget({ ...editingTarget, address: e.target.value })}
                    className="bg-input border-border text-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editGroup" className="text-card-foreground">Group (Optional)</Label>
                  <Input
                    id="editGroup"
                    value={editingTarget.group || ''}
                    onChange={e => setEditingTarget({ ...editingTarget, group: e.target.value || undefined })}
                    className="bg-input border-border text-foreground"
                  />
                  {availableGroups.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-xs text-muted-foreground">Available:</span>
                      {availableGroups.slice(0, 3).map(group => (
                        <button
                          key={group}
                          type="button"
                          onClick={() => setEditingTarget({ ...editingTarget, group })}
                          className="text-xs px-2 py-1 bg-muted rounded hover:bg-muted/80 transition-colors cursor-pointer"
                        >
                          {group}
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Type a new group name or click an existing group
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editType" className="text-card-foreground">Type</Label>
                  <Select
                    value={editingTarget.type || 'ip'}
                    onValueChange={(value: TargetType) => setEditingTarget({ ...editingTarget, type: value })}
                  >
                    <SelectTrigger id="editType" className="bg-input border-border text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="ip">IP Address</SelectItem>
                      <SelectItem value="domain">Domain</SelectItem>
                      <SelectItem value="dns">DNS Server</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editProbeType" className="text-card-foreground">Probe Type</Label>
                  <Select
                    value={editingTarget.probeType}
                    onValueChange={(value: 'ping' | 'dns') => setEditingTarget({ ...editingTarget, probeType: value })}
                  >
                    <SelectTrigger id="editProbeType" className="bg-input border-border text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="ping">ICMP</SelectItem>
                      <SelectItem value="dns">DNS Query</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editInterval" className="text-card-foreground">Probe Interval</Label>
                  <Select
                    value={editingTarget.interval.toString()}
                    onValueChange={(value) => setEditingTarget({ ...editingTarget, interval: parseInt(value) })}
                  >
                    <SelectTrigger id="editInterval" className="bg-input border-border text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="30">30 seconds (frequent)</SelectItem>
                      <SelectItem value="60">1 minute</SelectItem>
                      <SelectItem value="120">2 minutes</SelectItem>
                      <SelectItem value="300">5 minutes (default)</SelectItem>
                      <SelectItem value="600">10 minutes</SelectItem>
                      <SelectItem value="1800">30 minutes</SelectItem>
                      <SelectItem value="3600">1 hour</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    How often to automatically probe this target
                  </p>
                </div>
                <Button onClick={handleEditTarget} className="w-full">
                  Save Changes
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </aside>
  )
}
