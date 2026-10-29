'use client'

import { useState } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import type { BgpPathCrossing } from '@/types/bgp'
import { countryName } from '@/lib/bgp/countries'
import { asLabel } from './state'

/**
 * "At the exchanges": the exchanges on the way to the prefix from your own
 * networks, wherever in the world they are, as the page's BGP data and your
 * traceroutes show them. None are named here: every one comes from PeeringDB.
 */

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

/** Whether two names are one exchange's: a short name and PeeringDB's longer one, "XYZ-IX" and "Example City Exchange (XYZ-IX)". */
function sameExchange(short: string, name: string): boolean {
  const a = short.toLowerCase()
  const b = name.toLowerCase()
  return a === b || b.startsWith(`${a} `) || b.includes(`(${a})`)
}

/** Exchanges listed before the rest wait behind "Show all". */
const ON_THE_WAY_SHOWN = 10

/**
 * The exchanges anywhere in the world on the way to the prefix from your own
 * networks: where two networks next to each other on your ISP's route, or on
 * the way your traceroute went, are members of the same exchange (by
 * PeeringDB), and where a traceroute crossed one for sure.
 */
export function ExchangesOnTheWay({
  crossings,
  traced,
  names,
}: {
  crossings: readonly BgpPathCrossing[]
  /** Your traceroutes' crossings: a sure one marks its exchange, or adds it. */
  traced: readonly ExchangeCrossing[]
  names: Record<number, string>
}) {
  const [all, setAll] = useState(false)
  const tracedAt = (name: string) => traced.some(crossing => crossing.sure && crossing.exchanges.some(each => each === name || sameExchange(name, each)))

  const rows = crossings
  // Crossed by a traceroute and on no path: still on the way, for your traffic.
  const onlyTraced = [...new Set(traced.filter(crossing => crossing.sure).flatMap(crossing => crossing.exchanges))].filter(
    name => !rows.some(row => row.exchanges.some(exchange => exchange.name === name || sameExchange(exchange.name, name)))
  )
  if (rows.length === 0 && onlyTraced.length === 0) return null
  const shown = all ? rows : rows.slice(0, ON_THE_WAY_SHOWN)

  return (
    <div className="space-y-2">
      <ul className="grid gap-2 @3xl/main:grid-cols-2">
        {shown.map(row => {
          const title = row.exchanges.map(exchange => exchange.name).join(' or ')
          const place = [...new Set(row.exchanges.map(exchange => [exchange.city, countryName(exchange.country)].filter(Boolean).join(', ')))].join(' or ')
          const sure = row.exchanges.some(exchange => tracedAt(exchange.name))
          return (
            <li key={title} className="space-y-1.5 rounded-xl border border-border px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm">{title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{place}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted-foreground">From {row.from.join(', ')}</span>
              </div>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {row.handoffs.slice(0, 2).map(handoff => (
                  <li key={`${handoff.from}>${handoff.to}`} className="truncate">
                    {asLabel(handoff.from, names)} → {asLabel(handoff.to, names)}
                  </li>
                ))}
                {row.handoffs.length > 2 && <li>and {row.handoffs.length - 2} more hand-offs</li>}
              </ul>
              {sure && <Badge size="sm" tone="success">Your traceroute crosses it</Badge>}
            </li>
          )
        })}
        {onlyTraced.map(name => (
          <li key={`traced:${name}`} className="space-y-1.5 rounded-xl border border-border px-3 py-2.5">
            <span className="block text-sm">{name}</span>
            <span className="block text-[11px] text-muted-foreground">On no route the collectors see, but your traffic crosses it.</span>
            <Badge size="sm" tone="success">Your traceroute crosses it</Badge>
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
