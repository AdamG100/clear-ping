'use client'

import { Fragment, useState } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { hops, upstreamOf } from '@/lib/bgp/path'
import { displayTimeZone, wallClock } from '@/lib/time-zone'
import { BGP_DIRECT, type BgpUpdate } from '@/types/bgp'
import { asLabel, carrierLabel, whoseLabel } from './state'

/**
 * Exactly what arrived: each update a peer sent, the path it announced or the
 * route it withdrew, set against the path it had before, so a move from
 * peering to transit reads as one line.
 */

const PAGE = 40

function clock(time: number): string {
  const { hour, minute, second } = wallClock(time, displayTimeZone())
  return [hour, minute, second].map(part => String(part).padStart(2, '0')).join(':')
}

function samePath(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((asn, index) => asn === b[index])
}

function Path({ path, names, colors, faded = false }: { path: number[]; names: Record<number, string>; colors: Map<number, string>; faded?: boolean }) {
  const each = hops(path)
  const carrier = upstreamOf(path)
  return (
    <span className={`font-mono text-[11px] ${faded ? 'text-muted-foreground/70 line-through decoration-muted-foreground/40' : 'text-muted-foreground'}`}>
      {each.map((asn, index) => {
        const isCarrier = carrier !== BGP_DIRECT && index === each.length - 2
        return (
          <Fragment key={`${asn}-${index}`}>
            {index > 0 && ' › '}
            <Tooltip content={asLabel(asn, names)}>
              <span
                className={isCarrier || index === each.length - 1 ? 'text-foreground' : undefined}
                style={isCarrier && !faded ? { boxShadow: `inset 0 -2px 0 ${colors.get(asn) ?? 'var(--border-strong)'}` } : undefined}
              >
                {asn}
              </span>
            </Tooltip>
          </Fragment>
        )
      })}
    </span>
  )
}

/** What the update changed, in words. */
function summary(update: BgpUpdate, names: Record<number, string>): string {
  const now = update.path ? upstreamOf(update.path) : null
  const was = update.previousPath ? upstreamOf(update.previousPath) : null
  const through = (carrier: number | null) => (carrier === BGP_DIRECT ? 'directly connected' : carrier === null ? 'nothing' : `through ${carrierLabel(carrier, names)}`)
  if (update.kind === 'withdraw') return was === null ? 'Withdrew its route' : `Withdrew its route, which was ${through(was)}`
  // Recorded before the path before was kept: what it replaced is not known.
  if (update.previousPath === undefined) return `Announced, ${through(now)}`
  if (update.previousPath === null) return `New route, ${through(now)}: it had none before`
  if (samePath(update.path, update.previousPath)) return 'Announced again on the same path: something else about the route changed'
  if (now !== was) return `Now ${through(now)}, was ${through(was)}`
  return 'Same way in, by a different path'
}

export function UpdateList({
  updates,
  prefix,
  names,
  colors,
  sliceLabel,
  onClearSlice,
  mine = {},
}: {
  /** Already narrowed to the page's scope and any slice of time chosen. */
  updates: BgpUpdate[]
  prefix: string
  names: Record<number, string>
  colors: Map<number, string>
  /** The stretch of time chosen on the strip, when one is. */
  sliceLabel: string | null
  onClearSlice: () => void
  /** Your networks: their updates are marked. */
  mine?: Record<number, string>
}) {
  const [limit, setLimit] = useState(PAGE)
  const shown = updates.slice(0, limit)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {updates.length === 0 ? 'No updates' : `${updates.length} update${updates.length === 1 ? '' : 's'}`}
          {sliceLabel ? ` from ${sliceLabel}` : ', newest first'}
        </span>
        {sliceLabel && (
          <Button type="button" variant="ghost" size="sm" onClick={onClearSlice}>
            Show the whole day
          </Button>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border">
          {shown.map(update => {
            const repeat = update.kind === 'announce' && samePath(update.path, update.previousPath)
            return (
              <li
                key={update.id}
                className={`grid gap-x-4 gap-y-1 px-3 py-2.5 @3xl/main:grid-cols-[5rem_minmax(0,14rem)_minmax(0,1fr)] ${update.peerAsn in mine ? 'border-l-2 border-primary bg-primary/[0.07]' : ''}`}
              >
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{clock(update.at)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {update.peerAsn > 0 ? <span className="font-mono text-xs">AS{update.peerAsn}</span> : 'A peer'}
                    {names[update.peerAsn] && <span className="text-muted-foreground"> {names[update.peerAsn]}</span>}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {update.location} · {update.collector}
                  </span>
                  {update.peerAsn in mine && (
                    <span className="mt-0.5 block">
                      <Badge size="sm" tone="info">
                        {whoseLabel(mine[update.peerAsn])}
                      </Badge>
                    </span>
                  )}
                </span>
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge size="sm" tone={update.kind === 'withdraw' ? 'danger' : repeat ? 'neutral' : 'info'}>
                      {update.kind === 'withdraw' ? 'Withdrawn' : repeat ? 'Announced again' : 'Announced'}
                    </Badge>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {update.prefix}
                      {update.prefix !== prefix && <span className="font-sans"> (more specific)</span>}
                    </span>
                  </span>
                  <span className="block text-xs">{summary(update, names)}</span>
                  {update.path && <span className="block"><Path path={update.path} names={names} colors={colors} /></span>}
                  {update.previousPath && update.previousPath.length > 0 && !repeat && (
                    <span className="block">
                      <span className="mr-1.5 text-[10px] text-muted-foreground">was</span>
                      <Path path={update.previousPath} names={names} colors={colors} faded />
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {updates.length > limit && (
        <Button type="button" variant="secondary" size="sm" onClick={() => setLimit(value => value + PAGE)}>
          Show {Math.min(PAGE, updates.length - limit)} more
        </Button>
      )}
    </div>
  )
}
