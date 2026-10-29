'use client'

import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, Route } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { SearchField } from '@/components/arc/search-field/search-field'
import { SearchResults } from '@/components/search-results'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import type { BgpExchangeLook, BgpExchangeRoute, BgpExchangeView, BgpPeerRoute } from '@/types/bgp'
import { isDirect } from '@/lib/bgp/path'
import { cn } from '@/lib/utils'
import { ago, asLabel } from './state'

/**
 * "At the exchanges": what each exchange's own route collector has for the
 * prefix (see looking-glass.ts). RIS has no collector at these exchanges;
 * they say whether the origin offers it there itself, or is reached there
 * only through another member. Which exchanges are shown is left to the page,
 * from what the collectors hold and where your traffic crosses: none are
 * named here.
 *
 * One exchange at a time: a tile for each says how it stands there, and the
 * one chosen lists its members, to filter and search, each opening to its
 * sessions. Where your traffic crosses an exchange, by your traces, its tile
 * says so, and the member it goes into is marked.
 */

const ICON = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const
const PAGE = 10

/** Where one of your vantage points' traffic crosses an exchange, by its trace. */
export interface ExchangeCrossing {
  /** "Your ISP", "Probe agent London". */
  whose: string
  /** The exchange as PeeringDB names it, or the ones it probably crossed. */
  exchanges: string[]
  /** The member it went into there, by IXPDB. */
  member: number | null
  /** The address traced to. */
  to: string
  /** A hop on the exchange's LAN, rather than two members either side of one. */
  sure: boolean
}

/** Whether PeeringDB's name for an exchange is the collector's: "JINX" and "JINX", or "Johannesburg Internet Exchange (JINX)". */
export function sameExchange(collector: string, name: string): boolean {
  const a = collector.toLowerCase()
  const b = name.toLowerCase()
  return a === b || b.startsWith(`${a} `) || b.includes(`(${a})`)
}

interface Member {
  asn: number
  routes: BgpExchangeRoute[]
  /** The shortest path it offers, for what it reaches the origin through. */
  path: number[]
  origin: boolean
  best: boolean
}

function membersOf(routes: readonly BgpExchangeRoute[], origins: readonly number[]): Member[] {
  const byAsn = new Map<number, Member>()
  for (const route of routes) {
    const held = byAsn.get(route.peerAsn)
    if (!held) {
      byAsn.set(route.peerAsn, { asn: route.peerAsn, routes: [route], path: route.path, origin: origins.includes(route.peerAsn), best: route.best })
    } else {
      held.routes.push(route)
      held.best ||= route.best
      if (route.path.length < held.path.length) held.path = route.path
    }
  }
  // The origin first, then the shortest way to it.
  return [...byAsn.values()].sort((a, b) => Number(b.origin) - Number(a.origin) || a.path.length - b.path.length || b.routes.length - a.routes.length)
}

function standing(view: BgpExchangeView, own: number, was: boolean | null): { label: string; tone: BadgeTone; color: string } {
  if (!view.ready) return { label: 'Collector still reading its routes', tone: 'neutral', color: 'var(--signal-none)' }
  if (own > 0) return { label: `Offered by the origin itself${own > 1 ? `, ${own} sessions` : ''}`, tone: 'success', color: 'var(--signal-perfect)' }
  if (was) return { label: 'Origin gone from here', tone: 'danger', color: 'var(--signal-critical)' }
  if (view.routes.length > 0) return { label: 'Only through other members', tone: 'warning', color: 'var(--signal-moderate)' }
  return { label: 'Not offered here', tone: 'neutral', color: 'var(--signal-none)' }
}

/** The path a network at a time, the origin brighter, each named on hover. */
function PathChips({ path, names, origins }: { path: number[]; names: Record<number, string>; origins: readonly number[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {path.map((asn, index) => (
        <Fragment key={`${asn}-${index}`}>
          {index > 0 && <span className="text-[10px] text-muted-foreground/60" aria-hidden="true">›</span>}
          <Tooltip content={asLabel(asn, names)}>
            <span
              className={cn(
                'rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-none',
                origins.includes(asn) ? 'border-border-strong text-foreground' : 'border-border text-muted-foreground'
              )}
            >
              {asn}
            </span>
          </Tooltip>
        </Fragment>
      ))}
    </span>
  )
}

/** One exchange as a tile to choose: how it stands, how many offer it there, and whether your traffic crosses it. */
function ExchangeTile({
  view,
  state,
  members,
  crossings,
  chosen,
  onChoose,
}: {
  view: BgpExchangeView
  state: ReturnType<typeof standing>
  members: number
  crossings: ExchangeCrossing[]
  chosen: boolean
  onChoose: () => void
}) {
  const whose = [...new Set(crossings.map(each => each.whose))]
  const sure = crossings.some(each => each.sure)
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      className={cn(
        'flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-2xl border p-3 text-left transition-colors',
        chosen ? 'border-primary/60 bg-primary/10 ring-1 ring-inset ring-primary/40' : 'border-border hover:bg-muted/40'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: state.color }} aria-hidden="true" />
        <span className="truncate text-sm font-medium">{view.exchange}</span>
        {view.city && <span className="truncate text-xs text-muted-foreground">{view.city}</span>}
      </span>
      <span className="truncate text-xs text-muted-foreground">{state.label}</span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{members}</span> member{members === 1 ? '' : 's'} offer it
        {whose.length > 0 && (
          <Badge size="sm" tone="info">
            {sure ? '' : 'Probably '}
            {whose.join(', ')}&apos;s traffic
          </Badge>
        )}
      </span>
    </button>
  )
}

/** A member's row: who it is, what it is to you, its shortest path; opened, every session it has. */
function MemberRow({
  member,
  names,
  origins,
  mine,
  entered,
  now,
}: {
  member: Member
  names: Record<number, string>
  origins: readonly number[]
  mine: Record<number, string>
  /** Yours whose traffic goes into this member here. */
  entered: string[]
  now: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className={cn(entered.length > 0 && 'border-l-2 border-primary bg-primary/[0.07]')}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="grid w-full cursor-pointer gap-x-4 gap-y-1.5 px-3 py-2.5 text-left hover:bg-muted/30 @3xl/main:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] @3xl/main:items-center"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm">
            <span className="font-mono text-xs">AS{member.asn}</span>
            {names[member.asn] && <span className="text-muted-foreground"> {names[member.asn]}</span>}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-1">
            {member.origin && <Badge size="sm" tone="success">The origin</Badge>}
            {member.best && <Badge size="sm">Best route</Badge>}
            {member.asn in mine && <Badge size="sm" tone="info">{mine[member.asn]}</Badge>}
            {entered.length > 0 && <Badge size="sm" tone="info">{entered.join(', ')}&apos;s traffic goes in here</Badge>}
          </span>
        </span>
        <span className="min-w-0">
          {member.path.length <= 1 ? (
            <span className="text-xs text-muted-foreground">Its own announcement</span>
          ) : (
            <PathChips path={member.path} names={names} origins={origins} />
          )}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {member.routes.length} session{member.routes.length === 1 ? '' : 's'}
          <ChevronDown {...ICON} className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <ul className="mx-3 mb-3 divide-y divide-border/60 rounded-xl border border-border bg-muted/30 text-xs">
          {member.routes.map((route, index) => (
            <li key={`${route.gateway}-${route.prefix}-${index}`} className="grid gap-x-4 gap-y-1 px-3 py-2 @3xl/main:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
              <span className="min-w-0">
                <span className="block truncate font-mono">{route.gateway}</span>
                <span className="block text-[11px] text-muted-foreground">Its address on the exchange</span>
              </span>
              <span className="min-w-0 space-y-1">
                <span className="block font-mono text-[11px] text-muted-foreground">{route.prefix}</span>
                <PathChips path={route.path} names={names} origins={origins} />
              </span>
              <span className="text-muted-foreground @3xl/main:text-right">
                {route.best && <span className="block text-foreground">The collector&apos;s best</span>}
                {route.since !== null && now > 0 ? `Since ${ago(route.since, now)}` : 'Since not known'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

type Show = 'all' | 'origin' | 'others' | 'yours'

/** The exchange chosen: how it stands, your traffic there, and its members. */
function ExchangeDetail({
  view,
  state,
  members,
  origins,
  was,
  names,
  mine,
  crossings,
  now,
}: {
  view: BgpExchangeView
  state: ReturnType<typeof standing>
  members: Member[]
  origins: readonly number[]
  was: boolean | null
  names: Record<number, string>
  mine: Record<number, string>
  crossings: ExchangeCrossing[]
  now: number
}) {
  const [show, setShow] = useState<Show>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const enteredBy = (asn: number) => [...new Set(crossings.filter(each => each.member === asn).map(each => each.whose))]
  const yours = (member: Member) => member.asn in mine || enteredBy(member.asn).length > 0
  const counts = {
    all: members.length,
    origin: members.filter(member => member.origin).length,
    others: members.filter(member => !member.origin).length,
    yours: members.filter(yours).length,
  }
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const listed = members.filter(member => {
    if (show === 'origin' && !member.origin) return false
    if (show === 'others' && member.origin) return false
    if (show === 'yours' && !yours(member)) return false
    if (words.length === 0) return true
    const text = [
      `as${member.asn}`,
      names[member.asn] ?? '',
      ...member.routes.flatMap(route => [route.gateway, route.prefix, ...route.path.flatMap(asn => [String(asn), names[asn] ?? ''])]),
    ]
      .join(' ')
      .toLowerCase()
    return words.every(word => text.includes(word))
  })
  // Yours and the one your traffic goes into first among the rest, so they are not on a later page.
  const ordered = [...listed].sort((a, b) => Number(b.origin) - Number(a.origin) || Number(yours(b)) - Number(yours(a)))
  const shown = ordered.slice(0, limit)
  const ownSince = members
    .filter(member => member.origin)
    .flatMap(member => member.routes.map(route => route.since))
    .filter((at): at is number => at !== null)

  return (
    <div className="min-w-0 space-y-3 rounded-2xl border border-border p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {view.exchange}
            {view.city && <span className="font-normal text-muted-foreground"> · {view.city}</span>}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            By its own route collector, read through {view.source}&apos;s looking glass
            {ownSince.length > 0 && now > 0 ? `. The origin last changed its route here ${ago(Math.min(...ownSince), now)}` : ''}.
          </p>
        </div>
        <Badge size="sm" tone={state.tone}>{state.label}</Badge>
      </header>

      {was && counts.origin === 0 && view.ready && (
        <p className="text-xs text-signal-critical">The origin usually offers it here itself, and no longer does: its traffic here now goes through other members.</p>
      )}
      {!view.ready && <p className="text-xs text-muted-foreground">Its collector is still reading its routes, so what is missing here says nothing yet.</p>}

      {crossings.length > 0 && (
        <ul className="space-y-1.5 rounded-xl border border-primary/30 bg-primary/[0.06] p-3">
          {crossings.map(each => (
            <li key={`${each.whose}|${each.to}`} className="flex items-start gap-2 text-xs">
              <Route {...ICON} className="mt-0.5 shrink-0 text-primary" />
              <span>
                {each.whose}&apos;s traffic to <span className="font-mono">{each.to}</span> {each.sure ? 'crosses here' : 'probably crosses here'}
                {each.member !== null ? <>, into {asLabel(each.member, names)}</> : null}
                {!each.sure && each.exchanges.length > 1 ? ` (or ${each.exchanges.filter(name => !sameExchange(view.exchange, name)).join(', ')})` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {members.length > 0 ? (
        <>
          <div className="flex flex-col gap-2 @3xl/main:flex-row @3xl/main:items-center">
            {/* `relative`: see the peer table; the hidden label is placed absolutely. */}
            <div className="relative min-w-0 flex-1 [&_label]:sr-only">
              <SearchField
                label={`Search the members at ${view.exchange}`}
                placeholder="Network, AS number, address or prefix"
                value={query}
                onValueChange={value => {
                  setQuery(value)
                  setLimit(PAGE)
                }}
              />
            </div>
            <SegmentedControl
              label="Which members"
              value={show}
              onValueChange={value => {
                setShow(value as Show)
                setLimit(PAGE)
              }}
              options={[
                { value: 'all', label: `All ${counts.all}` },
                ...(counts.origin > 0 ? [{ value: 'origin', label: `The origin ${counts.origin}` }] : []),
                { value: 'others', label: `Other members ${counts.others}` },
                ...(counts.yours > 0 ? [{ value: 'yours', label: `Yours ${counts.yours}` }] : []),
              ]}
            />
          </div>
          <SearchResults query={`${view.exchange}|${show}|${words.join(' ')}`}>
            {listed.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No member matches.</p>
            ) : (
              <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border">
                {shown.map(member => (
                  <MemberRow key={member.asn} member={member} names={names} origins={origins} mine={mine} entered={enteredBy(member.asn)} now={now} />
                ))}
              </ul>
            )}
          </SearchResults>
          {listed.length > PAGE && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Showing {shown.length} of {listed.length}
              </span>
              {shown.length < listed.length ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => setLimit(listed.length)}>
                  Show all
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={() => setLimit(PAGE)}>
                  Show fewer
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        view.ready && <p className="text-sm text-muted-foreground">No member offers it at {view.exchange}.</p>
      )}
    </div>
  )
}

export function ExchangePanel({
  look,
  origins,
  was,
  names,
  mine,
  crossings = [],
  now,
}: {
  look: BgpExchangeLook | null
  origins: readonly number[]
  /** The exchanges the origin usually offers it at, if known. */
  was: readonly string[] | undefined
  names: Record<number, string>
  mine: Record<number, string>
  /** Where your traffic crosses the exchanges, by your traces. */
  crossings?: ExchangeCrossing[]
  now: number
}) {
  const views = useMemo(() => look?.views ?? [], [look])
  const each = useMemo(
    () =>
      views.map(view => {
        const members = membersOf(view.routes, origins)
        const own = view.routes.filter(route => origins.includes(route.peerAsn)).length
        return {
          view,
          members,
          state: standing(view, own, was ? was.includes(view.exchange) : null),
          crossings: crossings.filter(crossing => crossing.exchanges.some(name => sameExchange(view.exchange, name))),
        }
      }),
    [views, origins, was, crossings]
  )
  // At first, the one your traffic crosses for sure, then where it is in trouble, then where the origin offers it.
  const first =
    each.find(one => one.crossings.some(crossing => crossing.sure)) ??
    each.find(one => one.state.tone === 'danger') ??
    each.find(one => one.state.tone === 'success') ??
    each[0]
  const [chosen, setChosen] = useState<string | null>(null)
  const current = each.find(one => one.view.exchange === chosen) ?? first

  if (!look) return <Skeleton label="Reading the exchanges' route collectors" lines={3} />
  const sources = [...new Set(views.map(view => view.source))]
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        From the exchanges&apos; own route collectors{sources.length > 0 ? `, through ${sources.join(', ')}'s looking glass` : ''}, read every 5
        minutes{now > 0 ? `, last ${ago(look.at, now)}` : ''}. RIPE RIS has no collector at {views.length === 1 ? 'this exchange' : 'these exchanges'}.
        {views.length > 1 ? ' Choose one to see its members.' : ''}
      </p>
      {look.error && <p className="text-xs text-signal-moderate">{look.error}</p>}
      {each.length > 1 && (
        <div className="grid grid-cols-1 gap-2 @xl/main:grid-cols-2 @5xl/main:grid-cols-4" role="group" aria-label="Exchanges">
          {each.map(one => (
            <ExchangeTile
              key={one.view.exchange}
              view={one.view}
              state={one.state}
              members={one.members.length}
              crossings={one.crossings}
              chosen={one === current}
              onChoose={() => setChosen(one.view.exchange)}
            />
          ))}
        </div>
      )}
      {current && (
        <ExchangeDetail
          // A fresh filter and search for each exchange.
          key={current.view.exchange}
          view={current.view}
          state={current.state}
          members={current.members}
          origins={origins}
          was={was ? was.includes(current.view.exchange) : null}
          names={names}
          mine={mine}
          crossings={current.crossings}
          now={now}
        />
      )}
    </div>
  )
}

/** RIPE RIS collectors shown before the rest are only counted. */
const RIS_SHOWN = 8

/**
 * The exchanges RIPE RIS has a collector at (NAPAfrica, LINX, DE-CIX and the
 * rest), and how the prefix looks there: how many of the collector's peers
 * carry it, and how many reach the origin with nothing in between. These
 * exchanges publish no looking glass ClearPing reads, so this is what is known
 * of them, from RIS's own sessions there.
 */
export function RisExchanges({ peers }: { peers: readonly BgpPeerRoute[] }) {
  const [all, setAll] = useState(false)
  const byCollector = new Map<string, { exchange: string; city: string; collector: string; total: number; carrying: number; direct: number }>()
  for (const peer of peers) {
    const [city, exchange] = peer.location.split(', ')
    // A multihop collector is at no exchange: its peers are anywhere.
    if (!exchange) continue
    const row = byCollector.get(peer.collector) ?? { exchange, city, collector: peer.collector, total: 0, carrying: 0, direct: 0 }
    row.total++
    if (peer.route) {
      row.carrying++
      if (isDirect(peer.route.path)) row.direct++
    }
    byCollector.set(peer.collector, row)
  }
  const rows = [...byCollector.values()].sort((a, b) => b.direct - a.direct || b.carrying - a.carrying || a.exchange.localeCompare(b.exchange))
  if (rows.length === 0) return null
  const shown = all ? rows : rows.slice(0, RIS_SHOWN)

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Also seen at these exchanges by RIPE RIS, which has a route collector at each. Directly: the peer reaches the origin with no
        network in between.
      </p>
      <ul className="grid gap-2 @2xl/main:grid-cols-2">
        {shown.map(row => (
          <li key={row.collector} className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm">{row.exchange}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {row.city} · {row.collector}
              </span>
            </span>
            <span className="shrink-0 text-right text-xs">
              <span className={cn('block', row.carrying === 0 ? 'text-signal-critical' : 'text-foreground')}>
                {row.carrying} of {row.total} peer{row.total === 1 ? '' : 's'}
              </span>
              <span className="block text-muted-foreground">{row.direct > 0 ? `${row.direct} directly` : 'none directly'}</span>
            </span>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>
          Show all {rows.length} exchanges
        </Button>
      )}
    </div>
  )
}
