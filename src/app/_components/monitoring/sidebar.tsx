'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import type { Target, TargetType, GroupOrder } from '@/types/probe'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { Reorder, useDragControls, AnimatePresence, motion } from 'framer-motion'
import {
  Plus,
  GripVertical,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Globe,
  Server,
  Shield,
  Network,
  FolderPlus,
  BarChart3,
  Wifi,
  Search,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  targets: Target[]
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  onAddTarget: (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => void
  onUpdateTarget: (id: string, updates: Partial<Target>) => void
  onDeleteTarget: (id: string) => void
  groupOrders?: GroupOrder[]
  onReorderGroups?: (groups: GroupOrder[]) => void
  onReorderTargets?: (updates: { id: string; sortOrder: number; group?: string }[]) => void
}

// ─── Status Indicator ───────────────────────────────────────────────────────

function StatusIndicator({ isOnline, packetLoss = 0, createdAt }: { isOnline: boolean; packetLoss?: number; createdAt?: Date | string }) {
  const [isVeryNew, setIsVeryNew] = useState(false)

  useEffect(() => {
    const updateIsVeryNew = () => {
      const veryNew = createdAt && (Date.now() - new Date(createdAt).getTime()) < 60000
      setIsVeryNew(!!veryNew)
    }
    updateIsVeryNew()
    const interval = setInterval(updateIsVeryNew, 5000)
    return () => clearInterval(interval)
  }, [createdAt])

  let statusColor = '#dc2626'
  if (isVeryNew) {
    statusColor = '#6b7280'
  } else if (isOnline) {
    statusColor = getPacketLossColor(packetLoss)
  }

  return (
    <span
      className="relative inline-flex shrink-0"
      aria-label={
        isVeryNew ? 'New target - waiting for data...' :
        isOnline
          ? packetLoss === 0 ? 'Online' : `Online (${packetLoss.toFixed(1)}% packet loss)`
          : 'Offline'
      }
    >
      <span className="absolute inline-flex h-2.5 w-2.5 rounded-full custom-ping" style={{ backgroundColor: statusColor }} />
      <span className="relative inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: statusColor }} />
    </span>
  )
}

// ─── Type Badge ─────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: TargetType }) {
  const config = {
    ip: { color: 'bg-chart-2/20 text-chart-2' },
    domain: { color: 'bg-chart-1/20 text-chart-1' },
    dns: { color: 'bg-chart-3/20 text-chart-3' },
  }
  const { color } = config[type]

  return (
    <span className={cn('px-1.5 py-0.5 text-[10px] font-medium rounded uppercase', color)}>
      {type}
    </span>
  )
}

// ─── Address auto-detection ─────────────────────────────────────────────────

function detectTargetType(address: string): TargetType {
  const trimmed = address.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return 'ip'
  if (/^[0-9a-fA-F:]+$/.test(trimmed) && trimmed.includes(':')) return 'ip'
  if (['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9'].includes(trimmed)) return 'dns'
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(trimmed)) return 'domain'
  return 'ip'
}

function detectProbeType(type: TargetType): 'ping' | 'dns' {
  return type === 'dns' ? 'dns' : 'ping'
}

// ─── Draggable Target ───────────────────────────────────────────────────────

interface DraggableTargetProps {
  target: Target
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  onEditTarget: (target: Target) => void
  onDeleteTarget: (id: string) => void
  onMoveToGroup?: (id: string, x: number, y: number) => void
}

function DraggableTarget({
  target,
  selectedTargetId,
  onSelectTarget,
  onEditTarget,
  onDeleteTarget,
  onMoveToGroup,
}: DraggableTargetProps) {
  const dragControls = useDragControls()

  return (
    <Reorder.Item
      value={target.id}
      data-target-id={target.id}
      dragListener={false}
      dragControls={dragControls}
      className="select-none"
      whileDrag={{ scale: 1.02, zIndex: 50 }}
      layout
      transition={{ duration: 0.15 }}
      onDragEnd={(event, info) => {
        if (onMoveToGroup) {
          onMoveToGroup(target.id, info.point.x, info.point.y)
        }
      }}
    >
      <div
        onClick={() => onSelectTarget(target.id)}
        className={cn(
          'w-full text-left px-2 py-2 rounded-md transition-colors group/target cursor-pointer',
          'hover:bg-sidebar-accent',
          selectedTargetId === target.id && 'bg-sidebar-accent'
        )}
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onPointerDown={(e) => dragControls.start(e)}
            className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/0 group-hover/target:text-muted-foreground/40 hover:text-muted-foreground/70! transition-colors touch-none shrink-0"
            aria-label={`Drag to reorder ${target.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3 w-3" />
          </button>
          <StatusIndicator
            isOnline={target.isOnline || false}
            packetLoss={target.packetLoss || 0}
            createdAt={target.createdAt}
          />
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
          <div className="flex gap-0.5 opacity-0 group-hover/target:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onEditTarget(target) }}
              className="p-1 hover:bg-blue-500/20 rounded transition-colors cursor-pointer"
              aria-label={`Edit ${target.name}`}
            >
              <Pencil className="h-3.5 w-3.5 text-blue-500" />
            </button>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onDeleteTarget(target.id) }}
              className="p-1 hover:bg-destructive/20 rounded transition-colors cursor-pointer"
              aria-label={`Delete ${target.name}`}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </button>
          </div>
        </div>
      </div>
    </Reorder.Item>
  )
}

// ─── Draggable Group ────────────────────────────────────────────────────────

interface DraggableGroupProps {
  groupName: string
  groupTargets: Target[]
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  onEditTarget: (target: Target) => void
  onDeleteTarget: (id: string) => void
  collapsedGroups: Set<string>
  onToggleCollapse: (groupName: string) => void
  onReorderTargets?: (groupName: string, orderedIds: string[]) => void
  onMoveToGroup?: (id: string, x: number, y: number) => void
}

function DraggableGroup({
  groupName,
  groupTargets,
  selectedTargetId,
  onSelectTarget,
  onEditTarget,
  onDeleteTarget,
  collapsedGroups,
  onToggleCollapse,
  onReorderTargets,
  onMoveToGroup,
}: DraggableGroupProps) {
  const dragControls = useDragControls()
  const isCollapsed = collapsedGroups.has(groupName)

  const targetIds = useMemo(() => groupTargets.map(t => t.id), [groupTargets])
  const [reorderableTargetIds, setReorderableTargetIds] = useState(targetIds)
  const targetMap = useMemo(() => new Map(groupTargets.map(t => [t.id, t])), [groupTargets])

  useEffect(() => {
    setReorderableTargetIds(targetIds)
  }, [targetIds])

  // Persist target reorder on pointer up (end of drag)
  useEffect(() => {
    const handlePointerUp = () => {
      if (!onReorderTargets) return
      const changed = reorderableTargetIds.some((id, i) => id !== targetIds[i])
      if (changed) {
        onReorderTargets(groupName, reorderableTargetIds)
      }
    }
    window.addEventListener('pointerup', handlePointerUp)
    return () => window.removeEventListener('pointerup', handlePointerUp)
  }, [reorderableTargetIds, targetIds, onReorderTargets, groupName])

  return (
    <Reorder.Item
      value={groupName}
      dragListener={false}
      dragControls={dragControls}
      className="select-none"
      whileDrag={{ scale: 1.02, zIndex: 50 }}
      layout
      transition={{ duration: 0.2 }}
    >
      <div className="rounded-lg overflow-hidden" data-group={groupName}>
        {/* Group Header */}
        <div className="flex items-center gap-1 px-2 py-1.5 group/header">
          <button
            type="button"
            onPointerDown={(e) => dragControls.start(e)}
            className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground transition-colors touch-none"
            aria-label={`Drag to reorder ${groupName}`}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onToggleCollapse(groupName)}
            className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer"
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="text-xs font-semibold text-sidebar-foreground uppercase tracking-wider truncate">
              {groupName}
            </span>
          </button>

          <span className="text-[10px] text-muted-foreground tabular-nums bg-muted/50 px-1.5 py-0.5 rounded-full">
            {groupTargets.length}
          </span>
        </div>

        {/* Target List */}
        <AnimatePresence initial={false}>
          {!isCollapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <Reorder.Group
                axis="y"
                values={reorderableTargetIds}
                onReorder={setReorderableTargetIds}
                className="space-y-0.5 ml-1"
              >
                {reorderableTargetIds.map(targetId => {
                  const target = targetMap.get(targetId)
                  if (!target) return null
                  return (
                    <DraggableTarget
                      key={targetId}
                      target={target}
                      selectedTargetId={selectedTargetId}
                      onSelectTarget={onSelectTarget}
                      onEditTarget={onEditTarget}
                      onDeleteTarget={onDeleteTarget}
                      onMoveToGroup={onMoveToGroup}
                    />
                  )
                })}
              </Reorder.Group>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Reorder.Item>
  )
}

// ─── Add Target Dialog ──────────────────────────────────────────────────────

interface AddTargetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddTarget: (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => void
  availableGroups: string[]
}

function AddTargetDialog({ open, onOpenChange, onAddTarget, availableGroups }: AddTargetDialogProps) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [type, setType] = useState<TargetType>('ip')
  const [probeType, setProbeType] = useState<'ping' | 'dns'>('ping')
  const [interval, setInterval] = useState(300)
  const [group, setGroup] = useState('')
  const [customGroup, setCustomGroup] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const handleAddressChange = (value: string) => {
    setAddress(value)
    if (value) {
      const detected = detectTargetType(value)
      setType(detected)
      setProbeType(detectProbeType(detected))
    }
  }

  const resetForm = useCallback(() => {
    setName('')
    setAddress('')
    setType('ip')
    setProbeType('ping')
    setInterval(300)
    setGroup('')
    setCustomGroup('')
    setShowAdvanced(false)
  }, [])

  const handleSubmit = () => {
    if (!name.trim() || !address.trim()) return

    const resolvedGroup = group === '__custom__' ? customGroup.trim() : group

    onAddTarget({
      name: name.trim(),
      host: address.trim(),
      probeType,
      interval,
      status: 'active',
      group: resolvedGroup || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      type,
    })

    resetForm()
    onOpenChange(false)
  }

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) resetForm()
    onOpenChange(isOpen)
  }

  const isValid = name.trim() && address.trim()

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-md" suppressHydrationWarning>
        <DialogHeader>
          <DialogTitle className="text-card-foreground flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Plus className="h-4 w-4 text-primary" />
            </div>
            Add New Target
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Add a server, website, or DNS target to monitor.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Address — the most important field, first */}
          <div className="space-y-2">
            <Label htmlFor="add-address" className="text-card-foreground text-sm font-medium">
              Address
            </Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="add-address"
                placeholder="e.g., 192.168.1.1, example.com, 8.8.8.8"
                value={address}
                onChange={e => handleAddressChange(e.target.value)}
                className="bg-input border-border text-foreground pl-9"
                autoFocus
              />
            </div>
            {address && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Detected:</span>
                <TypeBadge type={type} />
                <span className="text-muted-foreground/60">&bull;</span>
                <span>{probeType === 'ping' ? 'ICMP Ping' : 'DNS Query'}</span>
              </div>
            )}
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="add-name" className="text-card-foreground text-sm font-medium">
              Display Name
            </Label>
            <Input
              id="add-name"
              placeholder="e.g., Production Server, Google DNS"
              value={name}
              onChange={e => setName(e.target.value)}
              className="bg-input border-border text-foreground"
            />
          </div>

          {/* Group selection */}
          <div className="space-y-2">
            <Label className="text-card-foreground text-sm font-medium">
              Group
            </Label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setGroup('')}
                className={cn(
                  'text-xs px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer',
                  group === ''
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                )}
              >
                None
              </button>
              {availableGroups.map(g => (
                <button
                  key={g}
                  type="button"
                  onClick={() => { setGroup(g); setCustomGroup('') }}
                  className={cn(
                    'text-xs px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer',
                    group === g
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                  )}
                >
                  {g}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setGroup('__custom__')}
                className={cn(
                  'text-xs px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer flex items-center gap-1',
                  group === '__custom__'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                )}
              >
                <FolderPlus className="h-3 w-3" />
                New
              </button>
            </div>
            {group === '__custom__' && (
              <Input
                placeholder="New group name…"
                value={customGroup}
                onChange={e => setCustomGroup(e.target.value)}
                className="bg-input border-border text-foreground text-sm mt-1.5"
                autoFocus
              />
            )}
          </div>

          {/* Advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Advanced Settings
          </button>

          <AnimatePresence initial={false}>
            {showAdvanced && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="space-y-4 pb-1">
                  {/* Type override */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="add-type" className="text-card-foreground text-xs">Type</Label>
                      <Select value={type} onValueChange={(v: TargetType) => setType(v)}>
                        <SelectTrigger id="add-type" className="bg-input border-border text-foreground h-9 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border">
                          <SelectItem value="ip">
                            <div className="flex items-center gap-2"><Server className="h-3.5 w-3.5" /> IP Address</div>
                          </SelectItem>
                          <SelectItem value="domain">
                            <div className="flex items-center gap-2"><Globe className="h-3.5 w-3.5" /> Domain</div>
                          </SelectItem>
                          <SelectItem value="dns">
                            <div className="flex items-center gap-2"><Shield className="h-3.5 w-3.5" /> DNS Server</div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="add-probe" className="text-card-foreground text-xs">Probe</Label>
                      <Select value={probeType} onValueChange={(v: 'ping' | 'dns') => setProbeType(v)}>
                        <SelectTrigger id="add-probe" className="bg-input border-border text-foreground h-9 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border">
                          <SelectItem value="ping">
                            <div className="flex items-center gap-2"><Wifi className="h-3.5 w-3.5" /> ICMP</div>
                          </SelectItem>
                          <SelectItem value="dns">
                            <div className="flex items-center gap-2"><Network className="h-3.5 w-3.5" /> DNS</div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Interval */}
                  <div className="space-y-2">
                    <Label htmlFor="add-interval" className="text-card-foreground text-xs">Probe Interval</Label>
                    <Select value={interval.toString()} onValueChange={(v) => setInterval(parseInt(v))}>
                      <SelectTrigger id="add-interval" className="bg-input border-border text-foreground h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border">
                        <SelectItem value="30">30 seconds</SelectItem>
                        <SelectItem value="60">1 minute</SelectItem>
                        <SelectItem value="120">2 minutes</SelectItem>
                        <SelectItem value="300">5 minutes</SelectItem>
                        <SelectItem value="600">10 minutes</SelectItem>
                        <SelectItem value="1800">30 minutes</SelectItem>
                        <SelectItem value="3600">1 hour</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Submit */}
          <Button
            onClick={handleSubmit}
            className="w-full"
            disabled={!isValid}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Target
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Edit Target Dialog ─────────────────────────────────────────────────────

interface EditTargetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: Target | null
  onSave: (id: string, updates: Partial<Target>) => void
  availableGroups: string[]
}

function EditTargetDialog({ open, onOpenChange, target, onSave, availableGroups }: EditTargetDialogProps) {
  if (!target) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-md" suppressHydrationWarning>
        <EditTargetForm
          key={target.id}
          target={target}
          onSave={onSave}
          onClose={() => onOpenChange(false)}
          availableGroups={availableGroups}
        />
      </DialogContent>
    </Dialog>
  )
}

function EditTargetForm({ target, onSave, onClose, availableGroups }: {
  target: Target
  onSave: (id: string, updates: Partial<Target>) => void
  onClose: () => void
  availableGroups: string[]
}) {
  const initGroup = target.group || ''
  const isCustom = initGroup && !availableGroups.includes(initGroup)

  const [name, setName] = useState(target.name)
  const [address, setAddress] = useState(target.address || target.host)
  const [type, setType] = useState<TargetType>(target.type || 'ip')
  const [probeType, setProbeType] = useState<'ping' | 'dns'>(target.probeType)
  const [interval, setInterval] = useState(target.interval)
  const [group, setGroup] = useState(isCustom ? '__custom__' : initGroup)
  const [customGroup, setCustomGroup] = useState(isCustom ? initGroup : '')

  const handleSave = () => {
    if (!name.trim() || !address.trim()) return

    const resolvedGroup = group === '__custom__' ? customGroup.trim() : group

    onSave(target.id, {
      name: name.trim(),
      host: address.trim(),
      probeType,
      interval,
      group: resolvedGroup || undefined,
      type,
      updatedAt: new Date(),
    })
    onClose()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-card-foreground flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <Pencil className="h-4 w-4 text-blue-500" />
          </div>
          Edit Target
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4 pt-2">
        <div className="space-y-2">
          <Label htmlFor="edit-name" className="text-card-foreground text-sm font-medium">Display Name</Label>
          <Input
              id="edit-name"
              value={name}
              onChange={e => setName(e.target.value)}
              className="bg-input border-border text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-address" className="text-card-foreground text-sm font-medium">Address</Label>
            <Input
              id="edit-address"
              value={address}
              onChange={e => setAddress(e.target.value)}
              className="bg-input border-border text-foreground"
            />
          </div>

          {/* Group selection */}
          <div className="space-y-2">
            <Label className="text-card-foreground text-sm font-medium">Group</Label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setGroup('')}
                className={cn(
                  'text-xs px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer',
                  group === ''
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                )}
              >
                None
              </button>
              {availableGroups.map(g => (
                <button
                  key={g}
                  type="button"
                  onClick={() => { setGroup(g); setCustomGroup('') }}
                  className={cn(
                    'text-xs px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer',
                    group === g
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                  )}
                >
                  {g}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setGroup('__custom__')}
                className={cn(
                  'text-xs px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer flex items-center gap-1',
                  group === '__custom__'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                )}
              >
                <FolderPlus className="h-3 w-3" />
                New
              </button>
            </div>
            {group === '__custom__' && (
              <Input
                placeholder="New group name…"
                value={customGroup}
                onChange={e => setCustomGroup(e.target.value)}
                className="bg-input border-border text-foreground text-sm mt-1.5"
                autoFocus
              />
            )}
          </div>

          {/* Type + Probe */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-type" className="text-card-foreground text-xs">Type</Label>
              <Select value={type} onValueChange={(v: TargetType) => setType(v)}>
                <SelectTrigger id="edit-type" className="bg-input border-border text-foreground h-9 text-sm">
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
              <Label htmlFor="edit-probe" className="text-card-foreground text-xs">Probe</Label>
              <Select value={probeType} onValueChange={(v: 'ping' | 'dns') => setProbeType(v)}>
                <SelectTrigger id="edit-probe" className="bg-input border-border text-foreground h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  <SelectItem value="ping">ICMP</SelectItem>
                  <SelectItem value="dns">DNS Query</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Interval */}
          <div className="space-y-2">
            <Label htmlFor="edit-interval" className="text-card-foreground text-xs">Probe Interval</Label>
            <Select value={interval.toString()} onValueChange={(v) => setInterval(parseInt(v))}>
              <SelectTrigger id="edit-interval" className="bg-input border-border text-foreground h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                <SelectItem value="30">30 seconds</SelectItem>
                <SelectItem value="60">1 minute</SelectItem>
                <SelectItem value="120">2 minutes</SelectItem>
                <SelectItem value="300">5 minutes</SelectItem>
                <SelectItem value="600">10 minutes</SelectItem>
                <SelectItem value="1800">30 minutes</SelectItem>
                <SelectItem value="3600">1 hour</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button onClick={handleSave} className="w-full">
            Save Changes
          </Button>
        </div>
    </>
  )
}

// ─── Main Sidebar Component ─────────────────────────────────────────────────

export function Sidebar({
  targets,
  selectedTargetId,
  onSelectTarget,
  onAddTarget,
  onUpdateTarget,
  onDeleteTarget,
  groupOrders = [],
  onReorderGroups,
  onReorderTargets,
}: SidebarProps) {
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [editingTarget, setEditingTarget] = useState<Target | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  // Get available groups from existing targets
  const availableGroups = useMemo(() => {
    return [...new Set(targets.map(t => t.group).filter(Boolean))] as string[]
  }, [targets])

  // Group targets with ordering
  const { orderedGroupNames, groupedTargets } = useMemo(() => {
    const grouped = targets.reduce((acc, target) => {
      const g = target.group || 'Ungrouped'
      if (!acc[g]) acc[g] = []
      acc[g].push(target)
      return acc
    }, {} as Record<string, Target[]>)

    // Sort targets within each group by sortOrder
    Object.values(grouped).forEach(list => {
      list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    })

    // Order groups: use persisted ordering, then add any new groups at end
    const orderMap = new Map(groupOrders.map(o => [o.groupName, o.sortOrder]))
    const allGroupNames = Object.keys(grouped)

    const ordered = [...allGroupNames].sort((a, b) => {
      const aOrder = orderMap.get(a) ?? 999
      const bOrder = orderMap.get(b) ?? 999
      if (aOrder !== bOrder) return aOrder - bOrder
      if (a === 'Ungrouped') return 1
      if (b === 'Ungrouped') return -1
      return a.localeCompare(b)
    })

    return { orderedGroupNames: ordered, groupedTargets: grouped }
  }, [targets, groupOrders])

  // Filter targets by search
  const filteredGroupedTargets = useMemo(() => {
    if (!searchQuery.trim()) return groupedTargets

    const q = searchQuery.toLowerCase()
    const filtered: Record<string, Target[]> = {}
    for (const [groupKey, list] of Object.entries(groupedTargets)) {
      const matches = list.filter(t =>
        t.name.toLowerCase().includes(q) ||
        (t.address || t.host).toLowerCase().includes(q)
      )
      if (matches.length > 0) filtered[groupKey] = matches
    }
    return filtered
  }, [groupedTargets, searchQuery])

  const filteredGroupNames = useMemo(() => {
    if (!searchQuery.trim()) return orderedGroupNames
    return orderedGroupNames.filter(g => filteredGroupedTargets[g])
  }, [orderedGroupNames, filteredGroupedTargets, searchQuery])

  const [reorderableGroups, setReorderableGroups] = useState<string[]>(orderedGroupNames)

  // Sync when external ordering changes
  useEffect(() => {
    setReorderableGroups(orderedGroupNames)
  }, [orderedGroupNames])

  const handleGroupReorder = useCallback((newOrder: string[]) => {
    setReorderableGroups(newOrder)
  }, [])

  const handleTargetReorder = useCallback((groupName: string, orderedIds: string[]) => {
    if (!onReorderTargets) return
    const updates = orderedIds.map((id, index) => ({ id, sortOrder: index }))
    onReorderTargets(updates)
  }, [onReorderTargets])

  const handleMoveToGroup = useCallback((id: string, x: number, y: number) => {
    if (!onReorderTargets) return
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return

    const groupEl = el.closest('[data-group]') as HTMLElement | null
    const destGroup = groupEl?.getAttribute('data-group') ?? 'Ungrouped'

    // find source group
    const sourceEntry = Object.entries(groupedTargets).find(([, list]) => list.some(t => t.id === id))
    const sourceGroup = sourceEntry ? sourceEntry[0] : 'Ungrouped'

    // if same group, nothing to do here (intra-group reordering handled elsewhere)
    if (sourceGroup === destGroup) return

    const destTargetEl = el.closest('[data-target-id]') as HTMLElement | null
    const destTargetId = destTargetEl?.getAttribute('data-target-id') ?? null

    const destList = (groupedTargets[destGroup] ?? []).map(t => t.id).filter(i => i !== id)
    let destIndex = destList.length
    if (destTargetId) {
      const idx = destList.indexOf(destTargetId)
      destIndex = idx === -1 ? destList.length : idx
    }

    // build updates for source (remove) and dest (insert)
    const updates: { id: string; sortOrder: number; group?: string }[] = []

    const sourceList = (groupedTargets[sourceGroup] ?? []).map(t => t.id).filter(i => i !== id)
    sourceList.forEach((tid, idx) => updates.push({ id: tid, sortOrder: idx }))

    destList.splice(destIndex, 0, id)
    destList.forEach((tid, idx) => {
      if (tid === id) updates.push({ id: tid, sortOrder: idx, group: destGroup === 'Ungrouped' ? '' : destGroup })
      else updates.push({ id: tid, sortOrder: idx })
    })

    if (updates.length > 0) onReorderTargets(updates)
  }, [groupedTargets, onReorderTargets])

  // Persist reorder on pointer up (end of drag)
  useEffect(() => {
    const handlePointerUp = () => {
      if (!onReorderGroups) return
      // Only fire if the order actually differs from orderedGroupNames
      const changed = reorderableGroups.some((g, i) => g !== orderedGroupNames[i])
      if (changed) {
        const newOrders: GroupOrder[] = reorderableGroups.map((name, i) => ({
          groupName: name,
          sortOrder: i,
        }))
        onReorderGroups(newOrders)
      }
    }
    window.addEventListener('pointerup', handlePointerUp)
    return () => window.removeEventListener('pointerup', handlePointerUp)
  }, [reorderableGroups, orderedGroupNames, onReorderGroups])

  const toggleCollapse = useCallback((groupName: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupName)) next.delete(groupName)
      else next.add(groupName)
      return next
    })
  }, [])

  const openEditDialog = (target: Target) => {
    setEditingTarget({ ...target, address: target.address || target.host })
    setIsEditOpen(true)
  }

  const onlineCount = targets.filter(t => t.isOnline).length
  const offlineCount = targets.filter(t => !t.isOnline).length

  return (
    <aside className="w-72 bg-sidebar border-r border-sidebar-border flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-8 w-8 rounded-lg bg-primary/20 flex items-center justify-center">
            <BarChart3 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="font-semibold text-sidebar-foreground">ClearICMP</h1>
            <p className="text-xs text-muted-foreground">Network Monitor</p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <StatusIndicator isOnline={true} />
            <span className="text-muted-foreground">{onlineCount} online</span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIndicator isOnline={false} />
            <span className="text-muted-foreground">{offlineCount} offline</span>
          </div>
          {targets.length > 4 && (
            <button
              type="button"
              onClick={() => { setShowSearch(!showSearch); if (showSearch) setSearchQuery('') }}
              className="ml-auto p-1 hover:bg-sidebar-accent rounded transition-colors cursor-pointer"
              aria-label="Search targets"
            >
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>

        <AnimatePresence>
          {showSearch && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <Input
                placeholder="Search targets…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="mt-3 bg-sidebar-accent border-sidebar-border text-sm h-8"
                autoFocus
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Target List */}
      <ScrollArea className="flex-1">
        <nav className="p-2" aria-label="Targets">
          {searchQuery.trim() ? (
            // Search mode: plain list, no drag
            <div className="space-y-3">
              {filteredGroupNames.map(groupName => (
                <div key={groupName}>
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <span className="text-xs font-semibold text-sidebar-foreground uppercase tracking-wider truncate">
                      {groupName}
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums bg-muted/50 px-1.5 py-0.5 rounded-full ml-auto">
                      {filteredGroupedTargets[groupName]?.length ?? 0}
                    </span>
                  </div>
                  <ul className="space-y-0.5 ml-1">
                    {(filteredGroupedTargets[groupName] ?? []).map(target => (
                      <li key={target.id}>
                        <div
                          onClick={() => onSelectTarget(target.id)}
                          className={cn(
                            'w-full text-left px-3 py-2 rounded-md transition-colors group cursor-pointer',
                            'hover:bg-sidebar-accent',
                            selectedTargetId === target.id && 'bg-sidebar-accent'
                          )}
                        >
                          <div className="flex items-center gap-2.5">
                            <StatusIndicator isOnline={target.isOnline || false} packetLoss={target.packetLoss || 0} createdAt={target.createdAt} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm text-sidebar-foreground truncate">{target.name}</span>
                                {target.type && <TypeBadge type={target.type} />}
                              </div>
                              <span className="text-xs text-muted-foreground truncate block">{target.address || target.host}</span>
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {filteredGroupNames.length === 0 && (
                <p className="text-center text-sm text-muted-foreground py-8">No targets found</p>
              )}
            </div>
          ) : (
            // Normal mode: draggable groups
            <Reorder.Group
              axis="y"
              values={reorderableGroups}
              onReorder={handleGroupReorder}
              className="space-y-1"
              layoutScroll
            >
              {reorderableGroups.map(groupName => {
                const groupTargets = groupedTargets[groupName]
                if (!groupTargets) return null

                return (
                  <DraggableGroup
                    key={groupName}
                    groupName={groupName}
                    groupTargets={groupTargets}
                    selectedTargetId={selectedTargetId}
                    onSelectTarget={onSelectTarget}
                    onEditTarget={openEditDialog}
                    onDeleteTarget={onDeleteTarget}
                    collapsedGroups={collapsedGroups}
                    onToggleCollapse={toggleCollapse}
                    onReorderTargets={handleTargetReorder}
                    onMoveToGroup={handleMoveToGroup}
                  />
                )
              })}
            </Reorder.Group>
          )}
        </nav>
      </ScrollArea>

      {/* Footer actions */}
      <div className="p-3 border-t border-sidebar-border space-y-2">
        {/* Refresh button removed */}

        <Button
          className="w-full"
          size="sm"
          onClick={() => setIsAddOpen(true)}
          suppressHydrationWarning
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Target
        </Button>
      </div>

      {/* Add Target Dialog */}
      <AddTargetDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        onAddTarget={onAddTarget}
        availableGroups={availableGroups}
      />

      {/* Edit Target Dialog */}
      <EditTargetDialog
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
        target={editingTarget}
        onSave={onUpdateTarget}
        availableGroups={availableGroups}
      />
    </aside>
  )
}
