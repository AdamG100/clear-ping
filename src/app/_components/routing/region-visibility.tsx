'use client'

import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { BGP_REGION_LABEL, BGP_REGIONS, type BgpRegion, type BgpShare } from '@/types/bgp'

/**
 * How much of each region's collector peers see the prefix, as five small
 * bars for a list of prefixes. The prefix's own page goes further, down to
 * countries and exchanges (seen-from.tsx).
 */

/** Green when most see it, amber when some do, red when next to none do. */
export function shareColor(share: BgpShare): string {
  if (share.total === 0) return 'var(--signal-none)'
  const seen = share.seen / share.total
  if (seen >= 0.8) return 'var(--signal-perfect)'
  if (seen >= 0.1) return 'var(--signal-moderate)'
  return 'var(--signal-critical)'
}

function describe(region: BgpRegion, share: BgpShare): string {
  if (share.total === 0) return `${BGP_REGION_LABEL[region]}: no collector peer has carried it`
  return `${BGP_REGION_LABEL[region]}: seen by ${share.seen} of ${share.total} peers`
}

const REGION_SHORT: Record<BgpRegion, string> = {
  africa: 'AF',
  europe: 'EU',
  'north-america': 'NA',
  'latin-america': 'LA',
  'asia-pacific': 'AP',
}

/** Five small bars, one a region. */
export function RegionBars({ byRegion }: { byRegion: Record<BgpRegion, BgpShare> }) {
  return (
    <span className="flex items-end gap-1" role="img" aria-label={BGP_REGIONS.map(region => describe(region, byRegion[region])).join('. ')}>
      {BGP_REGIONS.map(region => {
        const share = byRegion[region]
        const filled = share.total > 0 ? share.seen / share.total : 0
        return (
          <Tooltip key={region} content={describe(region, share)}>
            <span className="flex w-7 flex-col items-center gap-1">
              <span className="relative block h-6 w-2.5 overflow-hidden rounded-full bg-muted">
                <span
                  className="absolute inset-x-0 bottom-0 rounded-full"
                  style={{ height: `${share.total > 0 ? Math.max(8, filled * 100) : 100}%`, background: shareColor(share), opacity: share.total > 0 ? 1 : 0.35 }}
                />
              </span>
              <span className="font-mono text-[9px] uppercase text-muted-foreground">{REGION_SHORT[region]}</span>
            </span>
          </Tooltip>
        )
      })}
    </span>
  )
}
