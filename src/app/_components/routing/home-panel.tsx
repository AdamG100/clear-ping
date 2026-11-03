'use client'

import { Fragment, useMemo, useState } from 'react'
import { Activity, ArrowRightLeft, Check, Network, RadioTower, Route, Server, Settings2 } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Timeline, type TimelineEvent } from '@/components/arc/timeline/timeline'
import { useToast } from '@/components/notifications'
import { flapCount, wayChanges } from '@/lib/bgp/flapping'
import { hops, upstreamOf } from '@/lib/bgp/path'
import { displayLocale, displayTimeZone } from '@/lib/time-zone'
import { BGP_DIRECT, type BgpCrossingRun, type BgpHomeTrace, type BgpPrefixDetail, type BgpUpdate, type BgpVantage } from '@/types/bgp'
import { cn } from '@/lib/utils'
import { asLabel, vantageLabel } from './state'
import { Masked } from '../privacy/masked'

/**
 * "From your networks": what the rest of the page cannot say, from each place
 * you look from (this server, and each probe agent). Its network's routes to
 * the prefix, where that network shares them with RIS; and which exchange its
 * traffic actually crosses, by traceroute, which tells JINX from NAPAfrica
 * where BGP cannot.
 *
 * Which probe agents are among them is chosen here: one left out is not
 * traced from, and its network is not marked across the page.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

/** "NAPAfrica IX Johannesburg", "A or B", "A, B or C". */
function oneOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/**
 * What a trace says about the exchange it crossed, in words, with how sure
 * that is: a hop on an exchange's LAN is certain; two members of one either
 * side of a hop is probable; without PeeringDB nothing can be said.
 */
function crossingSaid(trace: BgpHomeTrace, known: boolean, names: Record<number, string>): { title: string; detail: string | null; color: string } {
  if (trace.crossing) {
    const into = trace.crossing.member ? `, into ${asLabel(trace.crossing.member, names)}` : ''
    return { title: `Crosses ${trace.crossing.name}`, detail: `at ${trace.crossing.address}, hop ${trace.crossing.hop}${into}`, color: 'var(--signal-perfect)' }
  }
  if (!known) return { title: 'Exchange not known', detail: 'PeeringDB could not be read', color: 'var(--signal-none)' }
  if (trace.likely) {
    const { from, to, hop } = trace.likely
    const few = trace.likely.names.slice(0, 3)
    const more = trace.likely.names.length - few.length
    return {
      title: `Probably crosses ${more > 0 ? `${oneOf(few)}, or ${more} more` : oneOf(few)}`,
      detail: `from ${asLabel(from, names)} to ${asLabel(to, names)} at hop ${hop}. Both are members there; no hop answered from its LAN, as many routers answer from another address`,
      color: 'var(--signal-minor)',
    }
  }
  return {
    title: 'Crosses no exchange',
    detail: 'No hop was on an exchange’s LAN, and no two networks on the way are members of one together: transit or a private link',
    color: 'var(--signal-moderate)',
  }
}

/** "JINX", "JINX or NAPAfrica (probably)", "no exchange": where a run of traces crossed. */
function runSaid(run: BgpCrossingRun): string {
  if (run.crossing) return run.crossing
  if (run.likely && run.likely.length > 0) return `${oneOf(run.likely)} (probably)`
  return 'no exchange'
}

function targetSaid(trace: BgpHomeTrace): string {
  return trace.targetName && trace.targetName !== trace.address ? `${trace.targetName} (${trace.address})` : trace.address
}

function Hops({ trace, names }: { trace: BgpHomeTrace; names: Record<number, string> }) {
  return (
    <ol className="space-y-0.5 font-mono text-[11px]">
      {trace.hops.map(hop => (
        <li key={hop.hop} className={cn('flex gap-3', hop.exchange ? 'text-foreground' : 'text-muted-foreground')}>
          <span className="w-5 shrink-0 text-right">{hop.hop}</span>
          <span className="min-w-0 flex-1 truncate">
            {hop.address ? <Masked value={hop.address} /> : '*'}
            {hop.hostname ? <span className="font-sans"> <Masked value={hop.hostname} /></span> : null}
            {/* Whose router answered on the exchange, by IXPDB. */}
            {hop.member ? <span className="font-sans" title={asLabel(hop.member, names)}> AS{hop.member}{names[hop.member] ? ` ${names[hop.member]}` : ''}</span> : null}
          </span>
          {hop.exchange && <Badge size="sm" tone="success">{hop.exchange}</Badge>}
          <span className="w-14 shrink-0 text-right">{hop.rtt !== null ? `${hop.rtt.toFixed(1)} ms` : ''}</span>
        </li>
      ))}
    </ol>
  )
}

/** Changes this close together are one: a round's traces are taken one after another. */
const ROUND_MS = 10 * 60 * 1000
/** An address whose kept traces changed more often than this is said to switch between its ways, not change by change. */
const MOST_CHANGES = 2

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Each address in a round of traces: where it crossed, and its hops when asked. */
function TraceRound({ traces, known, names }: { traces: BgpHomeTrace[]; known: boolean; names: Record<number, string> }) {
  return (
    <ul className="space-y-3">
      {traces.map(trace => (
        <TraceLine key={trace.address} trace={trace} known={known} names={names} />
      ))}
    </ul>
  )
}

function TraceLine({ trace, known, names }: { trace: BgpHomeTrace; known: boolean; names: Record<number, string> }) {
  const [open, setOpen] = useState(false)
  const failed = trace.hops.length === 0
  const said = crossingSaid(trace, known, names)
  return (
    <li className="space-y-1">
      <p className="text-sm text-foreground"><Masked text value={targetSaid(trace)} /></p>
      <p className="text-xs text-muted-foreground">
        {failed
          ? `Could not trace${trace.error ? `: ${trace.error}` : ''}`
          : [said.title, said.detail, trace.reached ? null : 'did not reach it'].filter(Boolean).join(' · ')}
      </p>
      {!failed && (
        <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="cursor-pointer text-xs text-primary hover:underline">
          {open ? 'Hide hops' : `Show ${trace.hops.length} hops`}
        </button>
      )}
      {open && <Hops trace={trace} names={names} />}
    </li>
  )
}

function Path({ path, names }: { path: number[]; names: Record<number, string> }) {
  return (
    <p className="font-mono text-[11px] text-muted-foreground">
      {hops(path).map((asn, index) => (
        <Fragment key={`${asn}-${index}`}>
          {index > 0 && ' › '}
          <span title={names[asn]}>{asn}</span>
        </Fragment>
      ))}
    </p>
  )
}

function through(carrier: number | null, names: Record<number, string>): string {
  if (carrier === null) return 'no route'
  return carrier === BGP_DIRECT ? 'directly connected' : `through ${asLabel(carrier, names)}`
}

/** "A, B and C". */
function allOf(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Everything seen from one vantage point, newest first: its traces' latest
 * crossing and each time that changed, and its network's routes and each time
 * one of those changed. With what of it is flapping, in words, to flag.
 */
function moments(
  vantage: BgpVantage,
  updates: readonly BgpUpdate[],
  names: Record<number, string>,
  known: boolean
): { events: TimelineEvent[]; flapping: string[] } {
  const events: TimelineEvent[] = []
  const flapping: string[] = []
  const many = vantage.traces.length > 1

  // The traces: one row for the latest round, however many addresses it went to.
  const usable = vantage.traces.filter(trace => trace.hops.length > 0)
  const failed = vantage.traces.length - usable.length
  if (vantage.traces.length > 0) {
    const latest = Math.max(...vantage.traces.map(trace => trace.at))
    if (!many) {
      const [trace] = vantage.traces
      const said = crossingSaid(trace, known, names)
      events.push({
        id: 'traces',
        at: latest,
        title: failed ? 'Could not trace' : said.title,
        meta: [`To ${targetSaid(trace)}`, failed ? trace.error : said.detail, !failed && !trace.reached ? 'did not reach it' : null, !failed ? trace.error && `the newest failed: ${trace.error}` : null]
          .filter(Boolean)
          .join(' · '),
        detail: failed ? undefined : <Hops trace={trace} names={names} />,
        tone: failed ? 'danger' : trace.crossing ? 'success' : 'neutral',
        icon: <Route {...ICON} />,
      })
    } else {
      // "Crosses NAPAfrica IX Johannesburg to 3 addresses, JINX to 1", most first.
      const groups = new Map<string, number>()
      for (const trace of usable) {
        const title = crossingSaid(trace, known, names).title
        groups.set(title, (groups.get(title) ?? 0) + 1)
      }
      const parts = [...groups].sort((a, b) => b[1] - a[1]).map(([title, n], index) =>
        index === 0 ? `${title} ${groups.size === 1 && !failed ? `to all ${n} addresses` : `to ${counted(n, 'address', 'addresses')}`}` : `${title.charAt(0).toLowerCase()}${title.slice(1)} to ${n}`
      )
      if (failed) parts.push(`${failed} could not be traced`)
      events.push({
        id: 'traces',
        at: latest,
        title: usable.length === 0 ? `Could not trace to any of ${vantage.traces.length} addresses` : parts.join('; '),
        meta: `Traced to ${counted(vantage.traces.length, 'address', 'addresses')}. Open it for each, and its hops`,
        detail: <TraceRound traces={vantage.traces} known={known} names={names} />,
        tone: usable.length === 0 ? 'danger' : usable.every(trace => trace.crossing) ? 'success' : 'neutral',
        icon: <Route {...ICON} />,
      })
    }
  }

  // Each time where the traffic crossed changed, the same change to several addresses at once being one.
  const changes: { at: number; text: string; note: string | null; address: string }[] = []
  for (const trace of usable) {
    // A server that has not restarted since the update sends no history.
    const history = trace.history ?? []
    const address = trace.targetName ?? trace.address
    if (history.length - 1 > MOST_CHANGES) {
      // Back and forth, as traffic spread over two ways in does: one row, not one a change.
      const ways = [...new Set(history.map(runSaid))]
      const traces = history.reduce((sum, run) => sum + run.traces, 0)
      flapping.push(`its traffic${many ? ` to ${address}` : ''} switches between ${allOf(ways)}`)
      changes.push({
        at: history[0].from,
        text: `Switches between ${allOf(ways)}`,
        note: `${history.length - 1} changes in the last ${traces} traces`,
        address,
      })
      continue
    }
    history.forEach((run, index) => {
      const earlier = history[index + 1]
      if (earlier) changes.push({ at: run.from, text: `Changed to ${runSaid(run)}, was ${runSaid(earlier)}`, note: null, address })
    })
  }
  const merged: (typeof changes[number] & { addresses: string[] })[] = []
  for (const change of changes.sort((a, b) => b.at - a.at)) {
    const same = merged.find(each => each.text === change.text && Math.abs(each.at - change.at) < ROUND_MS)
    if (same) same.addresses.push(change.address)
    else merged.push({ ...change, addresses: [change.address] })
  }
  for (const change of merged) {
    const n = change.addresses.length
    events.push({
      id: `change|${change.at}|${change.text}`,
      at: change.at,
      title: `${change.text}${!many ? '' : n === 1 ? ` to ${change.addresses[0]}` : n === vantage.traces.length ? ' to all of them' : ` to ${counted(n, 'address', 'addresses')}`}`,
      meta: [change.note, many && n > 1 && n < vantage.traces.length ? change.addresses.join(', ') : null].filter(Boolean).join(' · ') || undefined,
      tone: 'neutral',
      icon: <ArrowRightLeft {...ICON} />,
    })
  }

  // Its network's routes: each change of the way in, from RIS Live's updates.
  const moved = wayChanges(updates, new Set(vantage.routes.map(peer => `${peer.collector}|${peer.peer}`)))
  const covered = new Set([...moved].flatMap(([key, changes]) => changes.map(({ update }) => `${key}|${update.at}`)))
  // Measured back from the newest update, so the page needs no clock of its own.
  const newest = Math.max(0, ...updates.map(update => update.at))
  for (const [key, changes] of moved) {
    const recent = flapCount(changes, newest)
    if (recent === 0) continue
    // Flapping: one row for the lot, not one a change.
    const [latest] = changes
    const ways = [...new Set(changes.flatMap(({ now, was }) => [now, was]).map(carrier => through(carrier, names)))]
    flapping.push(`its route at ${latest.update.location} changed ${recent} times in 24 hours`)
    events.push({
      id: `flap|${key}`,
      at: latest.update.at,
      title: `Flapping at ${latest.update.location}: ${recent} changes in 24 hours`,
      meta: `Between ${allOf(ways)} · ${latest.update.collector}${changes.length > recent ? ` · ${changes.length} changes in all` : ''}`,
      detail: latest.update.path ? <Path path={latest.update.path} names={names} /> : undefined,
      tone: 'danger',
      icon: <Activity {...ICON} />,
    })
    moved.delete(key)
  }
  for (const { update, now, was } of [...moved.values()].flat()) {
    events.push({
      id: `update|${update.id}`,
      at: update.at,
      title: now === null ? `Route withdrawn at ${update.location}` : `Now ${through(now, names)} at ${update.location}`,
      meta: `Was ${through(was, names)} · ${update.collector}`,
      detail: update.path ? <Path path={update.path} names={names} /> : undefined,
      tone: now === null ? 'danger' : now === BGP_DIRECT ? 'success' : 'neutral',
      icon: <Network {...ICON} />,
    })
  }
  // And the route each session has now, from when it was first seen, unless an update above says so.
  for (const peer of vantage.routes) {
    const route = peer.route
    if (!route || covered.has(`${peer.collector}|${peer.peer}|${route.since}`)) continue
    const carrier = upstreamOf(route.path)
    events.push({
      id: `route|${peer.collector}|${peer.peer}`,
      at: route.since,
      title: `${carrier === BGP_DIRECT ? 'Directly connected' : carrier === null ? 'No route' : `Through ${asLabel(carrier, names)}`} at ${peer.location}`,
      meta: `Its route at ${peer.collector}, unchanged since`,
      detail: <Path path={route.path} names={names} />,
      tone: carrier === BGP_DIRECT ? 'success' : 'neutral',
      icon: <Network {...ICON} />,
    })
  }
  return { events, flapping }
}

function Vantage({
  vantage,
  seen: { events, flapping },
  names,
  now,
}: {
  vantage: BgpVantage
  /** Its timeline, and what of it is flapping. */
  seen: ReturnType<typeof moments>
  names: Record<number, string>
  now: number
}) {
  const network = vantage.asns.map(asn => asLabel(asn, names)).join(', ')
  const lost = vantage.routes.filter(peer => !peer.route)
  const tracedPath = vantage.tracedPath ?? []
  return (
    <article className="min-w-0 space-y-4 rounded-2xl border border-primary/30 bg-background/40 p-4">
      <header className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          {vantage.kind === 'server' ? <Server {...ICON} /> : <RadioTower {...ICON} />}
        </span>
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {vantage.kind === 'server' ? vantage.name : `Probe agent: ${vantage.name}`}
            <Badge size="sm" tone="info">{vantageLabel(vantage)}</Badge>
            {flapping.length > 0 && <Badge size="sm" tone="warning">Flapping</Badge>}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {network
              ? `${network}${vantage.found ? ', found from its traces' : ''}`
              : vantage.traces.length > 0
                ? 'Its network could not be found from its traces yet'
                : 'Its network is found from its first trace'}
          </p>
          {!network && vantage.traces.length > 0 && vantage.kind === 'server' && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Until it is, nothing is marked &ldquo;Your ISP&rdquo;. Use &ldquo;Set your network&rdquo; with your ISP&apos;s AS number to mark it now.
            </p>
          )}
          {network && vantage.routes.length === 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              It does not share its routes with RIPE RIS&apos;s collectors, so its traffic&apos;s way in, by trace, is what is drawn across
              the page{vantage.place ? '' : ' (placed once where its network is registered is looked up)'}.
            </p>
          )}
          {tracedPath.length > 1 && (
            <div className="mt-1.5">
              <p className="text-[11px] text-muted-foreground">Its traffic&apos;s way in, by its newest trace</p>
              <Path path={tracedPath} names={names} />
            </div>
          )}
          {lost.length > 0 && (
            <p className="mt-0.5 text-xs text-signal-critical">
              No route at {lost.map(peer => peer.location).join(', ')}: it usually reaches it there, and no longer does.
            </p>
          )}
          {flapping.length > 0 && (
            <p className="mt-0.5 flex items-start gap-1.5 text-xs text-signal-moderate">
              <Activity size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>Flapping: {flapping.join('; ')}.</span>
            </p>
          )}
          {vantage.unavailable && <p className="mt-0.5 text-xs text-signal-moderate">{vantage.unavailable}, so it is not traced from.</p>}
        </div>
      </header>

      {events.length > 0 ? (
        <Timeline
          label={`What ${vantage.name} saw of the prefix`}
          events={events}
          now={now || Math.max(...events.map(event => Number(event.at)))}
          timeZone={displayTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
          locale={displayLocale()}
          maxHeight={360}
          scrollToNew={false}
          headingLevel={4}
          unit={['event', 'events']}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Not traced from here yet.</p>
      )}
    </article>
  )
}

export function HomePanel({
  detail,
  readOnly,
  now,
  onSetNetwork,
  onAddProbeAgent,
  onTraced,
  reportError,
}: {
  detail: BgpPrefixDetail
  readOnly: boolean
  now: number
  onSetNetwork: () => void
  /** Open Settings where probe agents are added: for an admin, whose that is. */
  onAddProbeAgent?: () => void
  onTraced: () => Promise<void> | void
  reportError: (title: string, error?: unknown) => void
}) {
  const { notify } = useToast()
  const [tracing, setTracing] = useState(false)
  const { home, asNames: names } = detail
  const seen = useMemo(
    () => new Map(home.vantages.map(vantage => [vantage.id, moments(vantage, detail.updates, names, home.exchangesKnown)])),
    [home.vantages, detail.updates, names, home.exchangesKnown]
  )
  const flapping = [...seen.values()].some(each => each.flapping.length > 0)
  const agents = home.vantages.filter(each => each.kind === 'probe-agent').length
  const [choosing, setChoosing] = useState<string | null>(null)

  /** Put a probe agent in Routing, or take it out: it is traced from, and marked, or not. */
  const choose = async (id: string, included: boolean) => {
    setChoosing(id)
    try {
      const left = home.agents.filter(agent => (agent.id === id ? !included : !agent.included)).map(agent => agent.id)
      const response = await fetch('/api/bgp', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ excludedAgents: left }) })
      const body = await response.json().catch(() => null)
      if (!response.ok) reportError('Could not change the probe agents in Routing', body?.error ?? `Server responded ${response.status}`)
      else await onTraced()
    } catch (error) {
      reportError('Could not change the probe agents in Routing', error)
    } finally {
      setChoosing(null)
    }
  }

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

  // The local probe, by the name it has been given.
  const localName = home.vantages.find(vantage => vantage.kind === 'server')?.name ?? 'the local probe'

  return (
    <section className="min-w-0 rounded-3xl border border-primary/40 bg-card p-4 text-foreground @2xl/main:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            From your networks
            {flapping && <Badge size="sm" tone="warning">Flapping</Badge>}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            How {detail.prefix} is reached from {localName}
            {agents > 0 ? ` and your ${agents} probe agent${agents === 1 ? '' : 's'}` : ''}. Their routes are marked across the page:
            &ldquo;Your ISP&rdquo; for {localName}&apos;s network{agents > 0 ? ', and each probe agent by name' : ''}.
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
            {onAddProbeAgent && (
              <Button variant="ghost" size="sm" onClick={onAddProbeAgent}>
                <RadioTower {...ICON} />
                Add a probe agent
              </Button>
            )}
          </div>
        )}
      </div>

      {home.agents.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Probe agents in Routing">
          <span className="text-xs text-muted-foreground">{readOnly ? 'Looking from' : 'Looking from, choose which'}:</span>
          <span className="flex items-center gap-1.5 rounded-full border border-primary/50 bg-primary/15 py-0.5 pl-2 pr-2.5 text-xs">
            <Server size={12} strokeWidth={1.75} aria-hidden="true" />
            {localName}
          </span>
          {home.agents.map(agent =>
            readOnly ? (
              <span
                key={agent.id}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-2.5 text-xs',
                  agent.included ? 'border-primary/50 bg-primary/15' : 'border-border text-muted-foreground line-through'
                )}
              >
                <RadioTower size={12} strokeWidth={1.75} aria-hidden="true" />
                {agent.name}
              </span>
            ) : (
              <button
                key={agent.id}
                type="button"
                aria-pressed={agent.included}
                disabled={choosing !== null}
                onClick={() => void choose(agent.id, !agent.included)}
                title={agent.included ? `Leave ${agent.name} out: not traced from, nor marked on the page` : `Look from ${agent.name} too`}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-2.5 text-xs transition-colors disabled:cursor-wait',
                  agent.included ? 'border-primary/50 bg-primary/15 hover:bg-primary/25' : 'border-border text-muted-foreground hover:bg-muted',
                  choosing === agent.id && 'opacity-60'
                )}
              >
                {agent.included ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <RadioTower size={12} strokeWidth={1.75} aria-hidden="true" />}
                {agent.name}
              </button>
            )
          )}
        </div>
      )}

      <div className={cn('grid gap-4', home.vantages.length > 1 && '@4xl/main:grid-cols-2')}>
        {home.vantages.map(vantage => (
          <Vantage key={vantage.id} vantage={vantage} seen={seen.get(vantage.id)!} names={names} now={now} />
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
