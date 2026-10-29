'use client'

import { Fragment, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { countryName } from '@/lib/bgp/countries'
import { hops, upstreamOf } from '@/lib/bgp/path'
import { displayTimeZone, wallClock } from '@/lib/time-zone'
import { cn } from '@/lib/utils'
import { BGP_DIRECT, BGP_REGION_LABEL, type BgpPeerRoute, type BgpUpdate } from '@/types/bgp'
import { ago, asLabel, carrierLabel } from './state'

/**
 * Exactly what arrived: each update a peer sent, the path it announced or the
 * route it withdrew, set against the path it had before, so a move from
 * peering to transit reads as one line. Open one for the whole of it: what
 * was announced or withdrawn, by whom and where, each network on the path
 * before and after, and the route that peer has now.
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
  if (update.kind === 'withdraw') {
    return was === null
      ? `This peer no longer has a route to ${update.prefix}`
      : `This peer no longer has a route to ${update.prefix}. It went ${through(was)}`
  }
  // Recorded before the path before was kept: what it replaced is not known.
  if (update.previousPath === undefined) return `Announced, ${through(now)}`
  if (update.previousPath === null) return `New route, ${through(now)}: it had none before`
  if (samePath(update.path, update.previousPath)) return 'Announced again on the same path: something else about the route changed'
  if (now !== was) return `Now ${through(now)}, was ${through(was)}`
  return 'Same way in, by a different path'
}

/** A path a network at a time, each named, and what it is to the route: the peer, the upstream, the origin. */
function PathSteps({ path, names }: { path: number[]; names: Record<number, string> }) {
  const each = hops(path)
  const carrier = upstreamOf(path)
  const prepended = path.length - each.length
  return (
    <ol className="mt-1 space-y-0.5">
      {each.map((asn, index) => {
        const role =
          index === each.length - 1 ? 'Origin' : index === 0 ? 'The peer' : carrier !== BGP_DIRECT && index === each.length - 2 ? 'Upstream' : null
        return (
          <li key={`${asn}-${index}`} className="flex min-w-0 items-baseline gap-2 text-xs">
            <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="min-w-0 truncate">
              <span className="font-mono">AS{asn}</span>
              {names[asn] && <span className="text-muted-foreground"> {names[asn]}</span>}
            </span>
            {role && <span className="shrink-0 text-[10px] text-muted-foreground">{role}</span>}
          </li>
        )
      })}
      {prepended > 0 && (
        <li className="pl-6 text-[11px] text-muted-foreground">
          With {prepended} repeat{prepended === 1 ? '' : 's'} of a network (prepending) left out
        </li>
      )}
    </ol>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-xs">{children}</dd>
    </div>
  )
}

/** All of one update: what, from whom and where, the path before and after, and what that peer has now. */
function UpdateDetail({
  update,
  prefix,
  names,
  peer,
  now,
}: {
  update: BgpUpdate
  prefix: string
  names: Record<number, string>
  /** The peer as the page lists it now, with its route, if it is listed. */
  peer: BgpPeerRoute | undefined
  now: number
}) {
  const withdrawn = update.kind === 'withdraw'
  const current = peer?.route ?? null
  const carrier = current ? upstreamOf(current.path) : null
  return (
    <dl className="mt-2 grid gap-x-6 gap-y-3 rounded-xl border border-border bg-muted/30 p-3 @2xl/main:grid-cols-2">
      <Fact label={withdrawn ? 'What was withdrawn' : 'What was announced'}>
        <span className="font-mono">{update.prefix}</span>
        {update.prefix === prefix ? ', the prefix watched' : `, a more-specific of ${prefix}`}
      </Fact>
      <Fact label="Seen by">
        <span className="block">
          {update.peerAsn > 0 ? asLabel(update.peerAsn, names) : 'A peer whose network is not known'}, from{' '}
          <span className="font-mono">{update.peer}</span>
        </span>
        <span className="block text-muted-foreground">
          To RIPE&apos;s route collector {update.collector} at {update.location}
          {peer ? `, placed in ${countryName(peer.country)} (${BGP_REGION_LABEL[peer.region]})` : ''}
        </span>
      </Fact>
      <Fact label={withdrawn ? 'The route it withdrew' : 'The route before'}>
        {update.previousPath === undefined ? (
          <span className="text-muted-foreground">Unknown: recorded before ClearPing kept earlier routes</span>
        ) : update.previousPath === null || update.previousPath.length === 0 ? (
          <span className="text-muted-foreground">None: this is a new route</span>
        ) : (
          <PathSteps path={update.previousPath} names={names} />
        )}
      </Fact>
      {!withdrawn && update.path && (
        <Fact label="The route announced">
          <PathSteps path={update.path} names={names} />
        </Fact>
      )}
      <Fact label="What that peer has now">
        {current && carrier !== null ? (
          <>
            <span className="block">
              A route to <span className="font-mono">{current.prefix}</span>, {carrier === BGP_DIRECT ? 'directly connected' : `through ${carrierLabel(carrier, names)}`},
              taken {ago(current.since, now)}
            </span>
            {withdrawn && current.prefix !== update.prefix && (
              <span className="block text-muted-foreground">So it can still reach those addresses that way.</span>
            )}
          </>
        ) : (
          <span className="text-signal-critical">No route into the prefix at all</span>
        )}
      </Fact>
    </dl>
  )
}

export function UpdateList({
  updates,
  prefix,
  names,
  colors,
  sliceLabel,
  onClearSlice,
  mine = {},
  peers = [],
  now,
}: {
  /** Already narrowed to the page's scope and any slice of time chosen. */
  updates: BgpUpdate[]
  prefix: string
  names: Record<number, string>
  colors: Map<number, string>
  /** The stretch of time chosen on the strip, when one is. */
  sliceLabel: string | null
  onClearSlice: () => void
  /** Your networks, and whose each is said plainly: their updates are marked. */
  mine?: Record<number, string>
  /** Every peer the page lists, for the route each has now. */
  peers?: BgpPeerRoute[]
  now: number
}) {
  const [limit, setLimit] = useState(PAGE)
  // Those opened, or, for the one a bar holding just one opens itself, closed.
  const [toggled, setToggled] = useState<Set<number>>(new Set())
  const shown = updates.slice(0, limit)
  const peerAt = new Map(peers.map(peer => [`${peer.collector}|${peer.peer}`, peer]))
  const only = sliceLabel && updates.length === 1 ? updates[0].id : null
  const toggle = (id: number) =>
    setToggled(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className="space-y-2">
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Each update is one network that feeds a RIPE route collector (a peer) reporting its own route to this prefix.
        Announced: the peer has a new or changed route. Withdrew: that peer lost its route, which on its own is a problem
        at or near that peer. When the prefix itself is pulled, nearly every peer withdraws within seconds and the
        prefix is marked withdrawn.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {updates.length === 0 ? 'No updates' : `${updates.length} update${updates.length === 1 ? '' : 's'}`}
          {sliceLabel ? ` from ${sliceLabel}` : ', newest first'}
          {updates.length > 0 && '. Open one for the whole of it'}
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
            const expanded = toggled.has(update.id) !== (update.id === only)
            return (
              <li key={update.id} className={cn('px-3 py-2.5', update.peerAsn in mine && 'border-l-2 border-primary bg-primary/[0.07]')}>
                <div
                  // The whole row opens it; its button is the way in from the keyboard.
                  onClick={event => {
                    if (!(event.target as HTMLElement).closest('button')) toggle(update.id)
                  }}
                  className="grid cursor-pointer gap-x-4 gap-y-1 @3xl/main:grid-cols-[5rem_minmax(0,14rem)_minmax(0,1fr)_auto]"
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
                          {mine[update.peerAsn]}
                        </Badge>
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge size="sm" tone={update.kind === 'withdraw' ? 'danger' : repeat ? 'neutral' : 'info'}>
                        {update.kind === 'withdraw' ? 'Peer withdrew' : repeat ? 'Peer announced again' : 'Peer announced'}
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
                        <Path path={update.previousPath} names={names} colors={colors} faded={update.kind === 'announce'} />
                      </span>
                    )}
                  </span>
                  <span className="@3xl/main:self-start">
                    <button
                      type="button"
                      onClick={() => toggle(update.id)}
                      aria-expanded={expanded}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-primary hover:bg-muted"
                    >
                      {expanded ? 'Less' : 'Details'}
                      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className={cn('transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
                    </button>
                  </span>
                </div>
                {expanded && <UpdateDetail update={update} prefix={prefix} names={names} peer={peerAt.get(`${update.collector}|${update.peer}`)} now={now} />}
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
