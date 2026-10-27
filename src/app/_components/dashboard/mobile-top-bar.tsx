'use client'

import { Bell, LayoutDashboard, Menu } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { BrandMark } from '../shell/brand-mark'

interface MobileTopBarProps {
  sidebarOpen: boolean
  onOpenSidebar: () => void
  /** Whether the overview is what the main pane is showing. */
  overviewOpen: boolean
  onOpenOverview: () => void
  /** Whether the alerts screen is what the main pane is showing. */
  alertsOpen: boolean
  onOpenAlerts: () => void
  /** How many alerts are firing on at least one target. */
  firingAlerts: number
}

const ICON = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const

/**
 * What stands in for the sidebar where there is no room to keep it on screen:
 * the way to open it, the way home to the overview, and the count of firing
 * alerts, which the sidebar shows from every screen and which must not
 * disappear along with it.
 */
export function MobileTopBar({ sidebarOpen, onOpenSidebar, overviewOpen, onOpenOverview, alertsOpen, onOpenAlerts, firingAlerts }: MobileTopBarProps) {
  return (
    <div className="shrink-0 border-b border-sidebar-border bg-sidebar pt-(--safe-top) pl-(--safe-left) pr-(--safe-right) lg:hidden">
      <div className="flex h-12 items-center gap-1 px-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onOpenSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          aria-label="Open targets"
        >
          <Menu {...ICON} />
        </Button>

        <BrandMark className="ml-1 h-7 w-7" />
        <span className="ml-1.5 min-w-0 truncate text-sm font-medium text-sidebar-foreground">
          ClearPing
        </span>

        <span className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant={overviewOpen ? 'primary' : 'ghost'}
            size="sm"
            onClick={onOpenOverview}
            aria-pressed={overviewOpen}
            aria-label="Overview"
          >
            <LayoutDashboard {...ICON} />
          </Button>
          <Button
            type="button"
            variant={alertsOpen ? 'primary' : 'ghost'}
            size="sm"
            onClick={onOpenAlerts}
            aria-pressed={alertsOpen}
            aria-label={firingAlerts > 0 ? `Alerts, ${firingAlerts} firing` : 'Alerts'}
          >
            <Bell {...ICON} />
            {firingAlerts > 0 && <Badge tone="danger" size="sm">{firingAlerts}</Badge>}
          </Button>
        </span>
      </div>
    </div>
  )
}
