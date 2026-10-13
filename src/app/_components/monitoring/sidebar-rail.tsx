'use client'

import { useMemo } from 'react'
import { Bell, Bot, PanelLeftOpen, Plus, Share2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Target } from '@/types/probe'
import { describeGroupHealth, groupIsOnline, groupIsPaused, summarizeGroupHealth } from '@/lib/group-health'
import { groupInitials, groupName, isWithinGroup } from '@/lib/group-path'
import { subgroups, targetsWithin, type SidebarLayout } from '@/lib/sidebar-layout'
import { RailTip } from './rail-tip'
import { StatusIndicator } from './status-indicator'
import { SIDEBAR_EXPAND_BUTTON_ID } from './use-sidebar-drawer'

/**
 * The sidebar collapsed: a strip of icons down the edge of the page.
 *
 * Collapsing is for giving the page its width, not for losing sight of the
 * network. So what stays is one tile for each group at the top level, lit by
 * the state of everything inside it, which is enough to see that something
 * has gone wrong and where to look; and the count of firing alerts.
 */

interface SidebarRailProps {
  layout: SidebarLayout
  targetsById: Map<string, Target>
  selectedTargetId: string | null
  /** The group whose comparison chart is on screen, if one is. */
  selectedGroup: string | null
  onSelectTarget: (id: string) => void
  onSelectGroup?: (group: string) => void
  onExpand?: () => void
  alertsOpen: boolean
  onOpenAlerts?: () => void
  /** How many alerts are firing on at least one target. */
  firingAlerts: number
  onShare: () => void
  onConnectAssistant: () => void
  onAddTarget: () => void
}

const RAIL_BUTTON =
  'relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground ' +
  'transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground'

export function SidebarRail({
  layout,
  targetsById,
  selectedTargetId,
  selectedGroup,
  onSelectTarget,
  onSelectGroup,
  onExpand,
  alertsOpen,
  onOpenAlerts,
  firingAlerts,
  onShare,
  onConnectAssistant,
  onAddTarget,
}: SidebarRailProps) {
  const groups = useMemo(
    () =>
      subgroups(layout, '')
        .map(group => {
          // Everything under the group, at any depth: a fault three groups down
          // is still a fault in here.
          const memberIds = targetsWithin(layout, group)
          const members = memberIds.map(id => targetsById.get(id)).filter((target): target is Target => !!target)
          return { group, memberIds, health: summarizeGroupHealth(members) }
        })
        // A group with nothing in it has no state to light a tile with and
        // nothing to open.
        .filter(({ memberIds }) => memberIds.length > 0),
    [layout, targetsById]
  )

  return (
    <>
      <div className="flex h-[4.25rem] shrink-0 items-center justify-center border-b border-sidebar-border">
        <RailTip label="Expand sidebar">
          <button
            id={SIDEBAR_EXPAND_BUTTON_ID}
            type="button"
            onClick={onExpand}
            className={RAIL_BUTTON}
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        </RailTip>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2 [scrollbar-width:none]"
        aria-label="Groups"
      >
        {groups.map(({ group, memberIds, health }) => {
          const name = groupName(group)
          const state = describeGroupHealth(health)
          const summary = `${name}: ${state}`
          const active =
            (selectedGroup !== null && isWithinGroup(selectedGroup, group)) ||
            (selectedTargetId !== null && memberIds.includes(selectedTargetId))

          return (
            // The tile shows two letters of the name; this is the rest of it,
            // and what its light is saying.
            <RailTip key={group} label={name} detail={state}>
              <button
                type="button"
                // A group of several opens as its comparison chart, which is
                // every target in it at once. A group of one has nothing to
                // compare, so it opens that target.
                onClick={() => (memberIds.length > 1 && onSelectGroup ? onSelectGroup(group) : onSelectTarget(memberIds[0]))}
                disabled={memberIds.length === 0}
                aria-current={active}
                aria-label={summary}
                className={cn(
                  RAIL_BUTTON,
                  'border font-mono text-[11px] font-semibold tracking-wide',
                  active
                    ? 'border-sidebar-ring/50 bg-sidebar-accent text-sidebar-foreground'
                    : 'border-sidebar-border bg-sidebar-accent/40'
                )}
              >
                <span aria-hidden="true">{groupInitials(group)}</span>
                {/* The light sits on the tile's corner, ringed in the rail's own
                    colour so that it reads as apart from the tile. */}
                <span className="absolute -right-1 -top-1 flex rounded-full ring-2 ring-sidebar" aria-hidden="true">
                  <StatusIndicator
                    isOnline={groupIsOnline(health)}
                    packetLoss={health.worstLoss}
                    paused={groupIsPaused(health)}
                    note={summary}
                    bare
                  />
                </span>
              </button>
            </RailTip>
          )
        })}
      </nav>

      <div className="flex shrink-0 flex-col items-center gap-1.5 border-t border-sidebar-border py-3 pb-[calc(0.75rem+var(--safe-bottom))]">
        {onOpenAlerts && (
          <RailTip label="Alerts" detail={firingAlerts > 0 ? `${firingAlerts} firing` : undefined}>
            <button
              type="button"
              onClick={onOpenAlerts}
              aria-pressed={alertsOpen}
              aria-label={firingAlerts > 0 ? `Alerts, ${firingAlerts} firing` : 'Alerts'}
              className={cn(RAIL_BUTTON, alertsOpen && 'bg-sidebar-accent text-sidebar-foreground')}
            >
              <Bell className="h-4 w-4" />
              {firingAlerts > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-destructive px-1 py-0.5 text-center text-[10px] font-semibold leading-none text-white"
                  aria-hidden="true"
                >
                  {firingAlerts}
                </span>
              )}
            </button>
          </RailTip>
        )}
        <RailTip label="Connect an AI assistant" detail="MCP">
          <button type="button" onClick={onConnectAssistant} aria-label="Connect an AI assistant" className={RAIL_BUTTON}>
            <Bot className="h-4 w-4" />
          </button>
        </RailTip>
        <RailTip label="Share or import targets">
          <button type="button" onClick={onShare} aria-label="Share or import targets" className={RAIL_BUTTON}>
            <Share2 className="h-4 w-4" />
          </button>
        </RailTip>
        <RailTip label="Add target">
          <button
            type="button"
            onClick={onAddTarget}
            aria-label="Add target"
            className={cn(RAIL_BUTTON, 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')}
          >
            <Plus className="h-4 w-4" />
          </button>
        </RailTip>
      </div>
    </>
  )
}
