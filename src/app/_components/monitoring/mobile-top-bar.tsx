'use client'

import { Bell, Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BrandMark } from './brand-mark'

interface MobileTopBarProps {
  sidebarOpen: boolean
  onOpenSidebar: () => void
  /** Whether the alerts screen is what the main pane is showing. */
  alertsOpen: boolean
  onOpenAlerts: () => void
  /** How many alerts are firing on at least one target. */
  firingAlerts: number
}

const BAR_BUTTON =
  'relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground ' +
  'transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground'

/**
 * What stands in for the sidebar where there is no room to keep it on screen:
 * the way to open it, and the count of firing alerts, which the sidebar shows
 * from every screen and which must not disappear along with it.
 */
export function MobileTopBar({ sidebarOpen, onOpenSidebar, alertsOpen, onOpenAlerts, firingAlerts }: MobileTopBarProps) {
  return (
    <div className="shrink-0 border-b border-sidebar-border bg-sidebar pt-(--safe-top) pl-(--safe-left) pr-(--safe-right) lg:hidden">
      <div className="flex h-12 items-center gap-1 px-1">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          aria-label="Open targets"
          className={BAR_BUTTON}
        >
          <Menu className="h-5 w-5" />
        </button>

        <BrandMark className="ml-1 h-7 w-7" />
        <span className="ml-1.5 min-w-0 truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
          ClearPing
        </span>

        <button
          type="button"
          onClick={onOpenAlerts}
          aria-pressed={alertsOpen}
          aria-label={firingAlerts > 0 ? `Alerts, ${firingAlerts} firing` : 'Alerts'}
          className={cn(BAR_BUTTON, 'ml-auto', alertsOpen && 'bg-sidebar-accent text-sidebar-foreground')}
        >
          <Bell className="h-5 w-5" />
          {firingAlerts > 0 && (
            <span
              className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-destructive px-1 py-0.5 text-center text-[10px] font-semibold leading-none text-white"
              aria-hidden="true"
            >
              {firingAlerts}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
