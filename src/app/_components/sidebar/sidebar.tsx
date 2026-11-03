'use client'

import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import type { Target, TargetDefinition, GroupOrder, SparklinePoint } from '@/types/probe'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import { BrandMark } from '../shell/brand-mark'
import { SearchResults } from '@/components/search-results'
import { UpdateNotice, useVersionStatus, VersionBadge } from './version-badge'
import { Sparkline } from './sparkline'
import { SidebarSkeleton } from '../dashboard/skeleton'
import { DeleteTargetDialog } from '../targets/target-dialogs'
import { GroupDialog, type GroupDialogTask } from './group-dialog'
import { ShareDialog } from './share-dialog'
import { DeleteTargetsDialog } from './delete-targets-dialog'
import { useIncomingShareCode } from './use-incoming-share-code'
import { DualStackBadge, Ipv6Badge, TypeBadge } from '../targets/target-badges'
import { Badge, type BadgeTone } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover'
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area'
import { SearchField } from '@/components/arc/search-field/search-field'
import { Select } from '@/components/arc/select/select'
import { matchesProbeFrom, ProbedFrom, type ProbeFromFilter } from '../targets/probed-from'
import { ThemeSwitch } from '@/components/arc/theme-switch/theme-switch'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { useTheme } from '../shell/use-theme'
import { useToast } from '@/components/notifications'
import { copyText } from '@/lib/clipboard'
import { StatusIndicator } from './status-indicator'
import { addressFamilyFor, isDualStack } from '@/lib/probes/host'
import { targetAddressLabel } from '@/lib/probes/config'
import { probeIdsOf } from '@/lib/targets/probes'
import { DEFAULT_LOCAL_PROBE_NAME } from '@/types/probe-agent'
import { MAX_GROUP_PATH_LENGTH, groupLabel, groupName, groupWithAncestors, isWithinGroup, joinGroupPath, parentGroup, rebaseGroupPath } from '@/lib/targets/group-path'
import { combineSeries } from '@/lib/charts/group-series'
import {
  UNGROUPED,
  buildSidebarLayout,
  groupsInOrder,
  reorderSubgroups,
  subgroups,
  targetOrderUpdates,
  targetsWithin,
  type SidebarLayout,
} from '@/lib/targets/sidebar-layout'
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
} from 'motion/react'
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
  Pause,
  Play,
  ChartLine,
  Bell,
  ClipboardCopy,
  LayoutDashboard,
  ListX,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  Settings,
  X,
} from 'lucide-react'
import { SidebarRail } from './sidebar-rail'
import { SIDEBAR_COLLAPSE_BUTTON_ID, useSidebarCollapsed } from './use-sidebar-drawer'
import { Masked } from '../privacy/masked'

/** What a grey dot says for a closed-port check that has never had an answer. */
const NEVER_ANSWERED = 'No answer yet: this server does not answer the closed-port check, so it cannot be measured this way'

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

/**
 * The buttons beside the theme switch, shaped like it: a 38px square with
 * rounded corners, rather than the wider pill a button is by default. Set as a
 * style because Arc's module outranks a class.
 */
const HEADER_BUTTON = { width: 38, minWidth: 38, height: 38, minHeight: 38, padding: 0, borderRadius: 12 } as const

/**
 * A group's panel, by how deep it sits: a group at the top is a step off the
 * sidebar, and one inside it a step further. Deeper down they take turns, so
 * every group stands out from the one around it. With no panel of their own,
 * groups and the groups inside them ran together on the sidebar's colour.
 */
const GROUP_PANEL = [
  'rounded-xl border border-sidebar-group-border bg-sidebar-group',
  'rounded-lg border border-sidebar-group-border bg-sidebar-group-nested',
] as const

/** How the target on show is marked in the list. */
const SELECTED_ROW = 'bg-primary/20 ring-1 ring-inset ring-primary/50 hover:bg-primary/25'

/** One of the pages beside the list, as a tile with its icon in a well. */
function PageTile({
  icon,
  label,
  open,
  onOpen,
  off,
  count,
  countLabel,
}: {
  icon: ReactNode
  label: string
  open: boolean
  /** Without it, while off, the tile cannot be pressed. */
  onOpen?: () => void
  /** Why it is greyed out, when it is turned off: said in its tooltip. */
  off?: string
  /** Something there wants a look: shown as a count in the warning colour. */
  count?: number
  countLabel?: string
}) {
  const tile = (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      aria-current={open ? 'page' : undefined}
      aria-label={off ? `${label}: ${off}` : undefined}
      className={cn(
        'flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left text-sm font-medium transition-colors',
        off
          ? 'border-dashed border-sidebar-border text-muted-foreground'
          : open
            ? 'border-primary/60 bg-primary/15 text-sidebar-foreground hover:bg-primary/20'
            : 'border-sidebar-border bg-sidebar-group text-sidebar-foreground hover:border-sidebar-group-border hover:bg-sidebar-row-hover',
        onOpen ? 'cursor-pointer' : 'cursor-not-allowed',
        off && onOpen && 'hover:bg-sidebar-row-hover'
      )}
      suppressHydrationWarning
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
          off ? 'bg-muted text-muted-foreground' : open ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      {/* Off, it says so in its tooltip: a tag beside the name cut the name short. */}
      {!off && count !== undefined && (
        <span className="ml-auto rounded-full bg-signal-moderate/15 px-1.5 font-mono text-[10px] tabular-nums text-signal-moderate" aria-label={countLabel}>
          {count}
        </span>
      )}
    </button>
  )
  // A disabled button gives a tooltip nothing to hang on: the span does.
  return off ? (
    <Tooltip content={off}>
      <span className="flex min-w-0">{tile}</span>
    </Tooltip>
  ) : (
    tile
  )
}

/**
 * One count of how the targets stand, as a badge with a dot of its colour.
 * Where the word alone does not say why, the tooltip does.
 */
function StatusCount({ count, label, tone = 'neutral', why }: { count: number; label: string; tone?: BadgeTone; why?: string }) {
  const badge = (
    <Badge size="sm" tone={tone} icon={<span className="size-1.5 rounded-full bg-current" />}>
      {`${count} ${label}`}
    </Badge>
  )
  return why ? <Tooltip content={why}><span className="flex">{badge}</span></Tooltip> : badge
}

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

/** How far the sidebar's edge moves, and for how long: the page beside it is held still for that long. */
export const SIDEBAR_FOLD_PX = parseInt(FULL_WIDTH) - parseInt(RAIL_WIDTH)
export const SIDEBAR_FOLD_MS = COLLAPSE_TRANSITION.duration * 1000 + 40
const CONTENT_OUT = { duration: 0.16, ease: 'easeIn' } as const
const CONTENT_IN = { duration: 0.26, delay: 0.08, ease: [0.2, 0, 0, 1] } as const
const RAIL_IN = { duration: 0.2, delay: 0.14, ease: 'easeOut' } as const
const RAIL_OUT = { duration: 0.1, ease: 'easeIn' } as const
/** For anyone whose system asks for less motion: the same change, without the travel. */
const INSTANT = { duration: 0 } as const

/**
 * The sidebar's frame, and its folding down to a rail and back.
 *
 * The only part that knows whether it is folded: the full contents and the
 * rail are handed in already made, so folding redraws this frame and not the
 * list inside it, which took long enough to redraw that the fold sat still
 * for a moment before it moved.
 */
function SidebarFold({ className, full, rail, children }: { className: string; full: ReactNode; rail: ReactNode; children: ReactNode }) {
  const collapsed = useSidebarCollapsed()
  const reduceMotion = useReducedMotion()
  return (
    <motion.aside
      id="sidebar"
      // Beside the page it can be collapsed to a rail of icons, which gives
      // the page its width. What is animated is the width itself, as a
      // variable that only the wide layout reads: under `lg` the same element
      // is the drawer, whose width is not this one's to set.
      initial={false}
      animate={{ '--sidebar-width': collapsed ? RAIL_WIDTH : FULL_WIDTH } as TargetAndTransition}
      transition={reduceMotion ? INSTANT : COLLAPSE_TRANSITION}
      className={className}
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
        {full}
      </motion.div>

      {/* The rail comes in over the left edge as the full width fades, and
          goes as it returns. Always there, only hidden while the sidebar is
          open: made afresh at each fold, it held the fold's first frame back
          for as long as that took. */}
      <motion.div
        initial={false}
        animate={
          collapsed
            ? { opacity: 1, x: 0, visibility: 'visible', transition: reduceMotion ? INSTANT : RAIL_IN }
            : { opacity: 0, x: -8, transition: reduceMotion ? INSTANT : RAIL_OUT, transitionEnd: { visibility: 'hidden' } }
        }
        inert={!collapsed}
        aria-hidden={!collapsed || undefined}
        className="absolute inset-y-0 left-0 flex w-14 flex-col pt-(--safe-top) max-lg:hidden"
      >
        {rail}
      </motion.div>
      {children}
    </motion.aside>
  )
}

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
   * On a wide screen, where the sidebar sits beside the page: the two ways of
   * folding it down to a rail of icons and back. Whether it is folded, it
   * reads for itself (useSidebarCollapsed).
   */
  onCollapse?: () => void
  onExpand?: () => void
  targets: Target[]
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  /** Open the page for adding a target: blank, started in a group, or as a copy of one. */
  onOpenAddTarget: (options?: { group?: string; from?: string }) => void
  /** Open the page for editing a target. */
  onOpenEditTarget: (id: string) => void
  /** Add the targets out of a share link. Resolves to whether they were added. */
  onImportTargets: (targets: TargetDefinition[]) => Promise<boolean>
  /**
   * Delete several at once, and the groups given with them. Resolves to
   * whether the delete was started: it goes on in the background.
   */
  onDeleteTargets: (ids: string[], groups?: string[]) => Promise<boolean>
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
  /** Whether the overview is what the main pane is showing. */
  overviewOpen?: boolean
  onOpenOverview?: () => void
  /** Whether BGP monitoring is what the main pane is showing. */
  routingOpen?: boolean
  onOpenRouting?: () => void
  /** How many watched prefixes are not carried as normal. */
  routingTrouble?: number
  /** Whether BGP monitoring is on. Off, Routing is greyed out. */
  routingEnabled?: boolean
  /** Open Settings where Routing is turned on, for whoever may; otherwise its tile does nothing while off. */
  onTurnOnRouting?: () => void
  /** Whether the alerts screen is what the main pane is showing. */
  alertsOpen?: boolean
  onOpenAlerts?: () => void
  /** How many alerts are firing on at least one target. */
  firingAlerts?: number
  /** Whether Settings is what the main pane is showing. */
  settingsOpen?: boolean
  onOpenSettings?: () => void
  /** Opens the patch notes, from the version badge. */
  onOpenPatchNotes?: () => void
  /** The account signed in may look but not change anything: no way to change things is offered. */
  readOnly?: boolean
  onReorderTargets?: (updates: { id: string; sortOrder: number; group?: string }[]) => void
  /** The targets have not arrived yet: there is no list to show and nothing to count. */
  loading?: boolean
  /** Which targets are listed by where they are probed from: all, this server's, or one probe agent's. */
  probeFrom?: ProbeFromFilter
  onProbeFromChange?: (filter: ProbeFromFilter) => void
  /** Where a target can be probed from, besides this server. */
  probeAgents?: ProbeAgentSummary[]
  /** What the local probe is called. */
  localProbeName?: string
  /** Measure every target in a group from the same probes. Resolves to whether that happened. */
  onSetGroupProbe?: (group: string, probes: string[]) => Promise<boolean>
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
  const deleting = target.deleting === true
  const address = targetAddressLabel(target)
  const dualStack = isDualStack(target.host, target.ipVersion)
  const usesIpv6 = addressFamilyFor(target.host, target.ipVersion) === 6
  // Whether the row's actions are open beside it.
  const [actionsOpen, setActionsOpen] = useState(false)
  const { notify, reportError } = useToast()

  // The domain or address itself, not the URL or port around it: what goes
  // into a terminal, a ticket or another tool.
  const copyAddress = () =>
    copyText(target.host).then(
      () => notify({ tone: 'success', title: 'Copied', detail: target.host }),
      error => reportError('Could not copy the address', error)
    )

  // Only the actions there is a way to carry out. Copying changes nothing,
  // so an account that may only look has that one.
  const actions = [
    { label: 'Copy address', icon: ClipboardCopy, danger: false, run: floating ? undefined : copyAddress },
    { label: paused ? 'Resume' : 'Pause', icon: paused ? Play : Pause, danger: false, run: onTogglePaused && (() => onTogglePaused(target)) },
    { label: 'Edit', icon: Pencil, danger: false, run: onEditTarget && (() => onEditTarget(target)) },
    { label: 'Duplicate', icon: Copy, danger: false, run: onDuplicateTarget && (() => onDuplicateTarget(target)) },
    { label: 'Delete', icon: Trash2, danger: true, run: onDeleteTarget && (() => onDeleteTarget(target.id)) },
  ].filter((action): action is typeof action & { run: () => void } => action.run !== undefined)
  // On its way out: nothing more is offered for it, not even a drag.
  const draggable = !deleting && (floating || onHandlePointerDown !== undefined)

  return (
    // Selecting a target has to work from the keyboard, so the row is a real
    // interactive element rather than a div with a click handler.
    <div
      role="button"
      tabIndex={floating || deleting ? -1 : 0}
      aria-current={selected}
      aria-busy={deleting || undefined}
      aria-disabled={deleting || undefined}
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
        'relative w-full text-left px-2 py-2 rounded-md transition-colors group/monitor cursor-pointer',
        'hover:bg-sidebar-row-hover',
        // The selected row is simply the one that is lit. The highlight used
        // to be one shared element that slid from the old row to the new one,
        // which read as something chasing the click down the list, and went
        // astray altogether when the list itself was moving: a group
        // collapsing, or the drawer sliding shut on a phone. Lit in the
        // accent: a grey a step lighter was lost on the groups' own greys.
        selected && SELECTED_ROW,
        // Greyed until the server is done with it and the list lets it go.
        deleting && 'pointer-events-none opacity-50 grayscale'
      )}
    >
      <div className="relative flex items-center gap-1.5">
        {draggable && <button
          type="button"
          tabIndex={floating ? -1 : undefined}
          onPointerDown={e => {
            // The copy that follows the finger has no actions beside it.
            setActionsOpen(false)
            onHandlePointerDown?.(target.id, e)
          }}
          className={cn(
            'p-0.5 cursor-grab active:cursor-grabbing transition-colors touch-none shrink-0 touch:px-1 touch:py-2',
            // Hovering is what shows the handle, so where nothing can hover
            // it is simply shown.
            floating
              ? 'text-muted-foreground/70'
              : 'text-muted-foreground/0 group-hover/monitor:text-muted-foreground/40 hover:text-muted-foreground/70! touch:text-muted-foreground/40'
          )}
          aria-label={`Drag to reorder ${target.name}`}
          onClick={e => e.stopPropagation()}
        >
          <GripVertical className="h-3 w-3" />
        </button>}
        <StatusIndicator
          isOnline={target.isOnline}
          packetLoss={target.packetLoss}
          note={target.statusNote}
          paused={paused}
          onHold={target.onHold ?? (target.neverAnswered ? NEVER_ANSWERED : undefined)}
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
              <Masked text value={target.name} />
            </span>
            {target.type && (
              <span className="shrink-0">
                <TypeBadge type={target.type} />
              </span>
            )}
            {/* Where it is measured from, when that is another machine. */}
            <ProbedFrom agent={target.probeAgent} count={probeIdsOf(target).length} />
            {deleting ? (
              <span className="shrink-0">
                <Badge size="sm">Deleting</Badge>
              </span>
            ) : paused && (
              <span className="shrink-0">
                <Badge size="sm">Paused</Badge>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* An IPv6 address rarely fits; the tooltip carries it in full,
                along with where a domain last resolved to. */}
            <Tooltip side="right" content={<Masked text value={target.resolvedAddress ? `${address} → ${target.resolvedAddress}` : address} />}>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"><Masked text value={address} /></span>
            </Tooltip>
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

        {/* One button for the row's actions, the same with a mouse or a
            finger: four icons a few pixels apart were too small to aim at,
            and a touchscreen has no hover to reveal them. */}
        {actions.length > 0 && !floating && !deleting && (
          <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
            <Tooltip content={actions.length > 1 ? 'Copy the address, pause, edit, duplicate or delete' : 'Copy the address'} side="right">
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => e.stopPropagation()}
                  aria-label={`Actions for ${target.name}`}
                >
                  <MoreHorizontal {...ICON} />
                </Button>
              </PopoverTrigger>
            </Tooltip>
            <PopoverContent align="end" onClick={e => e.stopPropagation()}>
              <div className="flex min-w-40 flex-col gap-1">
                {actions.map(action => (
                  <Button
                    key={action.label}
                    type="button"
                    size="sm"
                    variant={action.danger ? 'danger' : 'ghost'}
                    onClick={() => { setActionsOpen(false); action.run() }}
                    aria-label={`${action.label} ${target.name}`}
                  >
                    <action.icon {...ICON} />
                    {action.label}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
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
const SortableTarget = memo(function SortableTarget({
  isDragSource,
  dragging,
  ...row
}: TargetRowProps & { isDragSource: boolean; dragging: boolean }) {
  return (
    <motion.li
      // Only while a drag is on. A layout animation makes every row measure
      // itself after every render, and with a hundred rows that, not the
      // rows, was most of what a group opening or the list refreshing cost.
      layout={dragging ? 'position' : false}
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
})

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
        // The base is a group's colour, which is what rows sit on: once the
        // copy has settled it looks like the row about to replace it, so the
        // swap is not visible.
        className="relative rounded-md bg-sidebar-group"
        initial={{ scale: 1, opacity: 1, boxShadow: SHADOW_RESTING }}
        animate={{
          scale: lifted ? 1.03 : absorbing ? 0.9 : 1,
          opacity: absorbing ? 0 : 1,
          boxShadow: lifted ? SHADOW_LIFTED : SHADOW_RESTING,
        }}
        transition={DRAG_SPRING}
      >
        <motion.div
          className="absolute inset-0 rounded-md bg-primary/15 outline-1 outline-sidebar-ring/50"
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

// ─── Group Actions ──────────────────────────────────────────────────────────

/**
 * What can be done to a group, behind one button as a target's actions are.
 * Two buttons of their own beside every header left the name a few letters
 * wide, and none at all a group nested a level or two down.
 */
function GroupActions({
  name,
  onAddGroupInside,
  onEditGroup,
}: {
  name: string
  onAddGroupInside?: () => void
  onEditGroup?: () => void
}) {
  const [open, setOpen] = useState(false)
  const actions = [
    // Nesting, from the group that is to hold the new one: no path to type,
    // and no doubt about where it will land.
    { label: 'New group inside', icon: FolderPlus, run: onAddGroupInside },
    { label: 'Rename, move or delete', icon: Pencil, run: onEditGroup },
  ].filter((action): action is typeof action & { run: () => void } => action.run !== undefined)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={`Actions for the group ${name}`}>
          <MoreHorizontal {...ICON} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className="flex min-w-40 flex-col gap-1">
          {actions.map(action => (
            <Button
              key={action.label}
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => { setOpen(false); action.run() }}
            >
              <action.icon {...ICON} />
              {action.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Group Tree ─────────────────────────────────────────────────────────────

/** What every group in the tree needs, handed down unchanged from the sidebar. */
interface GroupTreeProps {
  /** Nothing in the tree is to be changed: no handles, and no offers to add. */
  readOnly?: boolean
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
  onGroupDragStart: (group: string) => void
  onGroupDragEnd: (parent: string) => void
  /** The group a dragged group would move inside, if the pointer is over one. */
  nestInto?: string | null
  onSelectTarget: (id: string) => void
  /** Each left out where the account may not do it: a row offers only what it can. */
  onEditTarget?: (target: Target) => void
  onDuplicateTarget?: (target: Target) => void
  onDeleteTarget?: (id: string) => void
  onTogglePaused?: (target: Target) => void
  onHandlePointerDown?: (id: string, event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * The slice of a sibling's header, at the top and at the bottom, that still
 * reorders it among those siblings. The middle is a drop into that group.
 * A header in another part of the tree is a drop across the whole of it.
 */
const NEST_EDGE = 0.28
/** How long a dragged group must rest on a folded one before that one opens. */
const NEST_DWELL_MS = 480

/**
 * The group under the pointer that a dragged group would move inside, or null
 * when the pointer is over nothing that can take it: itself, a group inside
 * it, the Ungrouped list, or the edge of a sibling (which reorders instead).
 */
function nestGroupAt(x: number, y: number, dragged: string): string | null {
  for (const node of document.elementsFromPoint(x, y)) {
    if (!(node instanceof Element)) continue
    const header = node.closest('[data-group-header]')
    if (!(header instanceof HTMLElement)) continue
    const group = header.dataset.groupHeader
    if (!group || group === UNGROUPED || group === dragged || isWithinGroup(group, dragged)) continue
    const destination = joinGroupPath(group, groupName(dragged))
    if (destination === dragged || destination.length > MAX_GROUP_PATH_LENGTH) continue
    if (parentGroup(group) === parentGroup(dragged)) {
      const rect = header.getBoundingClientRect()
      const ratio = rect.height > 0 ? (y - rect.top) / rect.height : 0.5
      if (ratio < NEST_EDGE || ratio > 1 - NEST_EDGE) continue
    }
    return group
  }
  return null
}

/**
 * The groups inside one group, or the top level for an empty `parent`.
 *
 * Each level is its own reorderable list. Dropping on the edge of a sibling
 * reorders within that list. Dropping on the middle of a header, or on a
 * group anywhere else in the tree, moves the dragged group inside that one.
 */
function GroupList({ parent, depth = 0, ...tree }: GroupTreeProps & { parent: string; depth?: number }) {
  return (
    <Reorder.Group
      axis="y"
      values={subgroups(tree.layout, parent)}
      onReorder={ordered => tree.onReorderSubgroups(parent, ordered)}
      className={depth === 0 ? 'space-y-2' : 'space-y-1.5'}
    >
      {subgroups(tree.layout, parent).map(group => (
        <TargetGroup key={group} group={group} parent={parent} depth={depth} {...tree} />
      ))}
    </Reorder.Group>
  )
}

function TargetGroup({ group, parent, depth, ...tree }: GroupTreeProps & { group: string; parent: string; depth: number }) {
  const {
    readOnly = false,
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
    nestInto,
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
  // A group inside the one being compared is on its chart too, so it is lit
  // with it: the chart takes in everything beneath the group, not only its
  // own rows.
  const inCompared = !!selectedGroup && isWithinGroup(group, selectedGroup)

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
      className={cn(
        'select-none transition-colors duration-150',
        GROUP_PANEL[depth % 2],
        // The outline goes round the whole panel, the groups inside included,
        // and the tint fills it: an inset shadow sits over the panel's own
        // colour and under what is in it, gaps around nested groups and all.
        inCompared && 'shadow-[inset_0_0_0_100vmax_color-mix(in_oklab,var(--accent)_6%,transparent)]',
        // A group inside it is dashed: part of that chart, not the one chosen.
        isCompared ? 'border-sidebar-ring/60' : inCompared && 'border-dashed border-sidebar-ring/50'
      )}
      whileDrag={{ scale: 1.02, zIndex: 50 }}
      // Position only. Animating size as well scales the whole group while a
      // row enters or leaves it, which visibly stretches the header text.
      layout="position"
      transition={DRAG_SPRING}
      onDragStart={() => onGroupDragStart(group)}
      onDragEnd={() => onGroupDragEnd(parent)}
    >
      {/* The header and the group's own rows are what a dragged target is
          dropped on. The groups inside are separate destinations below it, so
          they are deliberately outside this element. */}
      <div
        className={cn(
          'rounded-[inherit] ring-1 ring-transparent transition-[background-color,box-shadow] duration-150',
          isDropDestination && 'bg-primary/5 ring-primary/40'
        )}
        data-group={group}
      >
        {/* Group Header */}
        <div
          className={cn(
            'flex items-center gap-1 rounded-[inherit] px-2 py-1.5 group/header',
            nestInto === group && 'bg-primary/10 ring-1 ring-inset ring-primary/50'
          )}
          data-group-header={group}
        >
          {!readOnly && <button
            type="button"
            onPointerDown={(e) => dragControls.start(e)}
            className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground transition-colors touch-none touch:px-1 touch:py-2"
            aria-label={`Drag to reorder ${name}, or drop it on another group to move it inside`}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>}

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
            <span className="truncate text-xs font-medium text-sidebar-foreground">
              {name}
            </span>
            {nestInto === group && <span className="shrink-0 text-[10px] text-primary">Move inside</span>}
          </button>

          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {memberIds.length}
          </span>

          {/* A comparison needs at least two lines to compare. In the accent
              colour and set in a chip: as a bare grey icon it read as
              decoration, and nobody found the group chart without being told
              where it was. Not labelled: the word "Compare" took 50 pixels
              from the name, and a nested group's name was down to a letter or
              two. A chip the height of the header's text, not one of Arc's
              buttons: the smallest of those is a pill as tall as a target's row. */}
          {onCompare && memberIds.length > 1 && (
            <Tooltip content="Show every monitor in this group on one chart" side="right">
              <button
                type="button"
                onClick={() => onCompare(group)}
                aria-pressed={isCompared}
                aria-label={`Compare the monitors in ${name} on one chart`}
                className={cn(
                  'ml-1 flex shrink-0 cursor-pointer items-center rounded-full border px-1.5 py-1 leading-none transition-colors touch:px-2 touch:py-2',
                  isCompared
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-primary/40 bg-primary/10 text-primary hover:border-primary/70 hover:bg-primary/20'
                )}
              >
                <ChartLine size={13} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </Tooltip>
          )}

          {/* Ungrouped is where targets without a group are listed, not a
              group that can be renamed or put inside another. */}
          {group !== UNGROUPED && (onAddGroupInside || onEditGroup) && (
            <GroupActions
              name={name}
              onAddGroupInside={onAddGroupInside && (() => onAddGroupInside(group))}
              onEditGroup={onEditGroup && (() => onEditGroup(group))}
            />
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
              {/* To the right, out over the page: above, it covered the
                  header of the very group it describes. */}
              <Tooltip side="right" content={`${name}: mean latency across its ${memberIds.length} monitor${memberIds.length === 1 ? '' : 's'}, marked wherever any of them lost packets`}>
                <div className="px-2 pb-2">
                  <Sparkline points={groupTrace} width={240} height={22} stretch />
                </div>
              </Tooltip>
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
              <ul className="space-y-0.5 px-1 pb-1">
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
                      dragging={!!drag}
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
                    {readOnly ? (
                      'Empty'
                    ) : group === UNGROUPED ? (
                      'Drop here to remove from its group'
                    ) : drag ? (
                      'Drop here'
                    ) : (
                      <>
                        Empty. Drag a monitor here, or
                        <Button type="button" variant="ghost" size="sm" onClick={() => onAddTargetTo(group)}>
                          add one
                        </Button>
                      </>
                    )}
                  </motion.li>
                )}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Groups inside this one, as panels within its own, set in from its
          edge so the eye can follow which header they belong to. */}
      <AnimatePresence initial={false}>
        {!isCollapsed && inside.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
            animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
            exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
            transition={{ duration: 0.2 }}
          >
            <div className="pb-1.5 pl-2.5 pr-1.5">
              <GroupList parent={group} depth={depth + 1} {...tree} />
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
  onCollapse,
  onExpand,
  targets,
  selectedTargetId,
  onSelectTarget,
  onOpenAddTarget,
  onOpenEditTarget,
  onImportTargets,
  onDeleteTargets,
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
  overviewOpen = false,
  onOpenOverview,
  routingOpen = false,
  onOpenRouting,
  routingTrouble = 0,
  routingEnabled = true,
  onTurnOnRouting,
  alertsOpen = false,
  onOpenAlerts,
  firingAlerts = 0,
  settingsOpen = false,
  onOpenSettings,
  onOpenPatchNotes,
  readOnly = false,
  onReorderTargets,
  loading = false,
  probeFrom = 'all',
  onProbeFromChange,
  probeAgents = [],
  localProbeName,
  onSetGroupProbe,
}: SidebarProps) {
  const [isShareOpen, setIsShareOpen] = useState(false)
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false)
  const [incomingShareCode, clearIncomingShareCode] = useIncomingShareCode()
  // Held by id, so the dialog always describes the target as it is now and
  // closes by itself if the target goes away underneath it.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [groupTask, setGroupTask] = useState<GroupDialogTask | null>(null)
  // Read once, lazily, from what was left last time. Nothing is drawn from it
  // until the targets have loaded, so the server knowing none of it is no
  // mismatch.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(readCollapsedGroups)
  const [searchQuery, setSearchQuery] = useState('')
  const [isGroupDragging, setIsGroupDragging] = useState(false)
  /** The group a dragged group would move inside, from where the pointer is. */
  const [nestInto, setNestInto] = useState<string | null>(null)
  const draggedGroupRef = useRef<string | null>(null)
  const nestIntoRef = useRef<string | null>(null)
  // Set when a drop moves a group into another, so the sibling order Framer
  // records as the pointer lifts is not kept.
  const ignoreGroupReorder = useRef(false)
  const listRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [theme, setTheme] = useTheme()
  const { notify } = useToast()

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

  // The probe agents targets are probed from, for the filter: only once there
  // is more than one place readings come from.
  const agentsInUse = useMemo(
    () =>
      probeAgents
        .filter(agent => targets.some(target => probeIdsOf(target).includes(agent.id)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [targets, probeAgents]
  )
  // A filter for an agent no target uses any more lists everything again.
  const fromFilter: ProbeFromFilter =
    probeFrom === 'all' || probeFrom === 'local' || agentsInUse.some(agent => agent.id === probeFrom) ? probeFrom : 'all'

  // Filter targets by search, and by where they are probed from
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q && fromFilter === 'all') return null

    return groupsInOrder(savedLayout)
      .map(group => ({
        group,
        targets: savedLayout.items[group]
          .map(id => targetsById.get(id))
          .filter((t): t is Target =>
            !!t &&
            matchesProbeFrom(t, fromFilter) &&
            (!q || t.name.toLowerCase().includes(q) || targetAddressLabel(t).toLowerCase().includes(q))
          ),
      }))
      .filter(group => group.targets.length > 0)
  }, [savedLayout, targetsById, searchQuery, fromFilter])

  const handleGroupReorder = useCallback((parent: string, ordered: string[]) => {
    if (ignoreGroupReorder.current) return
    setLayout(current => reorderSubgroups(current, parent, ordered))
  }, [])

  const handleGroupDragStart = useCallback((group: string) => {
    ignoreGroupReorder.current = false
    draggedGroupRef.current = group
    nestIntoRef.current = null
    setNestInto(null)
    setIsGroupDragging(true)
  }, [])

  useEffect(() => {
    if (!isGroupDragging) return
    const onMove = (event: PointerEvent) => {
      const dragged = draggedGroupRef.current
      if (!dragged) return
      const into = nestGroupAt(event.clientX, event.clientY, dragged)
      if (nestIntoRef.current === into) return
      nestIntoRef.current = into
      setNestInto(into)
    }
    window.addEventListener('pointermove', onMove, true)
    return () => window.removeEventListener('pointermove', onMove, true)
  }, [isGroupDragging])

  // Resting on a folded group opens it, so what is inside can be dropped on.
  useEffect(() => {
    if (!nestInto) return
    const timer = window.setTimeout(() => {
      setCollapsedGroups(current => {
        if (!current.has(nestInto)) return current
        if (subgroups(layout, nestInto).length === 0) return current
        const next = new Set(current)
        next.delete(nestInto)
        saveCollapsedGroups(next)
        return next
      })
    }, NEST_DWELL_MS)
    return () => window.clearTimeout(timer)
  }, [nestInto, layout])

  // A drop on a group moves inside it. Anywhere else, the drag only reordered
  // the group among the ones that share its parent, and that order is saved.
  const handleGroupDragEnd = (parent: string) => {
    const dragged = draggedGroupRef.current
    const into = nestIntoRef.current
    draggedGroupRef.current = null
    nestIntoRef.current = null
    setNestInto(null)
    setIsGroupDragging(false)

    if (dragged && into) {
      ignoreGroupReorder.current = true
      setLayout(savedLayout)
      const destination = joinGroupPath(into, groupName(dragged))
      if (destination !== dragged && !isWithinGroup(into, dragged) && destination.length <= MAX_GROUP_PATH_LENGTH) {
        const next = new Set([...collapsedGroups].map(group => rebaseGroupPath(group, dragged, destination)))
        for (const ancestor of groupWithAncestors(parentGroup(destination))) next.delete(ancestor)
        setCollapsedGroups(next)
        saveCollapsedGroups(next)
        onMoveGroup?.(dragged, destination)
      } else if (destination.length > MAX_GROUP_PATH_LENGTH) {
        notify({
          tone: 'warning',
          title: 'That group cannot go there',
          detail: `A group's path can be at most ${MAX_GROUP_PATH_LENGTH} characters.`,
        })
      }
      return
    }

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

  // Stable, so that the rows they are handed to are not drawn again each time
  // the sidebar is.
  const openEdit = useCallback((target: Target) => onOpenEditTarget(target.id), [onOpenEditTarget])
  const openDuplicate = useCallback((target: Target) => onOpenAddTarget({ from: target.id }), [onOpenAddTarget])

  const closeShareDialog = () => {
    setIsShareOpen(false)
    // Dealt with, whichever way: a refresh should not bring the import back.
    clearIncomingShareCode()
  }

  // Targets awaiting their first measurement are counted separately rather
  // than lumped in with the offline ones. Paused ones are counted as neither
  // online nor offline: nobody has asked them lately.
  // Nor are those whose probe agent is down: their last reading is old news.
  const probed = targets.filter(t => t.status !== 'paused' && !t.onHold && !t.neverAnswered)
  const onlineCount = probed.filter(t => t.isOnline === true).length
  const offlineCount = probed.filter(t => t.isOnline === false).length
  const pendingCount = probed.filter(t => t.isOnline === undefined).length
  const pausedCount = targets.filter(t => t.status === 'paused').length
  const heldCount = targets.filter(t => t.status !== 'paused' && t.onHold).length
  // Nor are the closed-port checks that have never had an answer: no reading
  // says their server is down, only that this check cannot reach it.
  const silentCount = targets.filter(t => t.status !== 'paused' && !t.onHold && t.neverAnswered).length

  const version = useVersionStatus()

  const draggedTarget = drag.active ? targetsById.get(drag.active.id) : undefined
  const deletingTarget = deletingId ? targetsById.get(deletingId) ?? null : null

  return (
    <>
    {/* What is behind the drawer, dimmed. Pressing it puts the drawer away. */}
    <div
      aria-hidden="true"
      onClick={onClose}
      className={cn(
        'fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity duration-200 lg:hidden',
        open ? 'opacity-100' : 'pointer-events-none opacity-0'
      )}
    />
    <SidebarFold
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
      rail={
        <SidebarRail
          layout={savedLayout}
          targetsById={targetsById}
          selectedTargetId={selectedTargetId}
          selectedGroup={selectedGroup}
          onSelectTarget={onSelectTarget}
          onSelectGroup={onSelectGroup}
          onExpand={onExpand}
          overviewOpen={overviewOpen}
          onOpenOverview={onOpenOverview}
          routingOpen={routingOpen}
          onOpenRouting={onOpenRouting}
          routingEnabled={routingEnabled}
          onTurnOnRouting={onTurnOnRouting}
          alertsOpen={alertsOpen}
          onOpenAlerts={onOpenAlerts}
          firingAlerts={firingAlerts}
          onShare={() => setIsShareOpen(true)}
          settingsOpen={settingsOpen}
          onOpenSettings={() => onOpenSettings?.()}
          onAddTarget={readOnly ? undefined : () => onOpenAddTarget()}
        />
      }
      full={
      <>
      {/* Header: who this is and what version, the pages, then finding a
          target and how the targets stand. */}
      <div className="space-y-3 border-b border-sidebar-border p-4">
        <div className="flex h-9 items-center gap-2">
          {/* The mark goes home, as a site's does. */}
          {onOpenOverview ? (
            <button type="button" onClick={onOpenOverview} className="flex shrink-0 cursor-pointer rounded-lg" aria-label="Overview">
              <BrandMark />
            </button>
          ) : (
            <BrandMark />
          )}
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="shrink-0 text-base font-medium text-sidebar-foreground">ClearPing</h1>
            <VersionBadge version={version} onOpen={onOpenPatchNotes} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <ThemeSwitch theme={theme} variant="rise" iconOnly onThemeChange={next => setTheme(next)} />
            <span className="lg:hidden">
              <Button ref={closeRef} type="button" variant="secondary" size="sm" style={HEADER_BUTTON} onClick={onClose} aria-label="Close monitors">
                <X {...ICON} />
              </Button>
            </span>
            {onCollapse && (
              <span className="hidden lg:block">
                <Tooltip content="Collapse sidebar">
                  <Button id={SIDEBAR_COLLAPSE_BUTTON_ID} type="button" variant="secondary" size="sm" style={HEADER_BUTTON} onClick={onCollapse} aria-label="Collapse sidebar">
                    <PanelLeftClose {...ICON} />
                  </Button>
                </Tooltip>
              </span>
            )}
          </div>
        </div>

        <UpdateNotice version={version} onOpen={onOpenPatchNotes} />

        {/* The pages beside the list: the overview first, then Routing, a
            tool of its own (BGP monitoring, for networks that announce their
            own prefixes) rather than a setting. Tiles, not rows: as rows they
            read as two more targets and went unnoticed. */}
        {(onOpenOverview || onOpenRouting) && (
          <nav aria-label="Pages" className={cn('grid gap-2', onOpenOverview && onOpenRouting ? 'grid-cols-2' : 'grid-cols-1')}>
            {onOpenOverview && (
              <PageTile icon={<LayoutDashboard {...ICON} />} label="Overview" open={overviewOpen} onOpen={onOpenOverview} />
            )}
            {onOpenRouting && (
              <PageTile
                icon={<Network {...ICON} />}
                label="Routing"
                open={routingOpen}
                onOpen={routingEnabled ? onOpenRouting : onTurnOnRouting}
                off={
                  routingEnabled
                    ? undefined
                    : onTurnOnRouting
                      ? 'Routing is off. Turn it on in Settings'
                      : 'Routing is off. An admin can turn it on in Settings'
                }
                count={routingTrouble > 0 ? routingTrouble : undefined}
                countLabel={`${routingTrouble} prefix${routingTrouble === 1 ? '' : 'es'} not as normal`}
              />
            )}
          </nav>
        )}
        {/* Always there once there is something to find: behind a button it
            went unnoticed. Its placeholder says what it is, so its label is
            said, not shown. There while the list loads too, or everything under
            it dropped down the moment the targets arrived. */}
        {(loading || targets.length > 0) && (
          <div className="[&_label]:sr-only">
            <SearchField label="Search monitors" placeholder="Search name or address" value={searchQuery} onValueChange={setSearchQuery} />
          </div>
        )}
        {/* Each choice says the whole of what it means, so the label, like the
            search's, is for a screen reader. */}
        {agentsInUse.length > 0 && onProbeFromChange && (
          <div className="[&_label]:sr-only">
            <Select
              id="sidebar-probe-from"
              label="Measured by"
              value={fromFilter}
              onValueChange={value => onProbeFromChange(value)}
              options={[
                { value: 'all', label: 'Measured by any probe' },
                { value: 'local', label: `Measured by ${localProbeName ?? DEFAULT_LOCAL_PROBE_NAME}` },
                ...agentsInUse.map(agent => ({ value: agent.id, label: `Measured by ${agent.name}` })),
              ]}
            />
          </div>
        )}

        {/* How the targets stand, just over their list. As tall while loading
            as after, so the list does not jump when the counts arrive. */}
        <div className="flex min-h-[22px] flex-wrap items-center gap-1.5">
          {/* Not "0 online, 0 offline" while the list is on its way: that
              is a count of nothing, and it reads as everything being gone. */}
          {loading ? (
            <>
              <span className="h-[22px] w-20 animate-pulse rounded-full bg-muted motion-reduce:animate-none" aria-hidden="true" />
              <span className="h-[22px] w-16 animate-pulse rounded-full bg-muted motion-reduce:animate-none" aria-hidden="true" />
            </>
          ) : (
            <>
              <StatusCount tone={onlineCount > 0 ? 'success' : 'neutral'} count={onlineCount} label="online" />
              <StatusCount tone={offlineCount > 0 ? 'danger' : 'neutral'} count={offlineCount} label="offline" />
            </>
          )}
          {pendingCount > 0 && <StatusCount count={pendingCount} label="pending" why="Waiting for their first reading" />}
          {silentCount > 0 && <StatusCount count={silentCount} label="no answer" why={NEVER_ANSWERED} />}
          {heldCount > 0 && <StatusCount tone="warning" count={heldCount} label="on hold" why="No readings: their probe agent is down" />}
          {pausedCount > 0 && <StatusCount count={pausedCount} label="paused" />}
        </div>
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
        <ScrollArea label="Monitors" className="min-h-0 flex-1" viewportStyle={{ overscrollBehavior: 'contain' }}>
          <nav
            ref={listRef}
            // While a row is in the air the list must not react to the pointer
            // passing over it: no hover highlights trailing the drag, and no
            // click landing on whatever happens to be underneath on release.
            className={cn('p-2', drag.active && 'pointer-events-none')}
            aria-label="Monitors"
          >
            <SearchResults query={searchQuery.trim().toLowerCase()}>
            {loading ? (
              <SidebarSkeleton />
            ) : searchResults ? (
              // Search mode: plain list, no drag
              <div className="space-y-2">
                {searchResults.map(({ group, targets: matches }) => (
                  <div key={group} className={GROUP_PANEL[0]}>
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      {/* The whole path: out of the tree, a name alone does
                          not say which of two same-named groups this is. */}
                      <span className="truncate text-xs font-medium text-sidebar-foreground">
                        {groupLabel(group)}
                      </span>
                      <span className="ml-auto">
                        <Badge size="sm">{matches.length}</Badge>
                      </span>
                    </div>
                    <ul className="space-y-0.5 px-1 pb-1">
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
                              'hover:bg-sidebar-row-hover',
                              selectedTargetId === target.id && SELECTED_ROW
                            )}
                          >
                            <div className="flex items-center gap-2.5">
                              <StatusIndicator
                                isOnline={target.isOnline}
                                packetLoss={target.packetLoss}
                                paused={target.status === 'paused'}
                                onHold={target.onHold ?? (target.neverAnswered ? NEVER_ANSWERED : undefined)}
                              />
                              <div className={cn('flex-1 min-w-0', target.status === 'paused' && 'opacity-60 grayscale')}>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-sm text-sidebar-foreground truncate"><Masked text value={target.name} /></span>
                                  {target.type && <TypeBadge type={target.type} />}
                                  <ProbedFrom agent={target.probeAgent} count={probeIdsOf(target).length} />
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                                    <Masked text value={targetAddressLabel(target)} />
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
                  <p className="text-center text-sm text-muted-foreground py-8">No monitors found</p>
                )}
              </div>
            ) : (
              // Normal mode: draggable groups
              <>
              <GroupList
                parent=""
                readOnly={readOnly}
                layout={layout}
                targetsById={targetsById}
                selectedTargetId={selectedTargetId}
                selectedGroup={selectedGroup}
                series={series}
                collapsedGroups={collapsedGroups}
                drag={drag.active}
                onToggleCollapse={toggleCollapse}
                onCompare={onSelectGroup}
                onEditGroup={onMoveGroup && !readOnly ? openEditGroup : undefined}
                onAddGroupInside={onCreateGroup && !readOnly ? parent => setGroupTask({ kind: 'create', parent }) : undefined}
                onAddTargetTo={group => onOpenAddTarget({ group })}
                onReorderSubgroups={handleGroupReorder}
                onGroupDragStart={handleGroupDragStart}
                onGroupDragEnd={handleGroupDragEnd}
                nestInto={nestInto}
                onSelectTarget={onSelectTarget}
                onEditTarget={readOnly ? undefined : openEdit}
                onDuplicateTarget={readOnly ? undefined : openDuplicate}
                onDeleteTarget={readOnly ? undefined : setDeletingId}
                onTogglePaused={readOnly ? undefined : onTogglePaused}
                onHandlePointerDown={readOnly ? undefined : drag.onHandlePointerDown}
              />
              {/* Where the next group would go, and so where the way to make
                  one is. A group is made here first and filled afterwards. */}
              {onCreateGroup && !readOnly && (
                <div className="sidebar-controls mt-2 flex">
                  <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={() => setGroupTask({ kind: 'create', parent: '' })}>
                    <FolderPlus {...ICON} />
                    New group
                  </Button>
                </div>
              )}
              </>
            )}
            </SearchResults>
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

      {/* Footer actions. Two rows: at Arc's sizes, four controls side by side
          were wider than the sidebar, and the label ran out of its button. */}
      <div className="flex flex-col gap-2 border-t border-sidebar-border p-3 pb-[calc(0.75rem+var(--safe-bottom))]">
        {!readOnly && (
          <Button className="w-full" size="sm" onClick={() => onOpenAddTarget()} suppressHydrationWarning>
            <Plus {...ICON} />
            Add monitor
          </Button>
        )}
        <div className="sidebar-controls flex gap-2">
          {onOpenAlerts && (
            <Button
              className="flex-1"
              variant={alertsOpen ? 'primary' : 'secondary'}
              size="sm"
              onClick={onOpenAlerts}
              aria-pressed={alertsOpen}
              aria-label={firingAlerts > 0 ? `Alerts, ${firingAlerts} firing` : 'Alerts'}
              suppressHydrationWarning
            >
              <Bell {...ICON} />
              Alerts
              {/* Said here so a firing alert is seen from any screen. */}
              {firingAlerts > 0 && <Badge tone="danger" size="sm">{firingAlerts}</Badge>}
            </Button>
          )}
          {/* One target is deleted from its own row. This is for clearing out
              several. It is always there, only greyed out until there are
              several: arriving with the monitors, it squeezed the buttons
              beside it a moment after the page was drawn. */}
          {!readOnly && (
            <Tooltip content={targets.length > 1 ? 'Delete several monitors' : 'Delete several monitors, once there are several'}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsBulkDeleteOpen(true)}
                disabled={targets.length < 2}
                aria-label="Delete several monitors"
                suppressHydrationWarning
              >
                <ListX {...ICON} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Share or import monitors">
            <Button variant="secondary" size="sm" onClick={() => setIsShareOpen(true)} aria-label="Share or import monitors" suppressHydrationWarning>
              <Share2 {...ICON} />
            </Button>
          </Tooltip>
          {/* Everything that is set up rather than monitored, in one place:
              sign-in, keys, single sign-on, accounts, the activity record, and
              connecting an AI assistant. */}
          <Tooltip content="Settings: security, keys and AI assistants">
            <Button
              variant={settingsOpen ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onOpenSettings?.()}
              aria-pressed={settingsOpen}
              aria-label="Settings"
              suppressHydrationWarning
            >
              <Settings {...ICON} />
            </Button>
          </Tooltip>
        </div>
      </div>
      </>
      }
    >

      <GroupDialog
        task={groupTask}
        groups={availableGroups}
        probeAgents={probeAgents}
        localProbeName={localProbeName}
        memberProbes={
          groupTask?.kind === 'edit'
            ? targets
                .filter(target => !!target.group && isWithinGroup(target.group, groupTask.group))
                .map(target => probeIdsOf(target))
            : []
        }
        onCancel={() => setGroupTask(null)}
        onCreate={handleCreateGroup}
        onMove={handleMoveGroup}
        onDelete={handleDeleteGroup}
        onSetProbe={onSetGroupProbe}
      />

      {/* Arriving by a share link opens it at the import, but not before the
          monitors have loaded: until then it cannot say which of the incoming
          ones are already here. */}
      <ShareDialog
        open={isShareOpen || (incomingShareCode !== null && !loading)}
        onOpenChange={open => { if (open) setIsShareOpen(true); else closeShareDialog() }}
        existing={targets}
        groupOrders={groupOrders}
        incomingCode={incomingShareCode}
        canImport={!readOnly}
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
        groups={groups}
        onDelete={onDeleteTargets}
      />

      {/* Nothing is deleted from the row itself: the button there only asks. */}
      <DeleteTargetDialog
        target={deletingTarget}
        onCancel={() => setDeletingId(null)}
        onConfirm={id => { setDeletingId(null); onDeleteTarget(id) }}
        onPause={onTogglePaused}
      />
    </SidebarFold>
    </>
  )
}
