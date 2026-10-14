'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { cn } from '@/lib/utils'
import type { Target, TargetDefinition, GroupOrder, SparklinePoint } from '@/types/probe'
import { BrandMark } from './brand-mark'
import { VersionBadge } from './version-badge'
import { Sparkline } from './sparkline'
import { SidebarSkeleton } from './skeleton'
import { AddTargetDialog, DeleteTargetDialog, EditTargetDialog } from './target-dialogs'
import { GroupDialog, type GroupDialogTask } from './group-dialog'
import { ShareDialog } from './share-dialog'
import { DeleteTargetsDialog } from './delete-targets-dialog'
import { useIncomingShareCode } from './use-incoming-share-code'
import { DualStackBadge, Ipv6Badge, TypeBadge } from './target-badges'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusIndicator } from './status-indicator'
import { addressFamilyFor, isDualStack } from '@/lib/host'
import { targetAddressLabel } from '@/lib/probe-config'
import { groupLabel, groupName, groupWithAncestors, normalizeGroupPath, rebaseGroupPath } from '@/lib/group-path'
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
import {
  Reorder,
  useDragControls,
  useReducedMotion,
  AnimatePresence,
  MotionConfig,
  motion,
  type MotionValue,
  type TargetAndTransition,
} from 'framer-motion'
import {
  Plus,
  GripVertical,
  Pencil,
  Copy,
  Share2,
  FolderPlus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Search,
  Pause,
  Play,
  ChartLine,
  Bell,
  ListX,
  MoreVertical,
  PanelLeftClose,
  Settings,
  X,
} from 'lucide-react'
import { SidebarRail } from './sidebar-rail'
import { SIDEBAR_COLLAPSE_BUTTON_ID } from './use-sidebar-drawer'

// ─── Collapsing ─────────────────────────────────────────────────────────────

/** The sidebar's two widths on a wide screen: `w-80`, and `w-14` as a rail. */
const FULL_WIDTH = '320px'
const RAIL_WIDTH = '56px'

/**
 * How the sidebar folds down to its rail and back.
 *
 * The width takes the whole of the time, quick off the mark and easing to a
 * stop, with no overshoot: the page beside it is resized on every frame, and
 * a width that bounced would bounce every chart on it. What is inside changes
 * over within that time. Going down, the full contents are gone early and the
 * rail arrives as the width settles; coming back, the rail goes at once and
 * the contents follow the edge out.
 */
const COLLAPSE_TRANSITION = { duration: 0.34, ease: [0.32, 0.72, 0, 1] } as const
const CONTENT_OUT = { duration: 0.16, ease: 'easeIn' } as const
const CONTENT_IN = { duration: 0.26, delay: 0.08, ease: [0.2, 0, 0, 1] } as const
const RAIL_IN = { duration: 0.2, delay: 0.14, ease: 'easeOut' } as const
const RAIL_OUT = { duration: 0.1, ease: 'easeIn' } as const
/** For anyone whose system asks for less motion: the same change, without the travel. */
const INSTANT = { duration: 0 } as const

// ─── Folded groups ──────────────────────────────────────────────────────────

/** Where it is remembered which groups were left folded away. */
const COLLAPSED_GROUPS_KEY = 'collapsedGroups'

function readCollapsedGroups(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]')
    if (!Array.isArray(stored)) return new Set()
    return new Set(stored.filter((group): group is string => typeof group === 'string'))
  } catch {
    return new Set()
  }
}

function saveCollapsedGroups(groups: Set<string>) {
  try {
    if (groups.size > 0) localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]))
    else localStorage.removeItem(COLLAPSED_GROUPS_KEY)
  } catch {
    // Not remembered for next time; it still changes now.
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  /**
   * On a narrow screen the sidebar is a drawer over the page, and this is
   * whether it is out. Beside the page, on a wide screen, it means nothing.
   */
  open?: boolean
  onClose?: () => void
  /**
   * On a wide screen, where the sidebar sits beside the page: whether it is
   * folded down to a rail of icons, and the two ways of changing that.
   */
  collapsed?: boolean
  onCollapse?: () => void
  onExpand?: () => void
  targets: Target[]
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  /** Resolves to the target as it was created, or null if it was not. */
  onAddTarget: (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => Promise<Target | null>
  /** Add the targets out of a share link. Resolves to whether they were added. */
  onImportTargets: (targets: TargetDefinition[]) => Promise<boolean>
  /** Delete several at once. Resolves to whether they were deleted. */
  onDeleteTargets: (ids: string[]) => Promise<boolean>
  onUpdateTarget: (id: string, updates: Partial<Target>) => void
  onDeleteTarget: (id: string) => void
  onTogglePaused: (target: Target) => void
  /** The group whose comparison chart is on screen, if one is. */
  selectedGroup?: string | null
  onSelectGroup?: (groupName: string) => void
  series?: Record<string, SparklinePoint[]>
  /** Every group there is, as paths, including the ones with nothing in them. */
  groups?: string[]
  groupOrders?: GroupOrder[]
  onReorderGroups?: (groups: GroupOrder[]) => void
  /** Make a group, with nothing in it yet. */
  onCreateGroup?: (group: string) => void
  /** Delete a group and keep what was in it. */
  onDeleteGroup?: (group: string) => void
  /** Rename a group or move it inside another: its path changes from one to the other. */
  onMoveGroup?: (from: string, to: string) => void
  /** Whether the alerts screen is what the main pane is showing. */
  alertsOpen?: boolean
  onOpenAlerts?: () => void
  /** How many alerts are firing on at least one target. */
  firingAlerts?: number
  /** Whether Settings is what the main pane is showing. */
  settingsOpen?: boolean
  onOpenSettings?: () => void
  onReorderTargets?: (updates: { id: string; sortOrder: number; group?: string }[]) => void
  /** The targets have not arrived yet: there is no list to show and nothing to count. */
  loading?: boolean
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
  onDuplicateTarget?: (target: Target) => void
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
  onDuplicateTarget,
  onDeleteTarget,
  onTogglePaused,
  onHandlePointerDown,
}: TargetRowProps) {
  const paused = target.status === 'paused'
  const address = targetAddressLabel(target)
  const dualStack = isDualStack(target.host, target.ipVersion)
  const usesIpv6 = addressFamilyFor(target.host, target.ipVersion) === 6
  // On a touchscreen: whether the row's actions are set out underneath it.
  const [actionsOpen, setActionsOpen] = useState(false)

  const actions = [
    {
      label: paused ? 'Resume' : 'Pause',
      icon: paused ? Play : Pause,
      tone: 'text-muted-foreground',
      hover: 'hover:bg-muted',
      run: () => onTogglePaused?.(target),
    },
    { label: 'Edit', icon: Pencil, tone: 'text-blue-500', hover: 'hover:bg-blue-500/20', run: () => onEditTarget?.(target) },
    {
      label: 'Duplicate',
      icon: Copy,
      tone: 'text-muted-foreground',
      hover: 'hover:bg-muted',
      run: () => onDuplicateTarget?.(target),
    },
    {
      label: 'Delete',
      icon: Trash2,
      tone: 'text-destructive',
      hover: 'hover:bg-destructive/20',
      run: () => onDeleteTarget?.(target.id),
    },
  ]

  return (
    // Selecting a target has to work from the keyboard, so the row is a real
    // interactive element rather than a div with a click handler.
    <div
      role="button"
      tabIndex={floating ? -1 : 0}
      aria-current={selected}
      onClick={() => onSelectTarget?.(target.id)}
      onKeyDown={e => {
        // Only a key pressed on the row itself. One pressed on a button
        // inside it is that button's, and taking it here selected the target
        // instead of pausing, editing or deleting it.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelectTarget?.(target.id)
        }
      }}
      className={cn(
        'relative w-full text-left px-2 py-2 rounded-md transition-colors group/target cursor-pointer',
        'hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // The selected row is simply the one that is lit. The highlight used
        // to be one shared element that slid from the old row to the new one,
        // which read as something chasing the click down the list, and went
        // astray altogether when the list itself was moving: a group
        // collapsing, or the drawer sliding shut on a phone.
        selected && 'bg-sidebar-accent'
      )}
    >
      <div className="relative flex items-center gap-1.5">
        <button
          type="button"
          tabIndex={floating ? -1 : undefined}
          onPointerDown={e => {
            // The drag measures the row as it picks it up, and the copy that
            // follows the finger has no actions under it: put them away first.
            if (actionsOpen) flushSync(() => setActionsOpen(false))
            onHandlePointerDown?.(target.id, e)
          }}
          className={cn(
            'p-0.5 cursor-grab active:cursor-grabbing transition-colors touch-none shrink-0 touch:px-1 touch:py-2',
            // Hovering is what shows the handle, so where nothing can hover
            // it is simply shown.
            floating
              ? 'text-muted-foreground/70'
              : 'text-muted-foreground/0 group-hover/target:text-muted-foreground/40 hover:text-muted-foreground/70! touch:text-muted-foreground/40'
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
              data-tip={target.resolvedAddress ? `${address} → ${target.resolvedAddress}` : address}
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
            reflows the row or pushes the last button out of bounds. Two by
            two, which the row's two lines have the height for: four in a line
            took their width out of the address, and inside a nested group
            that left an IP address cut short. */}
        <div className="grid shrink-0 grid-cols-2 gap-0.5 opacity-0 transition-opacity group-hover/target:opacity-100 focus-within:opacity-100 touch:hidden">
          {actions.map(action => (
            <button
              key={action.label}
              type="button"
              tabIndex={floating ? -1 : undefined}
              onClick={e => { e.stopPropagation(); action.run() }}
              className={cn('cursor-pointer rounded p-0.5 transition-colors', action.hover)}
              aria-label={`${action.label} ${target.name}`}
            >
              <action.icon className={cn('h-3.5 w-3.5', action.tone)} />
            </button>
          ))}
        </div>

        {/* A touchscreen has no hover to reveal those four, and side by side
            at that size a finger aiming for edit lands on delete. There they
            are one button, which sets them out underneath at a size that can
            be pressed. */}
        <button
          type="button"
          tabIndex={floating ? -1 : undefined}
          onClick={e => { e.stopPropagation(); setActionsOpen(open => !open) }}
          aria-expanded={actionsOpen}
          aria-label={`Actions for ${target.name}`}
          className="hidden shrink-0 cursor-pointer rounded p-2 text-muted-foreground touch:block"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </div>

      {actionsOpen && !floating && (
        // Two by two: four across, with their names, is wider than a phone's drawer.
        <div className="relative mt-1.5 hidden grid-cols-2 gap-1.5 touch:grid">
          {actions.map(action => (
            <button
              key={action.label}
              type="button"
              onClick={e => { e.stopPropagation(); setActionsOpen(false); action.run() }}
              className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-sidebar-border bg-sidebar px-2 py-2 text-xs font-medium text-sidebar-foreground"
            >
              <action.icon className={cn('h-3.5 w-3.5', action.tone)} />
              {action.label}
            </button>
          ))}
        </div>
      )}
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
  /** Make a new group inside this one. */
  onAddGroupInside?: (group: string) => void
  /** Add a target straight into this group. */
  onAddTargetTo: (group: string) => void
  onReorderSubgroups: (parent: string, ordered: string[]) => void
  onGroupDragStart: () => void
  onGroupDragEnd: (parent: string) => void
  onSelectTarget: (id: string) => void
  onEditTarget: (target: Target) => void
  onDuplicateTarget: (target: Target) => void
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
    onAddGroupInside,
    onAddTargetTo,
    onGroupDragStart,
    onGroupDragEnd,
    onSelectTarget,
    onEditTarget,
    onDuplicateTarget,
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
            className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground transition-colors touch-none touch:px-1 touch:py-2"
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

          {/* Nesting, as a button on the group that is to hold the new one:
              no path to type, and no doubt about where it will land. */}
          {onAddGroupInside && group !== UNGROUPED && (
            <button
              type="button"
              onClick={() => onAddGroupInside(group)}
              className="shrink-0 cursor-pointer rounded p-0.5 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover/header:opacity-100 touch:p-2 touch:opacity-100"
              aria-label={`New group inside ${name}`}
              data-tip="New group inside this one"
            >
              <FolderPlus className="h-3 w-3 text-muted-foreground" />
            </button>
          )}

          {/* Ungrouped is where targets without a group are listed, not a
              group that can be renamed or put inside another. */}
          {onEditGroup && group !== UNGROUPED && (
            <button
              type="button"
              onClick={() => onEditGroup(group)}
              className="shrink-0 cursor-pointer rounded p-0.5 opacity-0 transition-opacity hover:bg-blue-500/20 focus-visible:opacity-100 group-hover/header:opacity-100 touch:p-2 touch:opacity-100"
              aria-label={`Rename, move or delete ${name}`}
              data-tip="Rename this group, move it inside another, or delete it"
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
              data-tip="Show every target in this group on one chart"
              className={cn(
                'ml-1 flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium leading-none transition-colors touch:py-2',
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
                data-tip={`${name}: mean latency across its ${memberIds.length} target${memberIds.length === 1 ? '' : 's'}, marked wherever any of them lost packets`}
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
                      onDuplicateTarget={onDuplicateTarget}
                      onDeleteTarget={onDeleteTarget}
                      onTogglePaused={onTogglePaused}
                      onHandlePointerDown={onHandlePointerDown}
                    />
                  )
                })}
                {/* A group with nothing in it yet, or the Ungrouped zone
                    offered for a drag. Mid-drag it is something to aim at;
                    otherwise it says how the group gets filled, so a group
                    that was just made is not a bare header. */}
                {targetIds.length === 0 && (
                  <motion.li
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                    className="flex min-h-11 list-none flex-wrap items-center justify-center gap-x-1 rounded-md border border-dashed border-border px-2 py-1.5 text-center text-[11px] text-muted-foreground"
                  >
                    {group === UNGROUPED ? (
                      'Drop here to remove from its group'
                    ) : drag ? (
                      'Drop here'
                    ) : (
                      <>
                        Empty. Drag a target here, or
                        <button
                          type="button"
                          onClick={() => onAddTargetTo(group)}
                          className="cursor-pointer font-medium text-primary underline-offset-2 hover:underline touch:py-1.5"
                        >
                          add one
                        </button>
                      </>
                    )}
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
  open = false,
  onClose,
  collapsed = false,
  onCollapse,
  onExpand,
  targets,
  selectedTargetId,
  onSelectTarget,
  onAddTarget,
  onImportTargets,
  onDeleteTargets,
  onUpdateTarget,
  onDeleteTarget,
  onTogglePaused,
  selectedGroup = null,
  onSelectGroup,
  series,
  groups = [],
  groupOrders = [],
  onReorderGroups,
  onCreateGroup,
  onDeleteGroup,
  onMoveGroup,
  alertsOpen = false,
  onOpenAlerts,
  firingAlerts = 0,
  settingsOpen = false,
  onOpenSettings,
  onReorderTargets,
  loading = false,
}: SidebarProps) {
  const [isAddOpen, setIsAddOpen] = useState(false)
  // The target the add dialog starts from, when it was opened to duplicate
  // one. Left in place on close, so the dialog does not turn into a blank
  // form on its way out, and cleared when it is next opened for a new target.
  const [duplicating, setDuplicating] = useState<Target | null>(null)
  // The group a new target starts in, when it was added from inside one.
  const [addingTo, setAddingTo] = useState('')
  const [isShareOpen, setIsShareOpen] = useState(false)
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false)
  const [incomingShareCode, clearIncomingShareCode] = useIncomingShareCode()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [editingTarget, setEditingTarget] = useState<Target | null>(null)
  // Held by id, so the dialog always describes the target as it is now and
  // closes by itself if the target goes away underneath it.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [groupTask, setGroupTask] = useState<GroupDialogTask | null>(null)
  // Read once, lazily, from what was left last time. Nothing is drawn from it
  // until the targets have loaded, so the server knowing none of it is no
  // mismatch.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(readCollapsedGroups)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [isGroupDragging, setIsGroupDragging] = useState(false)
  const listRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const reduceMotion = useReducedMotion()

  // Opened as a drawer, the keyboard goes with it: focus left on the button
  // that opened it would be on a page that can no longer be used.
  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  const targetsById = useMemo(() => new Map(targets.map(t => [t.id, t])), [targets])

  // The arrangement the server knows about...
  const savedLayout = useMemo(() => buildSidebarLayout(targets, groupOrders, groups), [targets, groupOrders, groups])

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
    const next = new Set(collapsedGroups)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    setCollapsedGroups(next)
    saveCollapsedGroups(next)
  }, [collapsedGroups])

  /** Fold a group away or open it up, and remember which. */
  const setCollapsed = (next: Set<string>) => {
    setCollapsedGroups(next)
    saveCollapsedGroups(next)
  }

  const handleCreateGroup = (group: string) => {
    setGroupTask(null)
    // Made inside a group that is folded away, it would appear nowhere.
    const hidden = groupWithAncestors(group).filter(ancestor => collapsedGroups.has(ancestor))
    if (hidden.length > 0) setCollapsed(new Set([...collapsedGroups].filter(folded => !hidden.includes(folded))))
    onCreateGroup?.(group)
  }

  const handleDeleteGroup = (group: string) => {
    setGroupTask(null)
    onDeleteGroup?.(group)
  }

  const openEditGroup = (group: string) => {
    setGroupTask({
      kind: 'edit',
      group,
      targets: targetsWithin(savedLayout, group).length,
      groups: groupsInOrder(savedLayout, group).length,
    })
  }

  const handleMoveGroup = (from: string, to: string) => {
    setGroupTask(null)
    // A group that was folded away stays folded under its new name.
    const moved = new Set([...collapsedGroups].map(group => rebaseGroupPath(group, from, to)))
    setCollapsedGroups(moved)
    saveCollapsedGroups(moved)
    onMoveGroup?.(from, to)
  }

  const openEditDialog = (target: Target) => {
    setEditingTarget(target)
    setIsEditOpen(true)
  }

  const openAddDialog = (template: Target | null = null, group = '') => {
    setDuplicating(template)
    setAddingTo(group)
    setIsAddOpen(true)
  }

  // A copy goes directly under what it was copied from, as long as it was
  // left in the same group: at the far end of a long group it would look as
  // though nothing had happened.
  const addDuplicate = async (source: Target, copy: Parameters<SidebarProps['onAddTarget']>[0]) => {
    const created = await onAddTarget(copy)
    const group = normalizeGroupPath(source.group)
    if (!created || normalizeGroupPath(created.group) !== group) return

    const siblings = (savedLayout.items[group || UNGROUPED] ?? []).filter(id => id !== created.id)
    const position = siblings.indexOf(source.id)
    if (position === -1) return

    const ordered = [...siblings.slice(0, position + 1), created.id, ...siblings.slice(position + 1)]
    onReorderTargets?.(ordered.map((id, sortOrder) => ({ id, sortOrder })))
  }

  const closeShareDialog = () => {
    setIsShareOpen(false)
    // Dealt with, whichever way: a refresh should not bring the import back.
    clearIncomingShareCode()
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
    <>
    {/* What is behind the drawer, dimmed. Pressing it puts the drawer away. */}
    <div
      aria-hidden="true"
      onClick={onClose}
      className={cn(
        'fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 lg:hidden',
        open ? 'opacity-100' : 'pointer-events-none opacity-0'
      )}
    />
    <motion.aside
      id="sidebar"
      // Beside the page it can be collapsed to a rail of icons, which gives
      // the page its width. What is animated is the width itself, as a
      // variable that only the wide layout reads: under `lg` the same element
      // is the drawer, whose width is not this one's to set.
      initial={false}
      animate={{ '--sidebar-width': collapsed ? RAIL_WIDTH : FULL_WIDTH } as TargetAndTransition}
      transition={reduceMotion ? INSTANT : COLLAPSE_TRANSITION}
      className={cn(
        'flex h-full w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar pt-(--safe-top) pl-(--safe-left)',
        // Clipped while it is wide, so that as it narrows its contents are
        // cut off at the edge instead of being squeezed.
        'lg:relative lg:w-[var(--sidebar-width,20rem)] lg:overflow-hidden',
        // Collapsed from the first paint, when it was left that way: see
        // `sidebar-collapsed` in globals.css.
        'lg:sidebar-collapsed:w-14',
        // Under `lg` there is no room to keep it beside the page, so it is a
        // drawer that slides over it. Hidden as well as moved off screen when
        // it is shut, or its buttons could still be tabbed to and read out.
        'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:w-[min(22rem,calc(100vw-2.5rem))] max-lg:shadow-2xl',
        // Hiding waits for the slide out to finish. Showing must not wait for
        // anything: the drawer takes the keyboard's focus as it opens, and
        // nothing that is still hidden can be given it.
        'max-lg:duration-200',
        open
          ? 'max-lg:transition-[translate]'
          : 'max-lg:invisible max-lg:-translate-x-full max-lg:transition-[translate,visibility]'
      )}
    >
      {/* Everything the sidebar shows at full width. Collapsing fades it out
          where it stands, at the width it was: it is kept, not taken away, so
          the list comes back scrolled to where it was left. Inert while it is
          faded, so nothing in it can be pressed, tabbed to or read out from
          under the rail that has taken its place. */}
      <motion.div
        initial={false}
        animate={collapsed ? { opacity: 0, x: -16 } : { opacity: 1, x: 0 }}
        transition={reduceMotion ? INSTANT : collapsed ? CONTENT_OUT : CONTENT_IN}
        inert={collapsed}
        className="flex min-h-0 flex-1 flex-col lg:min-w-[calc(20rem-1px)] lg:sidebar-collapsed:hidden"
      >
      {/* Header */}
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 mb-3">
          <BrandMark />
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-sidebar-foreground">
              ClearPing
            </h1>
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Path monitor
              <VersionBadge />
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="-mr-1.5 ml-auto flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:hidden"
            aria-label="Close targets"
          >
            <X className="h-4 w-4" />
          </button>
          {onCollapse && (
            <button
              id={SIDEBAR_COLLAPSE_BUTTON_ID}
              type="button"
              onClick={onCollapse}
              className="-mr-1.5 ml-auto hidden size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:flex"
              aria-label="Collapse sidebar"
              data-tip="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
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
          <div className="ml-auto flex items-center gap-0.5">
            {/* One target is deleted from its own row. This is for clearing
                out several, so it is not there until there are several. */}
            {targets.length > 1 && (
              <button
                type="button"
                onClick={() => setIsBulkDeleteOpen(true)}
                className="p-1 hover:bg-sidebar-accent rounded transition-colors cursor-pointer touch:-my-1.5 touch:p-2.5"
                aria-label="Delete several targets"
                data-tip="Delete several targets"
              >
                <ListX className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
            {targets.length > 4 && (
              <button
                type="button"
                onClick={() => { setShowSearch(!showSearch); if (showSearch) setSearchQuery('') }}
                className="p-1 hover:bg-sidebar-accent rounded transition-colors cursor-pointer touch:-my-1.5 touch:p-2.5"
                aria-label="Search targets"
                data-tip="Search targets"
              >
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
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
        {/* `min-h-0`: without it the list will not be made shorter than its
            rows, so where they do not all fit (a phone, a phone on its side)
            it ran off the bottom of the screen, took the buttons under it
            along, and had nothing to scroll. */}
        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overscroll-contain [&_[data-slot=scroll-area-viewport]>div]:block!">
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
                      <span className="font-mono text-[10px] text-muted-foreground tabular-nums bg-muted/50 px-1.5 py-0.5 rounded-full ml-auto">
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
              <>
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
                onEditGroup={onMoveGroup ? openEditGroup : undefined}
                onAddGroupInside={onCreateGroup ? parent => setGroupTask({ kind: 'create', parent }) : undefined}
                onAddTargetTo={group => openAddDialog(null, group)}
                onReorderSubgroups={handleGroupReorder}
                onGroupDragStart={handleGroupDragStart}
                onGroupDragEnd={handleGroupDragEnd}
                onSelectTarget={onSelectTarget}
                onEditTarget={openEditDialog}
                onDuplicateTarget={openAddDialog}
                onDeleteTarget={setDeletingId}
                onTogglePaused={onTogglePaused}
                onHandlePointerDown={drag.onHandlePointerDown}
              />
              {/* Where the next group would go, and so where the way to make
                  one is. A group is made here first and filled afterwards. */}
              {onCreateGroup && (
                <button
                  type="button"
                  onClick={() => setGroupTask({ kind: 'create', parent: '' })}
                  className="mt-2 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-sidebar-border px-2 py-2 text-xs text-muted-foreground transition-colors hover:border-sidebar-ring/50 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:py-3"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  New group
                </button>
              )}
              </>
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
      <div className="border-t border-sidebar-border p-3 pb-[calc(0.75rem+var(--safe-bottom))]">
        <div className="flex gap-2">
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
          onClick={() => openAddDialog()}
          suppressHydrationWarning
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Target
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setIsShareOpen(true)}
          aria-label="Share or import targets"
          data-tip="Share or import targets"
          suppressHydrationWarning
        >
          <Share2 className="h-4 w-4" />
        </Button>
        {/* Everything that is set up rather than monitored, in one place:
            sign-in, keys, single sign-on, accounts, the activity record, and
            connecting an AI assistant. */}
        <Button
          variant={settingsOpen ? 'secondary' : 'outline'}
          size="icon-sm"
          onClick={() => onOpenSettings?.()}
          aria-pressed={settingsOpen}
          aria-label="Settings"
          data-tip="Settings"
          data-tip-detail="Security, keys and AI assistants"
          suppressHydrationWarning
        >
          <Settings className="h-4 w-4" />
        </Button>
        </div>
      </div>
      </motion.div>

      {/* The rail comes in over the left edge as the full width fades, and
          goes as it returns. */}
      <AnimatePresence initial={false}>
        {collapsed && (
          <motion.div
            key="rail"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0, transition: reduceMotion ? INSTANT : RAIL_IN }}
            exit={{ opacity: 0, transition: reduceMotion ? INSTANT : RAIL_OUT }}
            className="absolute inset-y-0 left-0 flex w-14 flex-col pt-(--safe-top)"
          >
            <SidebarRail
              layout={savedLayout}
              targetsById={targetsById}
              selectedTargetId={selectedTargetId}
              selectedGroup={selectedGroup}
              onSelectTarget={onSelectTarget}
              onSelectGroup={onSelectGroup}
              onExpand={onExpand}
              alertsOpen={alertsOpen}
              onOpenAlerts={onOpenAlerts}
              firingAlerts={firingAlerts}
              onShare={() => setIsShareOpen(true)}
              settingsOpen={settingsOpen}
              onOpenSettings={() => onOpenSettings?.()}
              onAddTarget={() => openAddDialog()}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add Target Dialog */}
      <AddTargetDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        onAddTarget={target => (duplicating ? addDuplicate(duplicating, target) : onAddTarget(target))}
        availableGroups={availableGroups}
        template={duplicating}
        group={addingTo}
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
        task={groupTask}
        groups={availableGroups}
        onCancel={() => setGroupTask(null)}
        onCreate={handleCreateGroup}
        onMove={handleMoveGroup}
        onDelete={handleDeleteGroup}
      />

      {/* Arriving by a share link opens it at the import, but not before the
          targets have loaded: until then it cannot say which of the incoming
          ones are already here. */}
      <ShareDialog
        open={isShareOpen || (incomingShareCode !== null && !loading)}
        onOpenChange={open => { if (open) setIsShareOpen(true); else closeShareDialog() }}
        existing={targets}
        groupOrders={groupOrders}
        incomingCode={incomingShareCode}
        onImport={async imported => {
          const added = await onImportTargets(imported)
          if (added) closeShareDialog()
          return added
        }}
      />

      <DeleteTargetsDialog
        open={isBulkDeleteOpen}
        onOpenChange={setIsBulkDeleteOpen}
        targets={targets}
        groupOrders={groupOrders}
        onDelete={onDeleteTargets}
      />

      {/* Nothing is deleted from the row itself: the button there only asks. */}
      <DeleteTargetDialog
        target={deletingTarget}
        onCancel={() => setDeletingId(null)}
        onConfirm={id => { setDeletingId(null); onDeleteTarget(id) }}
        onPause={onTogglePaused}
      />
    </motion.aside>
    </>
  )
}
