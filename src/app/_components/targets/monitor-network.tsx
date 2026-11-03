'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, MapPin } from 'lucide-react'
import { TextShimmer } from '@/components/arc/text-shimmer/text-shimmer'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { cn } from '@/lib/utils'
import type { NetworkOf } from '@/lib/networks/lookup'
import type { ProbeSummary } from '@/types/probe-agent'
import { useMask } from '../privacy/use-privacy'
import { PROBE_AGENT_STATE } from '../settings/probe-agent-labels'

interface Found {
  enabled: boolean
  address: string | null
  network: NetworkOf | null
}

/**
 * Who runs the address a monitor is measured at: its network's ASN (a link to
 * IPinfo, which says more about it), the name it is registered under, and the
 * exchange it sits on when it is on one. While addresses are hidden the link
 * goes to the network rather than the address, so no address reaches the
 * browser's status bar. Says nothing for a monitor that measures no address of
 * its own, or when looking networks up is off in Settings, Privacy.
 */
export function NetworkLine({
  targetId,
  probe,
  family,
  refreshKey,
}: {
  targetId: string
  probe?: string
  family?: 4 | 6 | null
  /** Changes when a new reading lands, which is when what it resolved to may have changed. */
  refreshKey?: string | number
}) {
  const mask = useMask()
  const [loaded, setLoaded] = useState<{ key: string; found: Found | null } | null>(null)
  const key = `${targetId}|${probe ?? ''}|${family ?? ''}|${refreshKey ?? ''}`

  useEffect(() => {
    let current = true
    const query = new URLSearchParams()
    if (probe) query.set('probe', probe)
    if (family) query.set('family', String(family))
    fetch(`/api/targets/${targetId}/network?${query}`)
      .then(response => (response.ok ? (response.json() as Promise<Found>) : null))
      .catch(() => null)
      .then(found => { if (current) setLoaded({ key, found }) })
    return () => { current = false }
  }, [targetId, probe, family, key])

  // Until it answers, a shimmer holds the place, so the header does not jump.
  if (loaded?.key !== key) return <TextShimmer className="text-xs">Looking up who runs it</TextShimmer>
  const found = loaded.found
  if (!found || !found.enabled || !found.network) return null
  const { network } = found

  if ('private' in network) return <span className="text-xs text-muted-foreground">Private address</span>

  const href = network.asn !== null
    ? mask.hidden ? `https://ipinfo.io/AS${network.asn}` : `https://ipinfo.io/${network.address}`
    : null

  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      {network.asn !== null && href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono font-medium text-foreground underline-offset-2 hover:underline"
        >
          AS{network.asn}
          <ExternalLink size={11} strokeWidth={1.75} aria-hidden />
          <span className="sr-only">on IPinfo, opens in a new tab</span>
        </a>
      )}
      {network.name && <span className="min-w-0 truncate">{network.asn !== null ? '· ' : ''}{mask.text(network.name)}</span>}
      {network.exchange && <span>· on {network.exchange}</span>}
    </span>
  )
}

/**
 * Where a monitor's readings are taken from: a chip for each probe with a dot
 * that says whether it is working. One probe is one static chip.
 */
export function ProbeChips({ probes, className }: { probes: ProbeSummary[]; className?: string }) {
  const mask = useMask()
  return (
    <ul className={cn('flex flex-wrap items-center gap-1.5', className)} aria-label="Measured from">
      <li className="flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin size={12} strokeWidth={1.75} aria-hidden />
        Measured from
      </li>
      {probes.map(probe => {
        const state = PROBE_AGENT_STATE[probe.state]
        const working = probe.state === 'online'
        const host = probe.local ? 'Where this dashboard runs' : mask.address(probe.hostname ?? probe.address ?? '')
        return (
          <li key={probe.id}>
            <Tooltip content={`${probe.name}: ${state.label.toLowerCase()}. ${host}`}>
              <span className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground">
                <span
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', working ? 'bg-success' : state.tone === 'danger' ? 'bg-destructive' : 'bg-warning')}
                  aria-hidden
                />
                <span className="truncate">{probe.name}</span>
                <span className="sr-only">, {state.label.toLowerCase()}</span>
              </span>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}
