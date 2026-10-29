'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { Network } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Switch } from '@/components/arc/switch/switch'
import { useToast } from '@/components/notifications'
import type { BgpOverview } from '@/types/bgp'
import { announceRoutingChanged } from '../routing/use-bgp'

/**
 * Routing, BGP monitoring, turned on or off. Off until it is turned on here:
 * it keeps a connection open to RIPE NCC and asks RIPEstat and PeeringDB
 * about the prefixes watched, which not everyone running ClearPing wants.
 */

const HINT = 'text-xs leading-relaxed text-muted-foreground'
const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

export function RoutingTab({ onOpenRouting }: { onOpenRouting: () => void }) {
  const { notify, reportError } = useToast()
  const [overview, setOverview] = useState<BgpOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const load = useCallback(async () => {
    const response = await fetch('/api/bgp', { cache: 'no-store' }).catch(() => null)
    const body = await response?.json().catch(() => null)
    if (response?.ok) setOverview(body as BgpOverview)
    else setError(body?.error ?? 'Could not read BGP monitoring')
  }, [])

  useEffect(() => {
    // Loaded when the tab opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const change = async (enabled: boolean) => {
    setBusy(true)
    try {
      const response = await fetch('/api/bgp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) return reportError(`Could not turn Routing ${enabled ? 'on' : 'off'}`, body?.error)
      setOverview(body as BgpOverview)
      announceRoutingChanged()
      notify({
        tone: enabled ? 'success' : 'info',
        title: enabled ? 'Routing is on' : 'Routing is off',
        detail: enabled ? 'It is in the sidebar, under Overview.' : 'The prefixes stay, and are followed again when it is turned back on.',
      })
    } catch (failure) {
      reportError(`Could not turn Routing ${enabled ? 'on' : 'off'}`, failure)
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Alert tone="danger" title="Could not load Routing">{error}</Alert>
  if (!overview) return <Skeleton label="Loading Routing" lines={3} />

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5 pt-2.5">
          <p id={`${id}-title`} className="text-sm font-medium text-card-foreground">Routing (BGP monitoring)</p>
          <div id={`${id}-detail`} className={`${HINT} max-w-2xl space-y-2`}>
            <p>
              Follows the prefixes you pick in BGP, as RIPE RIS route collectors at exchanges around the world see them,
              and how your own network reaches them. You are told when a prefix is withdrawn, moved off the exchanges onto
              transit, reached through a different upstream, or announced by another network.
            </p>
            <p>
              While it is on, ClearPing keeps one connection open to RIS Live (ris-live.ripe.net), and asks RIPEstat
              (stat.ripe.net) and PeeringDB (peeringdb.com) about the prefixes you watch. When it is off, Routing is greyed
              out in the sidebar and nothing is asked.
            </p>
          </div>
        </div>
        <Switch
          checked={overview.enabled}
          disabled={busy}
          onCheckedChange={next => void change(next)}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-detail`}
        />
      </div>

      {overview.enabled && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border p-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {overview.prefixes.length === 0
              ? 'Nothing is watched yet.'
              : `${overview.prefixes.length} prefix${overview.prefixes.length === 1 ? '' : 'es'} watched.`}
          </p>
          <Button variant="secondary" size="sm" onClick={onOpenRouting}>
            <Network {...ICON} />
            Open Routing
          </Button>
        </div>
      )}
    </div>
  )
}
