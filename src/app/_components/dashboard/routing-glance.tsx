'use client'

import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import type { BgpPrefixSummary } from '@/types/bgp'
import { cn } from '@/lib/utils'
import { asLabel, CONNECTION_LABEL, STATE_COLOR, STATE_LABEL, STATE_TONE } from '../routing/state'
import { useRoutingGlance } from '../routing/use-bgp'

/**
 * Routing on the overview: each watched prefix and how it stands, those not
 * carried as normal first, with why. Shown only while Routing is on and
 * watching something; the routing page has the rest.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const
const SHOWN = 6

const troubled = (prefix: BgpPrefixSummary) => prefix.status.state !== 'normal' && prefix.status.state !== 'learning'

export function RoutingGlance({ onOpenRouting, onOpenPrefix }: { onOpenRouting: () => void; onOpenPrefix: (id: string) => void }) {
  const overview = useRoutingGlance()
  if (!overview?.enabled || overview.prefixes.length === 0) return null

  const names = overview.asNames
  const wrong = overview.prefixes.filter(troubled)
  const shown = [...overview.prefixes].sort((a, b) => Number(troubled(b)) - Number(troubled(a)) || a.prefix.localeCompare(b.prefix)).slice(0, SHOWN)
  const count = overview.prefixes.length

  return (
    <section className="rounded-3xl border border-border bg-card p-4 text-foreground @2xl/main:p-6" aria-labelledby="overview-routing">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="overview-routing" className="text-sm font-medium">
            Routing
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {count} prefix{count === 1 ? '' : 'es'} watched,{' '}
            {wrong.length > 0 ? `${wrong.length} not carried as normal` : 'all carried as normal'} · {CONNECTION_LABEL[overview.connection.state]}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onOpenRouting}>
          Open Routing
          <ChevronRight {...ICON} />
        </Button>
      </div>
      <ul className="mt-3 grid gap-2 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
        {shown.map(prefix => {
          const { status } = prefix
          const origin = prefix.baseline?.origins[0] ?? status.origins[0]
          return (
            <li key={prefix.id} className="flex">
              <button
                type="button"
                onClick={() => onOpenPrefix(prefix.id)}
                className={cn(
                  'flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-2xl border p-3 text-left transition-colors hover:bg-muted/40',
                  troubled(prefix) ? 'border-signal-critical/40' : 'border-border'
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: STATE_COLOR[status.state] }} aria-hidden="true" />
                  <span className="truncate font-mono text-sm">{prefix.prefix}</span>
                  <span className="ml-auto shrink-0">
                    <Badge size="sm" tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Badge>
                  </span>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[prefix.label, origin !== undefined ? asLabel(origin, names) : null].filter(Boolean).join(' · ') || 'Origin not known yet'}
                </span>
                <span className={cn('truncate text-xs', troubled(prefix) ? 'text-signal-critical' : 'text-muted-foreground')}>
                  {troubled(prefix) ? status.reasons[0] : `Seen by ${status.visibility.seen} of ${status.visibility.total} collector peers`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {count > SHOWN && <p className="mt-2 text-xs text-muted-foreground">and {count - SHOWN} more on the routing page</p>}
    </section>
  )
}
