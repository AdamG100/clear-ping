'use client'

import { useMemo } from 'react'
import { Bell, LayoutDashboard, Network, PanelLeftOpen, Plus, Settings, Share2 } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { cn } from '@/lib/utils'
import type { Target } from '@/types/probe'
import { describeGroupHealth, groupIsOnline, groupIsPaused, summarizeGroupHealth } from '@/lib/targets/group-health'
import { groupInitials, groupName, isWithinGroup } from '@/lib/targets/group-path'
import { subgroups, targetsWithin, type SidebarLayout } from '@/lib/targets/sidebar-layout'
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
  /** Whether the overview is open. */
  overviewOpen?: boolean
  onOpenOverview?: () => void
  routingOpen?: boolean
  onOpenRouting?: () => void
  /** Off, its icon is greyed out, and opens Settings for whoever may turn it on. */
  routingEnabled?: boolean
  onTurnOnRouting?: () => void
  alertsOpen: boolean
  onOpenAlerts?: () => void
  /** How many alerts are firing on at least one target. */
  firingAlerts: number
  onShare: () => void
  /** Whether Settings is open. */
  settingsOpen?: boolean
  onOpenSettings: () => void
  /** Left out for an account that may only look. */
  onAddTarget?: () => void
}

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

/**
 * A button and its name, shown to its right. Above or below, where a name
 * usually goes, it would lie over the next button in the rail.
 */
function Beside({ name, children }: { name: string; children: React.ReactElement }) {
  return <Tooltip content={name} side="right">{children}</Tooltip>
}

export function SidebarRail({
  layout,
  targetsById,
  selectedTargetId,
  selectedGroup,
  onSelectTarget,
  onSelectGroup,
  onExpand,
  overviewOpen = false,
  onOpenOverview,
  routingOpen = false,
  onOpenRouting,
  routingEnabled = true,
  onTurnOnRouting,
  alertsOpen,
  onOpenAlerts,
  firingAlerts,
  onShare,
  settingsOpen = false,
  onOpenSettings,
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
        <Beside name="Expand sidebar">
          <Button id={SIDEBAR_EXPAND_BUTTON_ID} type="button" variant="ghost" size="sm" onClick={onExpand} aria-label="Expand sidebar">
            <PanelLeftOpen {...ICON} />
          </Button>
        </Beside>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2 [scrollbar-width:none]"
        aria-label="Groups"
      >
        {/* Home first, above the groups it sums up, as in the full sidebar. */}
        {onOpenOverview && (
          <Beside name="Overview">
            <Button type="button" variant={overviewOpen ? 'primary' : 'ghost'} size="sm" onClick={onOpenOverview} aria-pressed={overviewOpen} aria-label="Overview">
              <LayoutDashboard {...ICON} />
            </Button>
          </Beside>
        )}
        {onOpenRouting && (
          <Beside name={routingEnabled ? 'Routing' : onTurnOnRouting ? 'Routing is off. Turn it on in Settings' : 'Routing is off. An admin can turn it on in Settings'}>
            {routingEnabled ? (
              <Button type="button" variant={routingOpen ? 'primary' : 'ghost'} size="sm" onClick={onOpenRouting} aria-pressed={routingOpen} aria-label="Routing">
                <Network {...ICON} />
              </Button>
            ) : (
              // Greyed out, but still a way to where it is turned on.
              <span className="opacity-45">
                <Button type="button" variant="ghost" size="sm" onClick={onTurnOnRouting} disabled={!onTurnOnRouting} aria-label="Routing is off">
                  <Network {...ICON} />
                </Button>
              </span>
            )}
          </Beside>
        )}
        {groups.map(({ group, memberIds, health }) => {
          const name = groupName(group)
          const state = describeGroupHealth(health)
          const summary = `${name}: ${state}`
          const active =
            (selectedGroup !== null && isWithinGroup(selectedGroup, group)) ||
            (selectedTargetId !== null && memberIds.includes(selectedTargetId))

          return (
            <Beside key={group} name={summary}>
            <button
              type="button"
              // A group of several opens as its comparison chart, which is
              // every target in it at once. A group of one has nothing to
              // compare, so it opens that target.
              onClick={() => (memberIds.length > 1 && onSelectGroup ? onSelectGroup(group) : onSelectTarget(memberIds[0]))}
              disabled={memberIds.length === 0}
              aria-current={active}
              // The tile shows two letters of the name; its name in full, and
              // what its light is saying, are the tooltip.
              aria-label={summary}
              className={cn(
                'relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border font-mono text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-sidebar-accent text-sidebar-foreground'
                  : 'border-sidebar-border bg-background text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
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
            </Beside>
          )
        })}
      </nav>

      <div className="flex shrink-0 flex-col items-center gap-1.5 border-t border-sidebar-border py-3 pb-[calc(0.75rem+var(--safe-bottom))]">
        {onOpenAlerts && (
          <Beside name={firingAlerts > 0 ? `Alerts: ${firingAlerts} firing` : 'Alerts'}>
            <span className="relative">
              <Button
                type="button"
                variant={alertsOpen ? 'primary' : 'ghost'}
                size="sm"
                onClick={onOpenAlerts}
                aria-pressed={alertsOpen}
                aria-label={firingAlerts > 0 ? `Alerts, ${firingAlerts} firing` : 'Alerts'}
              >
                <Bell {...ICON} />
              </Button>
              {firingAlerts > 0 && (
                <span className="pointer-events-none absolute -right-1.5 -top-1.5" aria-hidden="true">
                  <Badge tone="danger" size="sm">{firingAlerts}</Badge>
                </span>
              )}
            </span>
          </Beside>
        )}
        <Beside name="Share or import targets">
          <Button type="button" variant="ghost" size="sm" onClick={onShare} aria-label="Share or import targets">
            <Share2 {...ICON} />
          </Button>
        </Beside>
        <Beside name="Settings: security, keys and AI assistants">
          <Button type="button" variant={settingsOpen ? 'primary' : 'ghost'} size="sm" onClick={onOpenSettings} aria-pressed={settingsOpen} aria-label="Settings">
            <Settings {...ICON} />
          </Button>
        </Beside>
        {onAddTarget && (
          <Beside name="Add target">
            <Button type="button" size="sm" onClick={onAddTarget} aria-label="Add target">
              <Plus {...ICON} />
            </Button>
          </Beside>
        )}
      </div>
    </>
  )
}
