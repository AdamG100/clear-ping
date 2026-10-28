'use client'

import { Fragment } from 'react'
import { Badge, type BadgeTone } from '@/components/arc/badge/badge'
import type { BgpExchangeLook, BgpExchangeRoute, BgpExchangeView } from '@/types/bgp'
import { cn } from '@/lib/utils'
import { ago, asLabel, whoseLabel } from './state'

/**
 * "At the exchanges": what each exchange's own route collector has for the
 * prefix (see looking-glass.ts). RIS has no collector at JINX, CINX or DINX;
 * these say whether the origin offers it there itself, or is reached there
 * only through another member.
 */

const MEMBERS_SHOWN = 6

interface Member {
  asn: number
  sessions: number
  /** The shortest path it offers, for what it reaches the origin through. */
  path: number[]
}

function members(routes: readonly BgpExchangeRoute[], origins: readonly number[]): Member[] {
  const byAsn = new Map<number, Member>()
  for (const route of routes) {
    if (origins.includes(route.peerAsn)) continue
    const held = byAsn.get(route.peerAsn)
    if (!held) byAsn.set(route.peerAsn, { asn: route.peerAsn, sessions: 1, path: route.path })
    else {
      held.sessions++
      if (route.path.length < held.path.length) held.path = route.path
    }
  }
  return [...byAsn.values()].sort((a, b) => a.path.length - b.path.length || b.sessions - a.sessions)
}

function standing(view: BgpExchangeView, own: number, was: boolean | null): { label: string; tone: BadgeTone } {
  if (!view.ready) return { label: 'Collector still reading its routes', tone: 'neutral' }
  if (own > 0) return { label: `Offered by the origin itself${own > 1 ? `, ${own} sessions` : ''}`, tone: 'success' }
  if (was) return { label: 'Origin gone from here', tone: 'danger' }
  if (view.routes.length > 0) return { label: 'Only through other members', tone: 'warning' }
  return { label: 'Not offered here', tone: 'neutral' }
}

function Exchange({
  view,
  origins,
  was,
  names,
  mine,
  now,
}: {
  view: BgpExchangeView
  origins: readonly number[]
  was: boolean | null
  names: Record<number, string>
  mine: Record<number, string>
  now: number
}) {
  const own = view.routes.filter(route => origins.includes(route.peerAsn))
  const others = members(view.routes, origins)
  const state = standing(view, own.length, was)
  const since = own.map(route => route.since).filter((at): at is number => at !== null)
  return (
    <article className={cn('min-w-0 space-y-3 rounded-2xl border p-4', state.tone === 'danger' ? 'border-signal-critical/50' : 'border-border')}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">
          {view.exchange}
          {view.city && <span className="font-normal text-muted-foreground"> · {view.city}</span>}
        </h3>
        <Badge size="sm" tone={state.tone}>{state.label}</Badge>
      </header>
      {own.length > 0 && since.length > 0 && now > 0 && (
        <p className="text-xs text-muted-foreground">Offered by the origin here since {ago(Math.min(...since), now)}.</p>
      )}
      {was && own.length === 0 && view.ready && (
        <p className="text-xs text-signal-critical">The origin offered it here itself when normal was taken.</p>
      )}
      {others.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {own.length > 0 ? 'Also offered by' : 'Offered by'} {others.length} member{others.length === 1 ? '' : 's'}
          </p>
          <ul className="space-y-1.5">
            {others.slice(0, MEMBERS_SHOWN).map(member => (
              <li key={member.asn} className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-foreground">{asLabel(member.asn, names)}</span>
                  {member.sessions > 1 && <span className="text-muted-foreground">{member.sessions} sessions</span>}
                  {member.asn in mine && <Badge size="sm" tone="info">{whoseLabel(mine[member.asn])}</Badge>}
                </p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {member.path.map((asn, index) => (
                    <Fragment key={`${asn}-${index}`}>
                      {index > 0 && ' › '}
                      <span title={names[asn]}>{asn}</span>
                    </Fragment>
                  ))}
                </p>
              </li>
            ))}
          </ul>
          {others.length > MEMBERS_SHOWN && <p className="text-xs text-muted-foreground">and {others.length - MEMBERS_SHOWN} more</p>}
        </div>
      )}
    </article>
  )
}

export function ExchangePanel({
  look,
  origins,
  was,
  names,
  mine,
  now,
}: {
  look: BgpExchangeLook | null
  origins: readonly number[]
  /** The exchanges the origin offered it at when normal was taken, if known. */
  was: readonly string[] | undefined
  names: Record<number, string>
  mine: Record<number, string>
  now: number
}) {
  if (!look) return <p className="text-sm text-muted-foreground">Reading the exchanges&apos; route collectors.</p>
  const sources = [...new Set(look.views.map(view => view.source))]
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        From the exchanges&apos; own route collectors{sources.length > 0 ? `, through ${sources.join(', ')}'s looking glass` : ''}, read every 5
        minutes{now > 0 ? `, last ${ago(look.at, now)}` : ''}. RIPE RIS has no collector at these exchanges.
      </p>
      {look.error && <p className="text-xs text-signal-moderate">{look.error}</p>}
      {look.views.length > 0 && (
        <div className="grid gap-3 @3xl/main:grid-cols-2">
          {look.views.map(view => (
            <Exchange
              key={view.exchange}
              view={view}
              origins={origins}
              was={was ? was.includes(view.exchange) : null}
              names={names}
              mine={mine}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  )
}
