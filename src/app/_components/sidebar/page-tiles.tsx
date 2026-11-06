'use client'

import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Check, ChevronDown, Wrench } from 'lucide-react'
import { DropdownMenu } from '@/components/arc/dropdown-menu/dropdown-menu'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { cn } from '@/lib/utils'

/**
 * The pages beside the list, as tiles with their icon in a well: the overview
 * on its own, and the tools (Routing, Game Server Ping) behind one tile that
 * opens a menu of them. Tiles, not rows: as rows they read as more monitors
 * and went unnoticed. Three tiles in a row left each name too little room, so
 * the tools share one, and a tool added later takes no more room.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

/** A page in the menu, or on a tile of its own. */
export interface PageLink {
  key: string
  icon: ReactNode
  label: string
  open: boolean
  /** Without it, while off, it cannot be opened. */
  onOpen?: () => void
  /** Why it is greyed out, when it is turned off. */
  off?: string
  /** Something there wants a look: shown as a count in the warning colour. */
  count?: number
  countLabel?: string
}

function Count({ value, label, className }: { value: number; label?: string; className?: string }) {
  return (
    <span className={cn('rounded-full bg-signal-moderate/15 px-1.5 font-mono text-[10px] tabular-nums text-signal-moderate', className)} aria-label={label}>
      {value}
    </span>
  )
}

/** A tile's button. Takes a ref and the props it is given, so the menu can open from it. */
function Tile({
  icon,
  label,
  open,
  off,
  trailing,
  corner,
  className,
  ...button
}: {
  icon: ReactNode
  label: string
  open: boolean
  off?: boolean
  trailing?: ReactNode
  /** Pinned to the corner of the icon's well, where it takes none of the label's room. */
  corner?: ReactNode
} & ComponentPropsWithRef<'button'>) {
  return (
    <button
      type="button"
      {...button}
      className={cn(
        'flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left text-sm font-medium transition-colors',
        off
          ? 'border-dashed border-sidebar-border text-muted-foreground'
          : open
            ? 'border-primary/60 bg-primary/15 text-sidebar-foreground hover:bg-primary/20'
            : 'border-sidebar-border bg-sidebar-group text-sidebar-foreground hover:border-sidebar-group-border hover:bg-sidebar-row-hover data-[state=open]:bg-sidebar-row-hover',
        button.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        className
      )}
      suppressHydrationWarning
    >
      <span
        className={cn(
          'relative flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
          off ? 'bg-muted text-muted-foreground' : open ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary'
        )}
      >
        {icon}
        {corner && <span className="absolute -top-2 -right-2.5">{corner}</span>}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      {trailing && <span className="ml-auto flex shrink-0 items-center gap-1.5">{trailing}</span>}
    </button>
  )
}

/** One page on a tile of its own. */
export function PageTile({ page }: { page: PageLink }) {
  const tile = (
    <Tile
      icon={page.icon}
      label={page.label}
      open={page.open}
      off={Boolean(page.off)}
      onClick={page.onOpen}
      disabled={!page.onOpen}
      aria-current={page.open ? 'page' : undefined}
      aria-label={page.off ? `${page.label}: ${page.off}` : undefined}
      // Off, it says so in its tooltip: a tag beside the name cut the name short.
      trailing={!page.off && page.count !== undefined ? <Count value={page.count} label={page.countLabel} /> : undefined}
    />
  )
  // A disabled button gives a tooltip nothing to hang on: the span does.
  return page.off ? (
    <Tooltip content={page.off}>
      <span className="flex min-w-0">{tile}</span>
    </Tooltip>
  ) : (
    tile
  )
}

/**
 * The tools behind one tile. While one of them is open the tile is marked as
 * open and its well shows that tool's icon, so it is plain where you are.
 * One tool alone needs no menu, and gets a tile of its own.
 */
export function ToolsTile({ tools }: { tools: PageLink[] }) {
  if (tools.length === 0) return null
  if (tools.length === 1) return <PageTile page={tools[0]} />

  const current = tools.find(tool => tool.open)
  const trouble = tools.reduce((sum, tool) => sum + (tool.off ? 0 : tool.count ?? 0), 0)
  return (
    <DropdownMenu
      label="Tools"
      align="start"
      trigger={
        <Tile
          icon={current?.icon ?? <Wrench {...ICON} />}
          label="Tools"
          open={Boolean(current)}
          aria-label={[current ? `Tools, ${current.label} open` : 'Tools', trouble > 0 ? `${trouble} need a look` : null].filter(Boolean).join(', ')}
          // Solid behind the count, so it reads over the well it overlaps.
          corner={trouble > 0 ? <Count value={trouble} className="bg-sidebar ring-1 ring-signal-moderate/40" /> : undefined}
          trailing={<ChevronDown {...ICON} size={14} className="text-muted-foreground" />}
        />
      }
      items={tools.map(tool => ({
        label: tool.label,
        icon: tool.icon,
        onSelect: tool.onOpen,
        disabled: !tool.onOpen,
        ariaLabel: tool.off ? `${tool.label}: ${tool.off}` : tool.open ? `${tool.label}, open` : tool.countLabel ? `${tool.label}, ${tool.countLabel}` : undefined,
        trailing: tool.off ? (
          <span className="text-xs">Off</span>
        ) : tool.open ? (
          <Check {...ICON} size={14} />
        ) : tool.count !== undefined ? (
          <Count value={tool.count} />
        ) : undefined,
      }))}
    />
  )
}
