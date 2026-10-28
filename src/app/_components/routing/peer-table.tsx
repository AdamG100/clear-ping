'use client'

import { Fragment, useMemo, useState } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { SearchField } from '@/components/arc/search-field/search-field'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { hops } from '@/lib/bgp/path'
import { upstreamOfPeer } from '@/lib/bgp/scope'
import { BGP_DIRECT, BGP_REGIONS, type BgpPeerRoute, type BgpUpstreamShare } from '@/types/bgp'
import { cn } from '@/lib/utils'
import { ago, whoseLabel, whoseNetwork } from './state'

/**
 * Every collector peer in the page's scope and the route it has, by the
 * exchange it is at: the detail behind the bars, down to the AS path each one
 * sees. A peer that saw the prefix when normal was taken and no longer does is
 * listed with no route.
 */

const PAGE = 30

type Show = 'all' | 'mine' | 'direct' | 'missing' | 'new'

function Hop({ asn, names, color, origin }: { asn: number; names: Record<number, string>; color?: string; origin?: boolean }) {
  return (
    <Tooltip content={names[asn] ? `AS${asn} ${names[asn]}` : `AS${asn}`}>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-none',
          color || origin ? 'border-border-strong text-foreground' : 'border-border text-muted-foreground'
        )}
        style={color ? { borderColor: `color-mix(in oklab, ${color} 60%, var(--border))`, background: `color-mix(in oklab, ${color} 12%, transparent)` } : undefined}
      >
        {color && <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden="true" />}
        {asn}
      </span>
    </Tooltip>
  )
}

/** The path after the peer itself, which has its own column: the networks in between, the upstream marked, then the origin. */
function AsPath({ peer, names, colors }: { peer: BgpPeerRoute; names: Record<number, string>; colors: Map<number, string> }) {
  const path = peer.route?.path ?? []
  const each = hops(path)
  const prepends = path.length - each.length
  const upstream = upstreamOfPeer(peer)
  const after = each.slice(1)
  if (after.length === 0) return <span className="text-xs text-muted-foreground">Announced by the peer itself</span>
  if (upstream === BGP_DIRECT) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <span
          className="rounded-md px-1.5 py-0.5 text-[11px] leading-none"
          style={{ color: colors.get(BGP_DIRECT), background: `color-mix(in oklab, ${colors.get(BGP_DIRECT)} 14%, transparent)` }}
        >
          Directly connected
        </span>
        <span className="text-[10px] text-muted-foreground/60" aria-hidden="true">›</span>
        <Hop asn={after[after.length - 1]} names={names} origin />
        {prepends > 0 && <span className="text-[10px] text-muted-foreground">+{prepends} prepended</span>}
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {after.map((asn, index) => (
        <Fragment key={`${asn}-${index}`}>
          {index > 0 && <span className="text-[10px] text-muted-foreground/60" aria-hidden="true">›</span>}
          <Hop
            asn={asn}
            names={names}
            color={asn === upstream && index === after.length - 2 ? colors.get(asn) : undefined}
            origin={index === after.length - 1}
          />
        </Fragment>
      ))}
      {prepends > 0 && <span className="text-[10px] text-muted-foreground">+{prepends} prepended</span>}
    </span>
  )
}

function PeerRow({
  peer,
  prefix,
  names,
  colors,
  unusual,
  whose,
  now,
}: {
  peer: BgpPeerRoute
  prefix: string
  names: Record<number, string>
  colors: Map<number, string>
  unusual: boolean
  /** Whose network the peer is, when it is one of yours: "This server", or a probe agent's name. */
  whose: string | undefined
  now: number
}) {
  const dot = !peer.route ? 'var(--signal-critical)' : unusual ? 'var(--signal-moderate)' : 'var(--signal-perfect)'
  const name = peer.peerAsn > 0 ? names[peer.peerAsn] : undefined
  return (
    <li
      className={cn(
        'grid gap-x-4 gap-y-1.5 px-3 py-2.5 @3xl/main:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_6.5rem] @3xl/main:items-center',
        !peer.route && 'bg-signal-critical/5',
        whose && 'border-l-2 border-primary bg-primary/[0.07]'
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: dot }} aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate text-sm">
            {peer.peerAsn > 0 ? <span className="font-mono text-xs">AS{peer.peerAsn}</span> : <span className="text-muted-foreground">Unknown network</span>}
            {name && <span className="text-muted-foreground"> {name}</span>}
          </span>
          {whose && (
            // Its network is named on the line above: the badge says only whose it is, kept to the column.
            <span className="mt-0.5 block max-w-full overflow-hidden" title={whoseNetwork(whose, peer.peerAsn, names)}>
              <Badge size="sm" tone="info">{whoseLabel(whose)}</Badge>
            </span>
          )}
          <span className="block truncate font-mono text-[11px] text-muted-foreground">{peer.peer}</span>
        </span>
      </div>
      <div className="min-w-0 pl-4.5 @3xl/main:pl-0">
        {peer.route ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AsPath peer={peer} names={names} colors={colors} />
            {peer.route.prefix !== prefix && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">via {peer.route.prefix}</span>
            )}
            {unusual && <span className="text-[11px] text-signal-moderate">New upstream</span>}
          </div>
        ) : (
          <span className="text-xs text-signal-critical">No route: it saw the prefix when normal was taken, and no longer does</span>
        )}
      </div>
      <div className="pl-4.5 text-xs text-muted-foreground @3xl/main:pl-0 @3xl/main:text-right">
        {peer.route ? <span title="When this peer took the route it has">{ago(peer.route.since, now)}</span> : 'Withdrawn'}
      </div>
    </li>
  )
}

export function PeerTable({
  peers,
  prefix,
  upstreams,
  names,
  colors,
  mine = {},
  now,
}: {
  /** The peers in the page's scope. */
  peers: BgpPeerRoute[]
  prefix: string
  upstreams: BgpUpstreamShare[]
  names: Record<number, string>
  colors: Map<number, string>
  /** Your networks, and whose each is: their sessions are marked, and listed first. */
  mine?: Record<number, string>
  now: number
}) {
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [limit, setLimit] = useState(PAGE)

  const unusualUpstreams = useMemo(() => new Set(upstreams.filter(each => !each.expected).map(each => each.asn)), [upstreams])
  const isUnusual = (peer: BgpPeerRoute) => {
    const upstream = upstreamOfPeer(peer)
    return upstream !== null && unusualUpstreams.has(upstream)
  }

  const isMine = (peer: BgpPeerRoute) => peer.peerAsn in mine
  const counts = {
    all: peers.length,
    mine: peers.filter(isMine).length,
    direct: peers.filter(peer => upstreamOfPeer(peer) === BGP_DIRECT).length,
    missing: peers.filter(peer => !peer.route).length,
    new: peers.filter(isUnusual).length,
  }

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (peer: BgpPeerRoute) => {
    if (show === 'missing' && peer.route) return false
    if (show === 'mine' && !isMine(peer)) return false
    if (show === 'direct' && upstreamOfPeer(peer) !== BGP_DIRECT) return false
    if (show === 'new' && !isUnusual(peer)) return false
    if (words.length === 0) return true
    const text = [
      `as${peer.peerAsn}`,
      names[peer.peerAsn] ?? '',
      peer.peer,
      peer.collector,
      peer.location,
      peer.country,
      peer.route?.prefix ?? '',
      ...(peer.route?.path ?? []).flatMap(asn => [`as${asn}`, String(asn), names[asn] ?? '']),
    ]
      .join(' ')
      .toLowerCase()
    return words.every(word => text.includes(word))
  }

  // By exchange: in region order, then by how many peers each has. Those
  // without a route first within each, as they are what to look at.
  const listed = peers
    .filter(matches)
    .sort(
      (a, b) =>
        BGP_REGIONS.indexOf(a.region) - BGP_REGIONS.indexOf(b.region) ||
        a.country.localeCompare(b.country) ||
        a.collector.localeCompare(b.collector) ||
        Number(isMine(b)) - Number(isMine(a)) ||
        Number(!!a.route) - Number(!!b.route) ||
        Number(isUnusual(b)) - Number(isUnusual(a)) ||
        a.peerAsn - b.peerAsn
    )
  const shown = listed.slice(0, limit)
  const groups: { key: string; peers: BgpPeerRoute[] }[] = []
  for (const peer of shown) {
    const key = `${peer.country}|${peer.collector}`
    if (groups.at(-1)?.key === key) groups.at(-1)!.peers.push(peer)
    else groups.push({ key, peers: [peer] })
  }
  const groupTotals = new Map<string, { seen: number; total: number }>()
  for (const peer of peers) {
    const key = `${peer.country}|${peer.collector}`
    const total = groupTotals.get(key) ?? { seen: 0, total: 0 }
    total.total++
    if (peer.route) total.seen++
    groupTotals.set(key, total)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 @3xl/main:flex-row @3xl/main:items-center">
        {/* `relative`: the label, hidden but for screen readers, is placed
            absolutely, and with nothing positioned around it, it was placed on
            the page, far below the pane, and made the whole page scroll. */}
        <div className="relative min-w-0 flex-1 [&_label]:sr-only">
          <SearchField
            label="Search collector peers"
            placeholder="Network, AS number, address or exchange"
            value={query}
            onValueChange={value => {
              setQuery(value)
              setLimit(PAGE)
            }}
          />
        </div>
        <SegmentedControl
          label="Which peers"
          value={show}
          onValueChange={value => {
            setShow(value as Show)
            setLimit(PAGE)
          }}
          options={[
            { value: 'all', label: `All ${counts.all}` },
            ...(counts.mine > 0 ? [{ value: 'mine', label: `Your networks ${counts.mine}` }] : []),
            { value: 'direct', label: `Direct ${counts.direct}` },
            { value: 'missing', label: `No route ${counts.missing}` },
            { value: 'new', label: `New upstream ${counts.new}` },
          ]}
        />
      </div>

      {listed.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {peers.length === 0 ? 'No collector peer here.' : 'No peer matches.'}
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group, index) => {
            const first = group.peers[0]
            const totals = groupTotals.get(group.key)
            return (
              <section key={`${group.key}-${index}`} className="overflow-hidden rounded-2xl border border-border" aria-label={`${first.location}, ${first.collector}`}>
                <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-3 py-2">
                  <span className="rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">{first.country}</span>
                  <span className="text-sm font-medium">{first.location}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{first.collector}</span>
                  {totals && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {totals.seen} of {totals.total} see it
                    </span>
                  )}
                </header>
                <ul className="divide-y divide-border/60">
                  {group.peers.map(peer => (
                    <PeerRow
                      key={`${peer.collector}|${peer.peer}`}
                      peer={peer}
                      prefix={prefix}
                      names={names}
                      colors={colors}
                      unusual={isUnusual(peer)}
                      whose={mine[peer.peerAsn]}
                      now={now}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}

      {listed.length > PAGE && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Showing {shown.length} of {listed.length}
          </span>
          {shown.length < listed.length && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setLimit(value => value + PAGE * 2)}>
              Show more
            </Button>
          )}
          {shown.length < listed.length && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setLimit(listed.length)}>
              Show all
            </Button>
          )}
          {shown.length >= listed.length && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setLimit(PAGE)}>
              Show fewer
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
