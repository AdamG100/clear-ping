'use client'

import { Badge } from '@/components/arc/badge/badge'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { BGP_DIRECT, type BgpUpstreamShare } from '@/types/bgp'
import { cn } from '@/lib/utils'
import { carrierLabel, whoseLabel } from './state'

/**
 * Which networks the world reaches the prefix through, and in what share:
 * the bar a mitigation visibly moves, as the exchange's share gives way to a
 * transit provider's or a scrubbing network's. Peers that connect to the
 * origin themselves are their own share, "Directly connected": at an
 * exchange that is the peering a move onto transit takes away.
 */

/**
 * Directly connected in the colour of good health, the usual upstreams in the
 * chart palette, and any new one in the warm colours that mean trouble.
 */
const NEW_COLORS = ['var(--signal-moderate)', 'var(--signal-severe)', 'var(--signal-high)', 'var(--signal-minor)']

/**
 * A colour for each upstream. Taken once from all of a prefix's upstreams and
 * passed down, so an upstream keeps its colour in a region that has fewer.
 */
export function upstreamColors(upstreams: readonly BgpUpstreamShare[]): Map<number, string> {
  const colors = new Map<number, string>()
  let usual = 0
  let unusual = 0
  for (const upstream of upstreams) {
    if (upstream.asn === BGP_DIRECT) {
      colors.set(BGP_DIRECT, 'var(--signal-perfect)')
      continue
    }
    colors.set(
      upstream.asn,
      upstream.expected ? `var(--line-${(usual++ % 16) + 1})` : NEW_COLORS[unusual++ % NEW_COLORS.length]
    )
  }
  return colors
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%'
}

/** The bar alone, for a list of prefixes. */
export function UpstreamBar({
  upstreams,
  names,
  colors = upstreamColors(upstreams),
  height = 'h-2',
}: {
  upstreams: BgpUpstreamShare[]
  names: Record<number, string>
  colors?: Map<number, string>
  height?: string
}) {
  const total = upstreams.reduce((sum, each) => sum + each.peers, 0)
  if (total === 0) return <div className={`${height} rounded-full bg-muted`} aria-hidden="true" />
  return (
    <div className={`flex ${height} gap-0.5 overflow-hidden rounded-full`} role="img" aria-label={upstreams.map(each => `${carrierLabel(each.asn, names)} ${percent(each.peers, total)}`).join(', ')}>
      {upstreams.map(upstream => (
        <Tooltip key={upstream.asn} content={`${carrierLabel(upstream.asn, names)}: ${upstream.peers} peers, ${percent(upstream.peers, total)}${upstream.expected ? '' : ' (new)'}`}>
          <span className="block h-full min-w-1" style={{ width: `${(upstream.peers / total) * 100}%`, background: colors.get(upstream.asn) }} />
        </Tooltip>
      ))}
    </div>
  )
}

const SHOWN_AT_FIRST = 8

/**
 * The bar with its legend, for a prefix's page. Each upstream in the legend
 * can be chosen, to see where in the world it carries the prefix.
 */
export function UpstreamMix({
  upstreams,
  names,
  colors,
  selected,
  onSelect,
  yours = new Map(),
}: {
  upstreams: BgpUpstreamShare[]
  names: Record<number, string>
  colors: Map<number, string>
  selected: number | null
  onSelect: (asn: number | null) => void
  /** The ways in your networks' sessions use, and whose they are. */
  yours?: Map<number, string[]>
}) {
  const total = upstreams.reduce((sum, each) => sum + each.peers, 0)
  if (total === 0) return <p className="text-sm text-muted-foreground">No collector peer here has a route to it now.</p>
  // The one chosen stays in the list even when it is past the first few.
  const shown = upstreams.filter((upstream, index) => index < SHOWN_AT_FIRST || upstream.asn === selected)
  const rest = upstreams.filter(upstream => !shown.includes(upstream))
  return (
    <div className="space-y-4">
      <UpstreamBar upstreams={upstreams} names={names} colors={colors} height="h-3" />
      <ul className="space-y-0.5">
        {shown.map(upstream => {
          const chosen = upstream.asn === selected
          return (
            <li key={upstream.asn}>
              <button
                type="button"
                aria-pressed={chosen}
                onClick={() => onSelect(chosen ? null : upstream.asn)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors',
                  chosen ? 'bg-primary/15 ring-1 ring-inset ring-primary/50' : 'hover:bg-muted/50',
                  selected !== null && !chosen && 'opacity-60'
                )}
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.get(upstream.asn) }} aria-hidden="true" />
                {/* On a narrow screen the badges go under the name rather than squeezing it to a few letters. */}
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="min-w-[min(12rem,100%)] max-w-full flex-1 truncate">
                    {upstream.asn === BGP_DIRECT ? (
                      <>
                        Directly connected{' '}
                        <span className="text-xs text-muted-foreground">at an exchange, privately or as its upstream</span>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-xs text-muted-foreground">AS{upstream.asn}</span> {names[upstream.asn] ?? ''}
                      </>
                    )}
                  </span>
                  {yours.has(upstream.asn) && (
                    <Badge tone="info" size="sm">
                      {`${yours.get(upstream.asn)!.map(whoseLabel).join(', ')}’s route`}
                    </Badge>
                  )}
                  {!upstream.expected && <Badge tone="warning" size="sm">New</Badge>}
                </span>
                <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {upstream.peers} · {percent(upstream.peers, total)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {rest.length > 0 && (
        <p className="px-2 text-xs text-muted-foreground">
          and {rest.length} more, carrying {rest.reduce((sum, each) => sum + each.peers, 0)} peers between them
        </p>
      )}
    </div>
  )
}
