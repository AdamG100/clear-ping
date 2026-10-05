'use client'

import { useState, useMemo, useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import type { Target, GroupOrder, SparklinePoint } from '@/types/probe'
import { Sparkline } from './sparkline'
import { SidebarSkeleton } from './skeleton'
import { AddTargetDialog, DeleteTargetDialog, EditTargetDialog } from './target-dialogs'
import { GroupDialog } from './group-dialog'
import { DualStackBadge, Ipv6Badge, TypeBadge } from './target-badges'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getPacketLossColor, isMeaningfulLoss, NO_DATA_COLOR } from '@/lib/packet-loss-colors'
import { addressFamilyFor, isDualStack } from '@/lib/host'
import { targetAddressLabel } from '@/lib/probe-config'
import { groupLabel, groupName, rebaseGroupPath } from '@/lib/group-path'
import { combineSeries } from '@/lib/group-series'
import {
  UNGROUPED,
  buildSidebarLayout,
  groupsInOrder,
  reorderSubgroups,
  subgroups,
  targetOrderUpdates,
  targetsWithin,
  type SidebarLayout,
} from '@/lib/sidebar-layout'
import { DRAG_SPRING, useTargetDrag, type ActiveTargetDrag } from './use-target-drag'
import { Reorder, useDragControls, AnimatePresence, MotionConfig, motion, type MotionValue } from 'framer-motion'
import {
  Plus,
  GripVertical,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Search,
  Pause,
  Play,
  ChartLine,
  Bell,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  targets: Target[]
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  onAddTarget: (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => void
  onUpdateTarget: (id: string, updates: Partial<Target>) => void
  onDeleteTarget: (id: string) => void
  onTogglePaused: (target: Target) => void
  /** The group whose comparison chart is on screen, if one is. */
  selectedGroup?: string | null
  onSelectGroup?: (groupName: string) => void
  series?: Record<string, SparklinePoint[]>
  groupOrders?: GroupOrder[]
  onReorderGroups?: (groups: GroupOrder[]) => void
  /** Rename a group or move it inside another: its path changes from one to the other. */
  onMoveGroup?: (from: string, to: string) => void
  /** Whether the alerts screen is what the main pane is showing. */
  alertsOpen?: boolean
  onOpenAlerts?: () => void
  /** How many alerts are firing on at least one target. */
  firingAlerts?: number
  onReorderTargets?: (updates: { id: string; sortOrder: number; group?: string }[]) => void
  /** The targets have not arrived yet: there is no list to show and nothing to count. */
  loading?: boolean
}

// ─── Status Indicator ───────────────────────────────────────────────────────

/**
 * Status dot: online (coloured by packet loss), offline, awaiting its first
 * measurement, or paused.
 *
 * `isOnline` is `undefined` — not `false` — when nothing has been measured yet.
 * Collapsing those two cases showed a brand new target as though it were down.
 *
 * A paused target is grey whatever its last reading was. That reading is from
 * before it was paused, and a green or red light would be a claim about now.
 */
function StatusIndicator({
  isOnline,
  packetLoss,
  note,
  paused = false,
}: {
  isOnline?: boolean
  packetLoss?: number
  /** Replaces the description: how each address family of a dual-stack target is doing. */
  note?: string
  paused?: boolean
}) {
  const pending = isOnline === undefined

  let statusColor: string
  let label: string

  if (paused) {
    statusColor = NO_DATA_COLOR
    label = 'Paused'
  } else if (pending) {
    statusColor = NO_DATA_COLOR
    label = 'Waiting for first measurement'
  } else if (isOnline) {
    statusColor = getPacketLossColor(packetLoss ?? 0)
    label = isMeaningfulLoss(packetLoss)
      ? `Online (${packetLoss!.toFixed(1)}% packet loss)`
      : 'Online'
  } else {
    statusColor = getPacketLossColor(100)
    label = 'Offline'
  }

  if (note && !pending && !paused) label = note

  return (
    <span className="relative inline-flex shrink-0" title={label}>
      {/* The pulse only runs for a live target; a steady dot for offline and
          pending states stops a dead target from looking like active traffic. */}
      {isOnline && !paused && (
        <span
          className="absolute inline-flex h-2.5 w-2.5 rounded-full custom-ping"
          style={{ backgroundColor: statusColor }}
          aria-hidden="true"
        />
      )}
      <span
        className="relative inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: statusColor }}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  )
}

// ─── Target Row ─────────────────────────────────────────────────────────────

interface TargetRowProps {
  target: Target
  selected: boolean
  trace?: SparklinePoint[]
  /**
   * True for the copy that follows the pointer during a drag. It is a picture
   * of the row, not a second set of controls, so nothing in it is reachable.
   */
  floating?: boolean
  onSelectTarget?: (id: string) => void
  onEditTarget?: (target: Target) => void
  onDeleteTarget?: (id: string) => void
  onTogglePaused?: (target: Target) => void
  onHandlePointerDown?: (id: string, event: ReactPointerEvent<HTMLElement>) => void
}

function TargetRow({
  target,
  selected,
  trace,
  floating = false,
  onSelectTarget,
  onEditTarget,
  onDeleteTarget,
  onTogglePaused,
  onHandlePointerDown,
}: TargetRowProps) {
  const paused = target.status === 'paused'
  const address = targetAddressLabel(target)
  const dualStack = isDualStack(target.host, target.ipVersion)
  const usesIpv6 = addressFamilyFor(target.host, target.ipVersion) === 6

  return (
    // Selecting a target has to work from the keyboard, so the row is a real
    // interactive element rather than a div with a click handler.
    <div
      role="button"
      tabIndex={floating ? -1 : 0}
      aria-current={selected}
      onClick={() => onSelectTarget?.(target.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelectTarget?.(target.id)
        }
      }}
      className={cn(
        'relative w-full text-left px-2 py-2 rounded-md transition-colors group/target cursor-pointer',
        'hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        floating && selected && 'bg-sidebar-accent'
      )}
    >
      {/* One highlight shared by every row: selecting another target slides
          it there instead of switching one background off and another on. */}
      {selected && !floating && (
        <motion.span
          layoutId="selected-target"
          aria-hidden="true"
          className="absolute inset-0 rounded-md bg-sidebar-accent"
          transition={DRAG_SPRING}
        />
      )}
      <div className="relative flex items-center gap-1.5">
        <button
          type="button"
          tabIndex={floating ? -1 : undefined}
          onPointerDown={e => onHandlePointerDown?.(target.id, e)}
          className={cn(
            'p-0.5 cursor-grab active:cursor-grabbing transition-colors touch-none shrink-0',
            floating
              ? 'text-muted-foreground/70'
              : 'text-muted-foreground/0 group-hover/target:text-muted-foreground/40 hover:text-muted-foreground/70!'
          )}
          aria-label={`Drag to reorder ${target.name}`}
          onClick={e => e.stopPropagation()}
        >
          <GripVertical className="h-3 w-3" />
        </button>
        <StatusIndicator
          isOnline={target.isOnline}
          packetLoss={target.packetLoss}
          note={target.statusNote}
          paused={paused}
        />

        {/* The name owns the full width of the first line; the address and the
            trace share the second. Putting the trace on the same line as the
            name is what pushed the row past the sidebar's width and clipped
            the buttons off the end. */}
        {/* Paused, everything that describes the target goes grey, badges
            included. The buttons beside it do not: resume is one of them. */}
        <div className={cn('min-w-0 flex-1', paused && 'opacity-60 grayscale')}>
          <div className="flex items-center gap-2">
            <span className={cn(
              'min-w-0 truncate text-sm font-medium',
              paused ? 'text-muted-foreground line-through' : 'text-sidebar-foreground'
            )}>
              {target.name}
            </span>
            {target.type && (
              <span className="shrink-0">
                <TypeBadge type={target.type} />
              </span>
            )}
            {paused && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                Paused
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* An IPv6 address rarely fits; the tooltip carries it in full,
                along with where a domain last resolved to. */}
            <span
              className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
              title={target.resolvedAddress ? `${address} → ${target.resolvedAddress}` : address}
            >
              {address}
            </span>
            {/* The family sits with the address it describes, and off the
                name's line, where every badge costs the name some letters. */}
            {(dualStack || usesIpv6) && (
              <span className="flex shrink-0">{dualStack ? <DualStackBadge /> : <Ipv6Badge />}</span>
            )}
            {/* Stays put on hover: the trace is the reason to look at the row,
                so swapping it out for the controls hid the thing being read. */}
            <span className="ml-auto shrink-0">
              <Sparkline points={trace ?? []} width={52} height={16} muted={paused} />
            </span>
          </div>
        </div>

        {/* Reserves its width at all times, so revealing the controls never
            reflows the row or pushes the last button out of bounds. */}
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover/target:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            tabIndex={floating ? -1 : undefined}
            onClick={e => { e.stopPropagation(); onTogglePaused?.(target) }}
            className="cursor-pointer rounded p-0.5 transition-colors hover:bg-muted"
            aria-label={paused ? `Resume ${target.name}` : `Pause ${target.name}`}
          >
            {paused
              ? <Play className="h-3.5 w-3.5 text-muted-foreground" />
              : <Pause className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
          <button
            type="button"
            tabIndex={floating ? -1 : undefined}
            onClick={e => { e.stopPropagation(); onEditTarget?.(target) }}
            className="cursor-pointer rounded p-0.5 transition-colors hover:bg-blue-500/20"
            aria-label={`Edit ${target.name}`}
          >
            <Pencil className="h-3.5 w-3.5 text-blue-500" />
          </button>
          <button
            type="button"
            tabIndex={floating ? -1 : undefined}
            onClick={e => { e.stopPropagation(); onDeleteTarget?.(target.id) }}
            className="cursor-pointer rounded p-0.5 transition-colors hover:bg-destructive/20"
            aria-label={`Delete ${target.name}`}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sortable Target ────────────────────────────────────────────────────────

/**
 * A row in its place in the list.
 *
 * While its target is being dragged the row stays where the drop would put it
 * but shows as an empty slot: the content is hidden rather than removed, so
 * the slot is exactly the height of the row that will fill it. `layout` is
 * what makes neighbouring rows slide rather than jump when the slot moves.
 */
function SortableTarget({ isDragSource, ...row }: TargetRowProps & { isDragSource: boolean }) {
  return (
    <motion.li
      layout="position"
      transition={DRAG_SPRING}
      data-target-id={row.target.id}
      className="relative list-none select-none"
    >
      {isDragSource && (
        <motion.div
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.12 }}
          className="absolute inset-0 rounded-md border border-dashed border-primary/40 bg-primary/5"
        />
      )}
      <div className={cn(isDragSource && 'invisible')}>
        <TargetRow {...row} />
      </div>
    </motion.li>
  )
}

// ─── Drag Overlay ───────────────────────────────────────────────────────────

const SHADOW_RESTING = '0 0 0 0 rgb(0 0 0 / 0)'
const SHADOW_LIFTED = '0 14px 32px -10px rgb(0 0 0 / 0.55)'

/**
 * The copy of a row that follows the pointer. Rendered into the body so no
 * group's `overflow: hidden` can clip it on the way to another group.
 */
function TargetDragOverlay({
  drag,
  x,
  y,
  selected,
  children,
}: {
  drag: ActiveTargetDrag
  x: MotionValue<number>
  y: MotionValue<number>
  selected: boolean
  children: ReactNode
}) {
  const lifted = drag.phase === 'dragging'
  const absorbing = drag.phase === 'absorbing'

  return createPortal(
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-50"
      style={{ x, y, width: drag.width }}
    >
      <motion.div
        // The base is the sidebar's own colour: once the copy has settled it
        // looks exactly like the row about to replace it, so the swap is not
        // visible.
        className="relative rounded-md bg-sidebar"
        initial={{ scale: 1, opacity: 1, boxShadow: SHADOW_RESTING }}
        animate={{
          scale: lifted ? 1.03 : absorbing ? 0.9 : 1,
          opacity: absorbing ? 0 : 1,
          boxShadow: lifted ? SHADOW_LIFTED : SHADOW_RESTING,
        }}
        transition={DRAG_SPRING}
      >
        <motion.div
          className="absolute inset-0 rounded-md bg-sidebar-accent outline-1 outline-sidebar-ring/50"
          initial={{ opacity: selected ? 1 : 0 }}
          animate={{ opacity: lifted || selected ? 1 : 0 }}
          transition={{ duration: 0.15 }}
        />
        <div className="relative">{children}</div>
      </motion.div>
    </motion.div>,
    document.body
  )
}

// ─── Group Tree ─────────────────────────────────────────────────────────────

/** What every group in the tree needs, handed down unchanged from the sidebar. */
interface GroupTreeProps {
  layout: SidebarLayout
  targetsById: Map<string, Target>
  selectedTargetId: string | null
  /** The group whose comparison chart the main pane is showing, if any. */
  selectedGroup: string | null
  series?: Record<string, SparklinePoint[]>
  collapsedGroups: Set<string>
  /** The target drag in progress, if any. */
  drag: ActiveTargetDrag | null
  onToggleCollapse: (group: string) => void
  onCompare?: (group: string) => void
  onEditGroup?: (group: string) => void
  onReorderSubgroups: (parent: string, ordered: string[]) => void
  onGroupDragStart: () => void
  onGroupDragEnd: (parent: string) => void
  onSelectTarget: (id: string) => void
  onEditTarget: (target: Target) => void
  onDeleteTarget: (id: string) => void
  onTogglePaused: (target: Target) => void
  onHandlePointerDown: (id: string, event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * The groups inside one group, or the top level for an empty `parent`.
 *
 * Each level is its own reorderable list, so a group is dragged among its
 * siblings and cannot be dropped out of the group it belongs to by accident.
 * Moving a group somewhere else in the tree is done from its edit dialog.
 */
function GroupList({ parent, ...tree }: GroupTreeProps & { parent: string }) {
  return (
    <Reorder.Group
      axis="y"
      values={subgroups(tree.layout, parent)}
      onReorder={ordered => tree.onReorderSubgroups(parent, ordered)}
      className="space-y-1"
    >
      {subgroups(tree.layout, parent).map(group => (
        <TargetGroup key={group} group={group} parent={parent} {...tree} />
      ))}
    </Reorder.Group>
  )
}

function TargetGroup({ group, parent, ...tree }: GroupTreeProps & { group: string; parent: string }) {
  const {
    layout,
    targetsById,
    selectedTargetId,
    selectedGroup,
    series,
    collapsedGroups,
    drag,
    onToggleCollapse,
    onCompare,
    onEditGroup,
    onGroupDragStart,
    onGroupDragEnd,
    onSelectTarget,
    onEditTarget,
    onDeleteTarget,
    onTogglePaused,
    onHandlePointerDown,
  } = tree
  const dragControls = useDragControls()

  const name = groupName(group)
  const targetIds = layout.items[group] ?? []
  const inside = subgroups(layout, group)
  const isCollapsed = collapsedGroups.has(group)
  const isCompared = selectedGroup === group

  // Everything under the group, not only what sits directly in it: that is
  // what collapsing it hides and what its chart compares.
  const memberIds = useMemo(() => targetsWithin(layout, group), [layout, group])

  // Only worked out while it is on show. Paused targets are left out: their
  // last reading is from whenever they were paused, not from now.
  const groupTrace = useMemo(() => {
    if (!isCollapsed || !series) return null
    const traces = memberIds
      .filter(id => targetsById.get(id)?.status !== 'paused')
      .map(id => series[id] ?? [])
    const combined = combineSeries(traces)
    return combined.length > 1 ? combined : null
  }, [isCollapsed, series, memberIds, targetsById])

  // Highlighted only as a destination: lighting up the group a row was just
  // picked up from says nothing the empty slot does not already say.
  const isDropDestination = !!drag && drag.overGroup === group && drag.originGroup !== group

  return (
    <Reorder.Item
      value={group}
      dragListener={false}
      dragControls={dragControls}
      className="select-none"
      whileDrag={{ scale: 1.02, zIndex: 50 }}
      // Position only. Animating size as well scales the whole group while a
      // row enters or leaves it, which visibly stretches the header text.
      layout="position"
      transition={DRAG_SPRING}
      onDragStart={onGroupDragStart}
      onDragEnd={() => onGroupDragEnd(parent)}
    >
      {/* The header and the group's own rows are what a dragged target is
          dropped on. The groups inside are separate destinations below it, so
          they are deliberately outside this element. */}
      <div
        className={cn(
          'rounded-lg ring-1 ring-transparent transition-[background-color,box-shadow] duration-150',
          isDropDestination && 'bg-primary/5 ring-primary/40',
          isCompared && !isDropDestination && 'bg-sidebar-accent/60 ring-sidebar-ring/40'
        )}
        data-group={group}
      >
        {/* Group Header */}
        <div className="flex items-center gap-1 px-2 py-1.5 group/header">
          <button
            type="button"
            onPointerDown={(e) => dragControls.start(e)}
            className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground transition-colors touch-none"
            aria-label={`Drag to reorder ${name}`}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onToggleCollapse(group)}
            aria-expanded={!isCollapsed}
            className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer"
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {name}
            </span>
          </button>

          {/* Ungrouped is where targets without a group are listed, not a
              group that can be renamed or put inside another. */}
          {onEditGroup && group !== UNGROUPED && (
            <button
              type="button"
              onClick={() => onEditGroup(group)}
              className="shrink-0 cursor-pointer rounded p-0.5 opacity-0 transition-opacity hover:bg-blue-500/20 focus-visible:opacity-100 group-hover/header:opacity-100"
              aria-label={`Rename or move ${name}`}
              title="Rename this group or move it inside another"
            >
              <Pencil className="h-3 w-3 text-blue-500" />
            </button>
          )}

          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {memberIds.length}
          </span>

          {/* A comparison needs at least two lines to compare. Labelled and
              in the accent colour: as a bare grey icon it read as decoration,
              and nobody found the group chart without being told where it was. */}
          {onCompare && memberIds.length > 1 && (
            <button
              type="button"
              onClick={() => onCompare(group)}
              aria-pressed={isCompared}
              aria-label={`Compare the targets in ${name} on one chart`}
              title="Show every target in this group on one chart"
              className={cn(
                'ml-1 flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium leading-none transition-colors',
                isCompared
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-primary/40 bg-primary/10 text-primary hover:border-primary/70 hover:bg-primary/20'
              )}
            >
              <ChartLine className="h-3.5 w-3.5" />
              Compare
            </button>
          )}
        </div>

        {/* Collapsed, the rows that say how the group is doing are hidden, so
            one trace for all of them takes their place. */}
        <AnimatePresence initial={false}>
          {groupTrace && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div
                className="px-2 pb-2"
                title={`${name}: mean latency across its ${memberIds.length} target${memberIds.length === 1 ? '' : 's'}, marked wherever any of them lost packets`}
              >
                <Sparkline points={groupTrace} width={240} height={22} stretch />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Target List */}
        <AnimatePresence initial={false}>
          {!isCollapsed && (targetIds.length > 0 || inside.length === 0) && (
            <motion.div
              // Clipped only while the group is opening or closing. Left
              // clipped, a row sliding up into a group that has just lost one
              // starts outside the shrunken box and is cut off mid-slide.
              initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
              animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
              exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
              transition={{ duration: 0.2 }}
            >
              <ul className="space-y-0.5 ml-1">
                {targetIds.map(targetId => {
                  const target = targetsById.get(targetId)
                  if (!target) return null
                  return (
                    <SortableTarget
                      key={targetId}
                      target={target}
                      selected={selectedTargetId === targetId}
                      trace={series?.[targetId]}
                      isDragSource={drag?.id === targetId}
                      onSelectTarget={onSelectTarget}
                      onEditTarget={onEditTarget}
                      onDeleteTarget={onDeleteTarget}
                      onTogglePaused={onTogglePaused}
                      onHandlePointerDown={onHandlePointerDown}
                    />
                  )
                })}
                {/* Only reachable mid-drag: a group whose last row was carried
                    off, or the Ungrouped zone offered for the drag. Without
                    something to aim at it would be a bare header. */}
                {targetIds.length === 0 && (
                  <motion.li
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                    className="flex h-11 list-none items-center justify-center rounded-md border border-dashed border-border text-[11px] text-muted-foreground"
                  >
                    {group === UNGROUPED ? 'Drop here to remove from its group' : 'Drop here'}
                  </motion.li>
                )}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Groups inside this one, set in from it with a rule down the side so
          the eye can follow which header they belong to. */}
      <AnimatePresence initial={false}>
        {!isCollapsed && inside.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
            animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
            exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
            transition={{ duration: 0.2 }}
          >
            <div className="ml-3 mt-1 border-l border-sidebar-border pl-1">
              <GroupList parent={group} {...tree} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Reorder.Item>
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
  onTogglePaused,
  selectedGroup = null,
  onSelectGroup,
  series,
  groupOrders = [],
  onReorderGroups,
  onMoveGroup,
  alertsOpen = false,
  onOpenAlerts,
  firingAlerts = 0,
  onReorderTargets,
  loading = false,
}: SidebarProps) {
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [editingTarget, setEditingTarget] = useState<Target | null>(null)
  // Held by id, so the dialog always describes the target as it is now and
  // closes by itself if the target goes away underneath it.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [isGroupDragging, setIsGroupDragging] = useState(false)
  const listRef = useRef<HTMLElement>(null)

  const targetsById = useMemo(() => new Map(targets.map(t => [t.id, t])), [targets])

  // The arrangement the server knows about...
  const savedLayout = useMemo(() => buildSidebarLayout(targets, groupOrders), [targets, groupOrders])

  // Every group a target could be put in, including ones that hold only other
  // groups, in the order the sidebar lists them.
  const availableGroups = useMemo(
    () => groupsInOrder(savedLayout).filter(group => group !== UNGROUPED),
    [savedLayout]
  )

  // ...and the one on screen, which runs ahead of it while something is being
  // dragged and is only written back on the drop.
  const [layout, setLayout] = useState<SidebarLayout>(savedLayout)

  const handleTargetDrop = useCallback((dropped: SidebarLayout, id: string, fromGroup: string) => {
    onReorderTargets?.(targetOrderUpdates(dropped, id, fromGroup))
  }, [onReorderTargets])

  const drag = useTargetDrag({
    layout,
    setLayout,
    rootRef: listRef,
    collapsedGroups,
    onDrop: handleTargetDrop,
  })

  // Resync when the saved arrangement changes. Adjusting during render rather
  // than in an effect: React re-runs this component immediately without
  // committing the stale list, so the row order never flashes. Held off for
  // the length of a drag — the target list is re-fetched every 30 seconds, and
  // a refresh landing mid-drag would otherwise snap the row out of the user's
  // hand and back to where it started.
  const [syncedLayout, setSyncedLayout] = useState(savedLayout)
  if (syncedLayout !== savedLayout && !drag.active && !isGroupDragging) {
    setSyncedLayout(savedLayout)
    setLayout(savedLayout)
  }

  // Filter targets by search
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null

    return groupsInOrder(savedLayout)
      .map(group => ({
        group,
        targets: savedLayout.items[group]
          .map(id => targetsById.get(id))
          .filter((t): t is Target =>
            !!t && (t.name.toLowerCase().includes(q) || targetAddressLabel(t).toLowerCase().includes(q))
          ),
      }))
      .filter(group => group.targets.length > 0)
  }, [savedLayout, targetsById, searchQuery])

  const handleGroupReorder = useCallback((parent: string, ordered: string[]) => {
    setLayout(current => reorderSubgroups(current, parent, ordered))
  }, [])

  const handleGroupDragStart = useCallback(() => setIsGroupDragging(true), [])

  // A group is only ever dragged among its siblings, so that one list is all
  // there is to save.
  const handleGroupDragEnd = (parent: string) => {
    setIsGroupDragging(false)
    if (!onReorderGroups) return

    const ordered = subgroups(layout, parent)
    const saved = subgroups(savedLayout, parent)
    if (ordered.some((group, i) => group !== saved[i])) {
      onReorderGroups(ordered.map((group, sortOrder) => ({ groupName: group, sortOrder })))
    }
  }

  const toggleCollapse = useCallback((group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  const handleMoveGroup = (from: string, to: string) => {
    setEditingGroup(null)
    // A group that was folded away stays folded under its new name.
    setCollapsedGroups(prev => new Set([...prev].map(group => rebaseGroupPath(group, from, to))))
    onMoveGroup?.(from, to)
  }

  const openEditDialog = (target: Target) => {
    setEditingTarget(target)
    setIsEditOpen(true)
  }

  // Targets awaiting their first measurement are counted separately rather
  // than lumped in with the offline ones. Paused ones are counted as neither
  // online nor offline: nobody has asked them lately.
  const probed = targets.filter(t => t.status !== 'paused')
  const onlineCount = probed.filter(t => t.isOnline === true).length
  const offlineCount = probed.filter(t => t.isOnline === false).length
  const pendingCount = probed.filter(t => t.isOnline === undefined).length
  const pausedCount = targets.length - probed.length

  const draggedTarget = drag.active ? targetsById.get(drag.active.id) : undefined
  const deletingTarget = deletingId ? targetsById.get(deletingId) ?? null : null

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Header */}
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 mb-3">
          {/* The mark is a miniature trace: the thing the product makes. */}
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent"
            aria-hidden="true"
          >
            <svg viewBox="0 0 20 14" className="h-4 w-5" fill="none">
              <path
                d="M1 9 L4 8 L7 10 L10 3 L13 7 L16 6 L19 6.5"
                stroke="var(--signal-perfect)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-sidebar-foreground">
              ClearPing
            </h1>
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Path monitor
            </p>
          </div>
        </div>

        {/* As tall as it is with the search button in it, which only appears
            past a few targets, so the header is the same height either way. */}
        <div className="flex min-h-5.5 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {/* Not "0 online, 0 offline" while the list is on its way: that
              is a count of nothing, and it reads as everything being gone. */}
          {loading ? (
            <span className="h-3 w-36 animate-pulse rounded bg-muted/50" aria-hidden="true" />
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <StatusIndicator isOnline={true} packetLoss={0} />
                <span className="text-muted-foreground">{onlineCount} online</span>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusIndicator isOnline={false} />
                <span className="text-muted-foreground">{offlineCount} offline</span>
              </div>
            </>
          )}
          {pendingCount > 0 && (
            <div className="flex items-center gap-1.5">
              <StatusIndicator />
              <span className="text-muted-foreground">{pendingCount} pending</span>
            </div>
          )}
          {pausedCount > 0 && (
            <div className="flex items-center gap-1.5">
              <StatusIndicator paused />
              <span className="text-muted-foreground">{pausedCount} paused</span>
            </div>
          )}
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
      {/* `reducedMotion="user"` turns the sliding and springing below into
          plain repositioning for anyone whose system asks for less motion. */}
      <MotionConfig reducedMotion="user">
        {/* The scroll area lays its content out as a table, which grows to fit
            its widest row instead of truncating it. One long URL was enough to
            make every row wider than the sidebar and push the pause, edit and
            delete buttons out past its edge. As a block, rows are held to the
            sidebar's width and long addresses are cut short instead. */}
        <ScrollArea className="flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
          <nav
            ref={listRef}
            // While a row is in the air the list must not react to the pointer
            // passing over it: no hover highlights trailing the drag, and no
            // click landing on whatever happens to be underneath on release.
            className={cn('p-2', drag.active && 'pointer-events-none')}
            aria-label="Targets"
          >
            {loading ? (
              <SidebarSkeleton />
            ) : searchResults ? (
              // Search mode: plain list, no drag
              <div className="space-y-3">
                {searchResults.map(({ group, targets: matches }) => (
                  <div key={group}>
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      {/* The whole path: out of the tree, a name alone does
                          not say which of two same-named groups this is. */}
                      <span className="text-xs font-semibold text-sidebar-foreground uppercase tracking-wider truncate">
                        {groupLabel(group)}
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums bg-muted/50 px-1.5 py-0.5 rounded-full ml-auto">
                        {matches.length}
                      </span>
                    </div>
                    <ul className="space-y-0.5 ml-1">
                      {matches.map(target => (
                        <li key={target.id}>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-current={selectedTargetId === target.id}
                            onClick={() => onSelectTarget(target.id)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                onSelectTarget(target.id)
                              }
                            }}
                            className={cn(
                              'w-full text-left px-3 py-2 rounded-md transition-colors group cursor-pointer',
                              'hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              selectedTargetId === target.id && 'bg-sidebar-accent'
                            )}
                          >
                            <div className="flex items-center gap-2.5">
                              <StatusIndicator
                                isOnline={target.isOnline}
                                packetLoss={target.packetLoss}
                                paused={target.status === 'paused'}
                              />
                              <div className={cn('flex-1 min-w-0', target.status === 'paused' && 'opacity-60 grayscale')}>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-sm text-sidebar-foreground truncate">{target.name}</span>
                                  {target.type && <TypeBadge type={target.type} />}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                                    {targetAddressLabel(target)}
                                  </span>
                                  <span className="ml-auto shrink-0">
                                    <Sparkline
                                      points={series?.[target.id] ?? []}
                                      width={52}
                                      height={16}
                                      muted={target.status === 'paused'}
                                    />
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {searchResults.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-8">No targets found</p>
                )}
              </div>
            ) : (
              // Normal mode: draggable groups
              <GroupList
                parent=""
                layout={layout}
                targetsById={targetsById}
                selectedTargetId={selectedTargetId}
                selectedGroup={selectedGroup}
                series={series}
                collapsedGroups={collapsedGroups}
                drag={drag.active}
                onToggleCollapse={toggleCollapse}
                onCompare={onSelectGroup}
                onEditGroup={onMoveGroup ? setEditingGroup : undefined}
                onReorderSubgroups={handleGroupReorder}
                onGroupDragStart={handleGroupDragStart}
                onGroupDragEnd={handleGroupDragEnd}
                onSelectTarget={onSelectTarget}
                onEditTarget={openEditDialog}
                onDeleteTarget={setDeletingId}
                onTogglePaused={onTogglePaused}
                onHandlePointerDown={drag.onHandlePointerDown}
              />
            )}
          </nav>
        </ScrollArea>

        {drag.active && draggedTarget && (
          <TargetDragOverlay
            drag={drag.active}
            x={drag.x}
            y={drag.y}
            selected={selectedTargetId === draggedTarget.id}
          >
            <TargetRow
              target={draggedTarget}
              selected={selectedTargetId === draggedTarget.id}
              trace={series?.[draggedTarget.id]}
              floating
            />
          </TargetDragOverlay>
        )}
      </MotionConfig>

      {/* Footer actions */}
      <div className="flex gap-2 border-t border-sidebar-border p-3">
        {onOpenAlerts && (
          <Button
            variant={alertsOpen ? 'secondary' : 'outline'}
            size="sm"
            onClick={onOpenAlerts}
            aria-pressed={alertsOpen}
            className="shrink-0"
            suppressHydrationWarning
          >
            <Bell className="h-4 w-4 mr-2" />
            Alerts
            {/* Said here so a firing alert is seen from any screen. */}
            {firingAlerts > 0 && (
              <span className="ml-2 rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                {firingAlerts}
                <span className="sr-only"> firing</span>
              </span>
            )}
          </Button>
        )}
        <Button
          className="min-w-0 flex-1"
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

      <GroupDialog
        group={editingGroup}
        groups={availableGroups}
        onCancel={() => setEditingGroup(null)}
        onSave={handleMoveGroup}
      />

      {/* Nothing is deleted from the row itself: the button there only asks. */}
      <DeleteTargetDialog
        target={deletingTarget}
        onCancel={() => setDeletingId(null)}
        onConfirm={id => { setDeletingId(null); onDeleteTarget(id) }}
        onPause={onTogglePaused}
      />
    </aside>
  )
}
