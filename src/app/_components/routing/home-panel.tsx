'use client'

import { Fragment, useState } from 'react'
import { ArrowRightLeft, RadioTower, Route, Server, Settings2 } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { useToast } from '@/components/notifications'
import { hops, upstreamOf } from '@/lib/bgp/path'
import { BGP_DIRECT, type BgpCrossing, type BgpHomeTrace, type BgpPeerRoute, type BgpPrefixDetail, type BgpVantage } from '@/types/bgp'
import { cn } from '@/lib/utils'
import { ago, asLabel, whoseLabel } from './state'

/**
 * "From your networks": what the rest of the page cannot say, from each place
 * you look from (this server, and each probe agent). Its network's routes to
 * the prefix, where that network shares them with RIS; and which exchange its
 * traffic actually crosses, by traceroute, which tells JINX from NAPAfrica
 * where BGP cannot.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

function crossingText(crossing: BgpCrossing | null): string {
  return crossing ? `Crosses ${crossing.name}` : 'Crosses no exchange'
}

function YourRoute({ peer, names, colors, origin, now }: { peer: BgpPeerRoute; names: Record<number, string>; colors: Map<number, string>; origin: number | undefined; now: number }) {
  const route = peer.route
  const carrier = route ? upstreamOf(route.path) : null
  const path = route ? hops(route.path) : []
  const color = carrier === null ? 'var(--signal-critical)' : (colors.get(carrier) ?? 'var(--signal-none)')
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {!route
            ? 'No route: it reached it when normal was taken, and no longer does'
            : carrier === BGP_DIRECT
              ? `Directly connected to ${origin !== undefined ? asLabel(origin, names) : 'the origin'}`
              : `Through ${asLabel(carrier!, names)}`}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          At {peer.location} ({peer.collector})
          {route && now > 0 ? ` · since ${ago(route.since, now)}` : ''}
        </p>
        {path.length > 0 && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {path.map((asn, index) => (
              <Fragment key={`${asn}-${index}`}>
                {index > 0 && ' › '}
                <span className={cn(index === path.length - 2 && carrier !== BGP_DIRECT && 'text-foreground')} title={names[asn]}>
                  {asn}
                </span>
              </Fragment>
            ))}
          </p>
        )}
      </div>
    </li>
  )
}

function YourTrace({ trace, now }: { trace: BgpHomeTrace; now: number }) {
  const [open, setOpen] = useState(false)
  const failed = trace.hops.length === 0
  return (
    <li className="flex items-start gap-2.5">
      <span
        className="mt-1.5 size-2.5 shrink-0 rounded-full"
        style={{ background: failed ? 'var(--signal-none)' : trace.crossing ? 'var(--signal-perfect)' : 'var(--signal-moderate)' }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {failed ? 'Could not trace' : crossingText(trace.crossing)}
          {trace.crossing && (
            <span className="font-normal text-muted-foreground">
              {' '}
              at {trace.crossing.address}, hop {trace.crossing.hop}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          To {trace.targetName && trace.targetName !== trace.address ? `${trace.targetName} (${trace.address})` : trace.address}
          {now > 0 ? ` · ${ago(trace.at, now)}` : ''}
          {!failed && !trace.reached && ' · did not reach it'}
        </p>
        {trace.error && <p className="mt-0.5 text-xs text-signal-critical">{trace.error}</p>}
        {trace.before && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-signal-moderate">
            <ArrowRightLeft size={12} strokeWidth={1.75} aria-hidden="true" />
            Changed: {now > 0 ? `${ago(trace.before.at, now)} it ` : 'before, it '}
            {trace.before.crossing ? `crossed ${trace.before.crossing.name}` : 'crossed no exchange'}
          </p>
        )}
        {!failed && (
          <button
            type="button"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open}
            className="mt-1 cursor-pointer text-xs text-primary hover:underline"
          >
            {open ? 'Hide hops' : `Show ${trace.hops.length} hops`}
          </button>
        )}
        {open && (
          <ol className="mt-2 space-y-0.5 font-mono text-[11px]">
            {trace.hops.map(hop => (
              <li key={hop.hop} className={cn('flex gap-3', hop.exchange ? 'text-foreground' : 'text-muted-foreground')}>
                <span className="w-5 shrink-0 text-right">{hop.hop}</span>
                <span className="min-w-0 flex-1 truncate">
                  {hop.address ?? '*'}
                  {hop.hostname ? <span className="font-sans"> {hop.hostname}</span> : null}
                </span>
                {hop.exchange && <Badge size="sm" tone="success">{hop.exchange}</Badge>}
                <span className="w-14 shrink-0 text-right">{hop.rtt !== null ? `${hop.rtt.toFixed(1)} ms` : ''}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  )
}

function Vantage({
  vantage,
  names,
  colors,
  origin,
  now,
}: {
  vantage: BgpVantage
  names: Record<number, string>
  colors: Map<number, string>
  origin: number | undefined
  now: number
}) {
  const network = vantage.asns.map(asn => asLabel(asn, names)).join(', ')
  return (
    <article className="min-w-0 space-y-4 rounded-2xl border border-primary/30 bg-background/40 p-4">
      <header className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          {vantage.kind === 'server' ? <Server {...ICON} /> : <RadioTower {...ICON} />}
        </span>
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {vantage.kind === 'server' ? 'This server' : `Probe agent: ${vantage.name}`}
            <Badge size="sm" tone="info">{whoseLabel(vantage.kind === 'server' ? 'This server' : vantage.name)}</Badge>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {network ? `${network}${vantage.found ? ', found from its traces' : ''}` : 'Its network is found from its first trace'}
          </p>
          {vantage.unavailable && <p className="mt-0.5 text-xs text-signal-moderate">{vantage.unavailable}, so it is not traced from.</p>}
        </div>
      </header>

      <div className="space-y-2">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ArrowRightLeft size={12} strokeWidth={1.75} aria-hidden="true" />
          Its network&apos;s routes, from BGP
        </h4>
        {vantage.asns.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not known until its network is.</p>
        ) : vantage.routes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{network} does not share its routes with RIPE RIS&apos;s collectors.</p>
        ) : (
          <ul className="space-y-3">
            {vantage.routes.map(peer => (
              <YourRoute key={`${peer.collector}|${peer.peer}`} peer={peer} names={names} colors={colors} origin={origin} now={now} />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Route size={12} strokeWidth={1.75} aria-hidden="true" />
          Its traffic, by traceroute
        </h4>
        {vantage.traces.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not traced from here yet.</p>
        ) : (
          <ul className="space-y-3">
            {vantage.traces.map(trace => (
              <YourTrace key={trace.address} trace={trace} now={now} />
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

export function HomePanel({
  detail,
  colors,
  readOnly,
  now,
  onSetNetwork,
  onTraced,
  reportError,
}: {
  detail: BgpPrefixDetail
  colors: Map<number, string>
  readOnly: boolean
  now: number
  onSetNetwork: () => void
  onTraced: () => Promise<void> | void
  reportError: (title: string, error?: unknown) => void
}) {
  const { notify } = useToast()
  const [tracing, setTracing] = useState(false)
  const { home, asNames: names } = detail
  const origin = detail.baseline?.origins[0] ?? detail.status.origins[0]
  const agents = home.vantages.filter(each => each.kind === 'probe-agent').length

  const traceNow = async () => {
    setTracing(true)
    try {
      const response = await fetch(`/api/bgp/${encodeURIComponent(detail.id)}`, { method: 'POST' })
      const body = await response.json().catch(() => null)
      if (!response.ok) reportError('Could not trace', body?.error ?? `Server responded ${response.status}`)
      else {
        notify({ tone: 'success', title: `Took ${body.traced} trace${body.traced === 1 ? '' : 's'} into ${detail.prefix}` })
        await onTraced()
      }
    } catch (error) {
      reportError('Could not trace', error)
    } finally {
      setTracing(false)
    }
  }

  return (
    <section className="min-w-0 rounded-3xl border border-primary/40 bg-card p-4 text-foreground @2xl/main:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">From your networks</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            How {detail.prefix} is reached from this server
            {agents > 0 ? ` and your ${agents} probe agent${agents === 1 ? '' : 's'}` : ''}. Their routes are marked across the page:
            &ldquo;Your ISP&rdquo; for this server&apos;s network{agents > 0 ? ', and each probe agent by name' : ''}.
          </p>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void traceNow()} loading={tracing}>
              <Route {...ICON} />
              Trace now
            </Button>
            <Button variant="ghost" size="sm" onClick={onSetNetwork}>
              <Settings2 {...ICON} />
              {home.asns.length > 0 ? 'Change your network' : 'Set your network'}
            </Button>
          </div>
        )}
      </div>

      <div className={cn('grid gap-4', home.vantages.length > 1 && '@4xl/main:grid-cols-2')}>
        {home.vantages.map(vantage => (
          <Vantage key={vantage.id} vantage={vantage} names={names} colors={colors} origin={origin} now={now} />
        ))}
      </div>

      {!home.exchangesKnown && (
        <p className="mt-3 text-xs text-signal-moderate">
          PeeringDB could not be read (it may have timed out or turned ClearPing away), so the exchanges crossed are not named. Create a free
          API key in your{' '}
          <a href="https://www.peeringdb.com/profile" target="_blank" rel="noreferrer" className="underline">
            PeeringDB profile
          </a>{' '}
          and set it as <span className="font-mono">CLEARPING_PEERINGDB_API_KEY</span>, then restart ClearPing.
        </p>
      )}
    </section>
  )
}
