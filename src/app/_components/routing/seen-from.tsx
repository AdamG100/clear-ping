'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { inPlace, placeShares, type PlaceShare, type Scope } from '@/lib/bgp/scope'
import { countryName } from '@/lib/bgp/countries'
import { BGP_REGION_LABEL, type BgpPeerRoute } from '@/types/bgp'
import { cn } from '@/lib/utils'
import { shareColor } from './region-visibility'
import { carrierLabel, viaLabel, whoseLabel } from './state'

/**
 * Where in the world the prefix is seen, a level at a time: the five regions,
 * then the countries in the one chosen, then the exchanges in the country.
 * With an upstream chosen, each bar also shows how much of it that upstream
 * carries.
 */

const COUNTRIES_AT_FIRST = 8

function Breadcrumb({ scope, onScope }: { scope: Scope; onScope: (scope: Scope) => void }) {
  const steps: { label: string; to: Scope | null }[] = [
    { label: 'World', to: scope.region ? { ...scope, region: null, country: null } : null },
  ]
  if (scope.region) steps.push({ label: BGP_REGION_LABEL[scope.region], to: scope.country ? { ...scope, country: null } : null })
  if (scope.country) steps.push({ label: countryName(scope.country), to: null })
  return (
    <nav aria-label="Where it is seen from" className="mb-3 flex flex-wrap items-center gap-1 text-xs">
      {steps.map((step, index) => (
        <span key={step.label} className="flex items-center gap-1">
          {index > 0 && <ChevronRight size={12} strokeWidth={1.75} className="text-muted-foreground" aria-hidden="true" />}
          {step.to ? (
            <button
              type="button"
              onClick={() => onScope(step.to!)}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {step.label}
            </button>
          ) : (
            <span className="px-1.5 py-0.5 font-medium text-foreground" aria-current="location">{step.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

function Bar({ row, viaColor }: { row: PlaceShare; viaColor: string | null }) {
  const seen = row.total > 0 ? (row.seen / row.total) * 100 : 0
  const via = row.total > 0 ? (row.via / row.total) * 100 : 0
  return (
    <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: `${seen}%`, background: viaColor ? 'var(--border-strong)' : shareColor(row) }}
      />
      {viaColor && (
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${via}%`, background: viaColor }}
        />
      )}
    </div>
  )
}

export function SeenFrom({
  peers,
  scope,
  onScope,
  colors,
  names,
  mine = {},
}: {
  peers: BgpPeerRoute[]
  scope: Scope
  onScope: (scope: Scope) => void
  colors: Map<number, string>
  names: Record<number, string>
  /** Your networks: the places your sessions are in are marked. */
  mine?: Record<number, string>
}) {
  const [allCountries, setAllCountries] = useState(false)
  const rows = placeShares(peers, scope)
  const level = scope.country ? 'exchange' : scope.region ? 'country' : 'region'
  // Which of yours sees from each place: "Your ISP", a probe agent.
  const yours = new Map<string, Set<string>>()
  for (const peer of peers) {
    if (!(peer.peerAsn in mine) || !inPlace(peer, scope)) continue
    const key = level === 'region' ? peer.region : level === 'country' ? peer.country : peer.collector
    yours.set(key, new Set([...(yours.get(key) ?? []), whoseLabel(mine[peer.peerAsn])]))
  }
  const shown = level === 'country' && !allCountries ? rows.slice(0, COUNTRIES_AT_FIRST) : rows
  const viaColor = scope.upstream !== null ? (colors.get(scope.upstream) ?? 'var(--signal-none)') : null

  const open = (row: PlaceShare) => {
    setAllCountries(false)
    if (level === 'region') onScope({ ...scope, region: row.key as Scope['region'], country: null })
    else if (level === 'country') onScope({ ...scope, country: row.key })
  }

  return (
    <div>
      <Breadcrumb scope={scope} onScope={next => { setAllCountries(false); onScope(next) }} />
      <ul className="space-y-1">
        {shown.map(row => {
          const drills = level !== 'exchange' && row.total > 0
          const content = (
            <>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className={cn('flex min-w-0 items-center gap-2', row.total === 0 && 'text-muted-foreground')}>
                  {row.country && (
                    <span className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">{row.country}</span>
                  )}
                  <span className="truncate">{row.label}</span>
                  {yours.has(row.key) && <Badge size="sm" tone="info">{[...yours.get(row.key)!].join(', ')}</Badge>}
                </span>
                <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
                  {row.total === 0
                    ? 'no peers'
                    : viaColor
                      ? `${row.via} ${viaLabel(scope.upstream!)} · ${row.seen} of ${row.total}`
                      : `${row.seen} of ${row.total}`}
                  {drills && <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />}
                </span>
              </div>
              <Bar row={row} viaColor={viaColor} />
            </>
          )
          const label = `${row.label}: seen by ${row.seen} of ${row.total} peers${viaColor ? `, ${row.via} ${scope.upstream === 0 ? 'directly connected' : `through ${carrierLabel(scope.upstream!, names)}`}` : ''}`
          return (
            <li key={row.key}>
              {drills ? (
                <button
                  type="button"
                  onClick={() => open(row)}
                  aria-label={`${label}. Show ${level === 'region' ? 'its countries' : 'its exchanges'}`}
                  className="block w-full cursor-pointer rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted/50"
                >
                  {content}
                </button>
              ) : (
                <div className="px-2 py-2" aria-label={label}>{content}</div>
              )}
            </li>
          )
        })}
      </ul>
      {level === 'country' && rows.length > COUNTRIES_AT_FIRST && (
        <div className="mt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setAllCountries(value => !value)}>
            {allCountries ? 'Show fewer' : `Show all ${rows.length} countries`}
          </Button>
        </div>
      )}
      {level === 'exchange' && (
        <p className="mt-3 text-xs text-muted-foreground">
          The exchanges whose collectors have peers in {scope.country ? countryName(scope.country) : 'it'}. A multihop
          collector&apos;s peers are placed by where their network is registered.
        </p>
      )}
    </div>
  )
}
