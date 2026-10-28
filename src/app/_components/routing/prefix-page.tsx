'use client'

import { useMemo, useState } from 'react'
import { ArrowLeft, CheckCheck, CircleCheck, CircleMinus, CircleX, Database, Hourglass, Route, ShieldAlert, Shuffle, Trash2, X } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { MetricCard } from '@/components/arc/metric-card/metric-card'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Timeline, type TimelineEvent } from '@/components/arc/timeline/timeline'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { useToast } from '@/components/notifications'
import { countryName } from '@/lib/bgp/countries'
import { upstreamOf } from '@/lib/bgp/path'
import { addressIn } from '@/lib/bgp/prefix'
import { inPlace, inScope, placeLabel, upstreamOfPeer, upstreamShares, WORLD, type Scope } from '@/lib/bgp/scope'
import { displayLocale, displayTimeZone } from '@/lib/time-zone'
import type { Target } from '@/types/probe'
import { BGP_DIRECT, BGP_REGION_LABEL, type BgpPrefixDetail, type BgpState } from '@/types/bgp'
import { PANE, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import { StatusIndicator } from '../sidebar/status-indicator'
import { ActivityStrip, clock } from './activity-strip'
import { ExchangePanel } from './exchange-panel'
import { HomePanel } from './home-panel'
import { NetworkDialog } from './network-dialog'
import { PathGraph } from './path-graph'
import { PeerTable } from './peer-table'
import { SeenFrom } from './seen-from'
import { ago, asLabel, carrierLabel, SOURCE_NOTE, STATE_LABEL, STATE_TONE, viaLabel } from './state'
import { upstreamColors, UpstreamMix } from './upstream-mix'
import { UpdateList } from './update-list'
import { useBgpPrefix } from './use-bgp'

/**
 * One watched prefix in full: how it stands, where in the world it is seen,
 * which upstreams carry it, the paths drawn, what changed and when, the
 * ClearPing targets inside it, and every collector peer's route.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const
// `min-w-0`: in a grid a panel otherwise grows to its widest line, and on a
// phone pushed the page sideways.
const PANEL = 'min-w-0 rounded-3xl border border-border bg-card p-4 text-foreground @2xl/main:p-6'

/** Each change in "What changed" gets an icon of its own, so its marker says what happened before its title is read. */
const EVENT_ICON: Record<BgpState, React.ReactNode> = {
  learning: <Hourglass {...ICON} />,
  normal: <CircleCheck {...ICON} />,
  diverted: <Shuffle {...ICON} />,
  partial: <CircleMinus {...ICON} />,
  withdrawn: <CircleX {...ICON} />,
  hijack: <ShieldAlert {...ICON} />,
}
const EVENT_TONE: Record<BgpState, TimelineEvent['tone']> = {
  learning: 'neutral',
  normal: 'success',
  diverted: 'danger',
  partial: 'danger',
  withdrawn: 'danger',
  hijack: 'danger',
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className={PANEL}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * What the panels below are narrowed to, each part a chip that takes it off,
 * or, before anything is chosen, how to choose.
 */
function ScopeBar({ scope, names, onScope }: { scope: Scope; names: Record<number, string>; onScope: (scope: Scope) => void }) {
  const chips: { label: string; to: Scope }[] = []
  if (scope.region) chips.push({ label: BGP_REGION_LABEL[scope.region], to: { ...scope, region: null, country: null } })
  if (scope.country) chips.push({ label: countryName(scope.country), to: { ...scope, country: null } })
  if (scope.upstream !== null) {
    chips.push({ label: scope.upstream === BGP_DIRECT ? 'Directly connected' : `Through ${carrierLabel(scope.upstream, names)}`, to: { ...scope, upstream: null } })
  }
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-4 py-2 text-sm text-foreground" role="status">
      {chips.length === 0 ? (
        <span className="text-muted-foreground">
          Choose a region or an upstream below, and everything under here narrows to it.
        </span>
      ) : (
        <>
          <span className="text-muted-foreground">Showing</span>
          {chips.map(chip => (
            <button
              key={chip.label}
              type="button"
              onClick={() => onScope(chip.to)}
              aria-label={`Stop narrowing to ${chip.label}`}
              className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-primary/50 bg-primary/15 py-0.5 pl-2.5 pr-1.5 text-xs transition-colors hover:bg-primary/25"
            >
              <span className="truncate">{chip.label}</span>
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          ))}
          <span className="ml-auto">
            <Button type="button" variant="ghost" size="sm" onClick={() => onScope(WORLD)}>
              Show everything
            </Button>
          </span>
        </>
      )}
    </div>
  )
}

/** ClearPing's own targets inside the prefix: their readings are the other half of the story. */
function TargetsInside({ detail, targets, onSelectTarget }: { detail: BgpPrefixDetail; targets: Target[]; onSelectTarget: (id: string) => void }) {
  const inside = targets.filter(target => {
    const address = target.resolvedAddress ?? target.host
    return addressIn(address, detail.prefix)
  })
  if (inside.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        None of your targets is in {detail.prefix}. Add one, probed from a probe agent outside your network, and its
        latency and traces sit beside the routing here.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-border">
      {inside.map(target => (
        <li key={target.id}>
          <button
            type="button"
            onClick={() => onSelectTarget(target.id)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/40"
          >
            <StatusIndicator isOnline={target.isOnline} packetLoss={target.packetLoss} onHold={target.onHold} bare />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{target.name}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {target.host}
                {target.probeAgent ? ` · from ${target.probeAgent.name}` : ''}
              </span>
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {target.avgLatency != null ? `${target.avgLatency.toFixed(1)} ms` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function PrefixPage({
  id,
  readOnly,
  targets,
  onBack,
  onSelectTarget,
  onAddProbeAgent,
  reportError,
}: {
  id: string
  readOnly: boolean
  targets: Target[]
  onBack: () => void
  onSelectTarget: (id: string) => void
  /** Open Settings where probe agents are added: for an admin. */
  onAddProbeAgent?: () => void
  reportError: (title: string, error?: unknown) => void
}) {
  const { notify } = useToast()
  const { data: detail, missing, fetchedAt, reload } = useBgpPrefix(id, reportError)
  const [accepting, setAccepting] = useState(false)
  const [scope, setScope] = useState<Scope>(WORLD)
  const [slice, setSlice] = useState<number | null>(null)
  const [settingNetwork, setSettingNetwork] = useState(false)
  // Taken from all its upstreams, so each keeps its colour however narrow the page.
  const colors = useMemo(() => upstreamColors(detail?.status.upstreams ?? []), [detail?.status.upstreams])

  const events: TimelineEvent[] = useMemo(() => {
    // Oldest first, to know what each change was from: "Back to normal" only after trouble.
    const byTime = [...(detail?.events ?? [])].sort((a, b) => a.at - b.at)
    let was: BgpState | null = null
    return byTime.map(event => {
      const list = event.reasons.length > 1 ? <ul className="list-disc space-y-1 pl-4">{event.reasons.slice(1).map(reason => <li key={reason}>{reason}</li>)}</ul> : undefined
      if (event.kind === 'home') {
        const direct = event.reasons.every(reason => reason.includes('now reaches it directly'))
        return { id: String(event.id), at: event.at, title: direct ? 'Your route is direct again' : 'Your route changed', meta: event.reasons[0], detail: list, tone: direct ? 'success' : 'danger', icon: <Route {...ICON} /> }
      }
      const from = was
      was = event.state
      const title =
        event.state === 'normal' ? (from === null || from === 'learning' ? 'Watching: normal' : from === 'normal' ? 'Normal' : 'Back to normal') : STATE_LABEL[event.state]
      return { id: String(event.id), at: event.at, title, meta: event.reasons[0], detail: list, tone: EVENT_TONE[event.state], icon: EVENT_ICON[event.state] }
    })
  }, [detail?.events])

  const acceptNormal = async () => {
    setAccepting(true)
    try {
      const response = await fetch(`/api/bgp/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptNormal: true }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) reportError('Could not take it as normal', body?.error ?? `Server responded ${response.status}`)
      else {
        notify({ tone: 'success', title: 'Taken as normal', detail: 'Its upstreams and peers now are what it is judged against.' })
        await reload()
      }
    } catch (error) {
      reportError('Could not take it as normal', error)
    } finally {
      setAccepting(false)
    }
  }

  const remove = async () => {
    const response = await fetch(`/api/bgp/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) throw new Error('Not removed')
    notify({ tone: 'info', title: `Stopped watching ${detail?.prefix ?? 'the prefix'}` })
    onBack()
  }

  const back = (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft {...ICON} />
      Routing
    </Button>
  )

  if (missing) {
    return (
      <div className={PANE}>
        {back}
        <div className="flex justify-center p-6">
          <EmptyState title="Nothing to show" description={missing} action={<Button onClick={onBack}>Back to Routing</Button>} />
        </div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={PANE}>
        {back}
        <div className={PANEL}><Skeleton label="Loading the prefix" lines={6} /></div>
      </div>
    )
  }

  const { status } = detail
  const names = detail.asNames
  const origin = detail.baseline?.origins[0] ?? status.origins[0]
  const updates = detail.activity.reduce((sum, slice) => sum + slice.announcements + slice.withdrawals, 0)
  const usual = status.upstreams.filter(upstream => upstream.expected)
  const troubled = status.state !== 'normal' && status.state !== 'learning'
  const regions = Object.values(status.byRegion).filter(share => share.total > 0)
  const regionsWithPeers = regions.length
  const regionsSeeing = regions.filter(share => share.seen / share.total >= 0.8).length
  const placed = detail.peers.filter(peer => inPlace(peer, scope))
  const scoped = detail.peers.filter(peer => inScope(peer, scope))
  const where = placeLabel(scope)
  // Yours: the networks of this server and your probe agents, marked wherever they show.
  const mine = detail.home.mine
  const yourWays = new Map<number, string[]>()
  for (const peer of placed) {
    const whose = mine[peer.peerAsn]
    const way = upstreamOfPeer(peer)
    if (whose === undefined || way === null) continue
    const held = yourWays.get(way) ?? []
    if (!held.includes(whose)) yourWays.set(way, [...held, whose])
  }
  // The exchanges that matter to this prefix, found from what their collectors
  // hold: those it is offered at, or was when normal was taken. An exchange
  // that has nothing to do with it, a South African one for a prefix elsewhere,
  // is left out, and with none the panel is not shown. Until the collectors
  // have been read it is a placeholder.
  const wasAt = detail.baseline?.exchanges ?? []
  const exchangeViews = detail.exchanges?.views.filter(view => view.routes.length > 0 || wasAt.includes(view.exchange)) ?? []
  const exchangeLook = detail.exchanges ? { ...detail.exchanges, views: exchangeViews, error: exchangeViews.length > 0 ? detail.exchanges.error : null } : null
  const exchangeSources = [...new Set(exchangeViews.map(view => view.source))]
  // The updates in the page's scope: from peers in the place chosen, about
  // routes through the upstream chosen (before or after), in the bar chosen.
  const peerAt = new Map(detail.peers.map(peer => [`${peer.collector}|${peer.peer}`, peer]))
  const sliceEnd = slice === null ? null : slice + detail.activitySliceMs
  const scopedUpdates = detail.updates.filter(update => {
    if (slice !== null && (update.at < slice || update.at >= sliceEnd!)) return false
    if (scope.region !== null || scope.country !== null) {
      const peer = peerAt.get(`${update.collector}|${update.peer}`)
      if (!peer || !inPlace(peer, scope)) return false
    }
    if (scope.upstream !== null) {
      const now = update.path ? upstreamOf(update.path) : null
      const was = update.previousPath ? upstreamOf(update.previousPath) : null
      if (now !== scope.upstream && was !== scope.upstream) return false
    }
    return true
  })

  return (
    <div className={PANE}>
      {back}
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className={`${PANE_TITLE} font-mono`}>{detail.prefix}</h1>
            <Badge tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              detail.label,
              origin !== undefined ? `Announced by ${asLabel(origin, names)}` : null,
              detail.address ? `watched for ${detail.address}` : null,
              status.lastChange !== null && fetchedAt > 0 ? `a route last changed ${ago(status.lastChange, fetchedAt)}` : null,
            ].filter(Boolean).join(' · ')}
          </p>
          <Tooltip content={SOURCE_NOTE}>
            <p className="mt-1.5 inline-flex cursor-default items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} strokeWidth={1.75} aria-hidden="true" />
              From RIPE RIS route collectors, via RIPEstat and RIS Live
              {exchangeSources.length > 0 ? `, and ${exchangeSources.join(', ')}'s route collectors` : ''}
            </p>
          </Tooltip>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip content="Take how it is carried now as normal: after a planned change of upstream, say. What it is judged against starts again from here.">
              <span>
                <Button variant="secondary" onClick={() => void acceptNormal()} loading={accepting} disabled={status.state === 'withdrawn'}>
                  <CheckCheck {...ICON} />
                  Take as normal
                </Button>
              </span>
            </Tooltip>
            <ConfirmMorph
              label="Stop watching"
              icon={<Trash2 {...ICON} />}
              prompt="Stop watching?"
              confirmLabel="Stop"
              pendingLabel="Stopping"
              doneLabel="Stopped"
              onConfirm={remove}
            />
          </div>
        )}
      </header>

      {troubled && (
        <Alert tone={status.state === 'diverted' || status.state === 'partial' ? 'warning' : 'danger'} title={status.reasons[0]}>
          {status.reasons.length > 1 ? status.reasons.slice(1).join('. ') : 'Compared with how it was carried when normal was taken.'}
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 @2xl/main:gap-4 @5xl/main:grid-cols-4">
        <MetricCard
          label="Seen by"
          value={status.visibility.seen}
          context={`of ${status.visibility.total} collector peers`}
        />
        <MetricCard
          label="Upstreams"
          value={status.upstreams.length}
          context={usual.length === status.upstreams.length ? 'all of them usual' : `${status.upstreams.length - usual.length} not seen when normal was taken`}
        />
        <MetricCard
          label="Regions"
          value={regionsSeeing}
          context={`of ${regionsWithPeers} see it from most of their peers`}
        />
        <MetricCard label="Updates, 24h" value={updates} context={updates === 0 ? 'A quiet, stable prefix' : 'Announcements and withdrawals'} />
      </div>

      <HomePanel
        detail={detail}
        readOnly={readOnly}
        now={fetchedAt}
        onSetNetwork={() => setSettingNetwork(true)}
        onAddProbeAgent={onAddProbeAgent}
        onTraced={reload}
        reportError={reportError}
      />
      {!readOnly && (
        <NetworkDialog key={detail.home.asns.join()} open={settingNetwork} onOpenChange={setSettingNetwork} asns={detail.home.asns} agents={detail.home.agents} onSaved={() => void reload()} />
      )}

      {(exchangeLook === null || exchangeViews.length > 0) && (
        <Panel
          title="At the exchanges"
          note={exchangeLook === null ? undefined : `${exchangeViews.map(view => view.exchange).join(', ')}, by their own route collectors`}
        >
          <ExchangePanel
            look={exchangeLook}
            origins={detail.baseline?.origins ?? status.origins}
            was={detail.baseline?.exchanges}
            names={names}
            mine={mine}
            now={fetchedAt}
          />
        </Panel>
      )}

      <ScopeBar scope={scope} names={names} onScope={setScope} />

      <div className="grid gap-4 @5xl/main:grid-cols-2 @2xl/main:gap-6">
        <Panel title="Where it is seen" note={scope.upstream !== null ? `Peers, and those ${viaLabel(scope.upstream)}` : 'Collector peers, by where they are'}>
          <SeenFrom peers={detail.peers} scope={scope} onScope={setScope} colors={colors} names={names} mine={mine} />
        </Panel>
        <Panel title="Who carries it" note={`The network before the origin, in ${where}`}>
          <UpstreamMix
            upstreams={upstreamShares(placed, status.upstreams)}
            names={names}
            colors={colors}
            selected={scope.upstream}
            onSelect={upstream => setScope(current => ({ ...current, upstream }))}
            yours={yourWays}
          />
        </Panel>
      </div>

      <Panel title="Paths" note={`In ${where}. Choose a place, a network or an upstream`}>
        <PathGraph
          peers={placed}
          upstreams={status.upstreams}
          names={names}
          colors={colors}
          selected={scope.upstream}
          onSelect={upstream => setScope(current => ({ ...current, upstream }))}
          onPlace={
            scope.country !== null
              ? undefined
              : place =>
                  setScope(current =>
                    current.region === null ? { ...current, region: place as Scope['region'], country: null } : { ...current, country: place }
                  )
          }
          mine={mine}
          byCountry={scope.region !== null}
        />
      </Panel>

      <Panel title="Activity" note={`BGP updates from RIS Live over 24 hours, in ${where}. Choose a bar to see just those`}>
        <div className="space-y-4">
          <ActivityStrip activity={detail.activity} sliceMs={detail.activitySliceMs} selected={slice} onSelect={setSlice} />
          <UpdateList
            updates={scopedUpdates}
            prefix={detail.prefix}
            names={names}
            colors={colors}
            sliceLabel={slice === null ? null : `${clock(slice)} to ${clock(sliceEnd!)}`}
            onClearSlice={() => setSlice(null)}
            mine={mine}
          />
        </div>
      </Panel>

      <div className="grid gap-4 @5xl/main:grid-cols-2 @2xl/main:gap-6">
        <Panel title="What changed" note="Kept for two weeks">
          {events.length > 0 ? (
            <Timeline
              label="Changes in how the prefix stands"
              events={events}
              now={fetchedAt || detail.activity.at(-1)?.start || 0}
              timeZone={displayTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
              locale={displayLocale()}
              maxHeight={320}
              scrollToNew={false}
              headingLevel={3}
              unit={['change', 'changes']}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing has changed since it was added.</p>
          )}
        </Panel>
        <Panel title="Your targets in this prefix">
          <TargetsInside detail={detail} targets={targets} onSelectTarget={onSelectTarget} />
        </Panel>
      </div>

      <Panel
        title="Collector peers"
        note={`${scoped.length} in ${where}${scope.upstream !== null ? ` ${viaLabel(scope.upstream)}` : ''}, ${scoped.filter(peer => peer.route).length} with a route`}
      >
        <PeerTable peers={scoped} prefix={detail.prefix} upstreams={status.upstreams} names={names} colors={colors} mine={mine} now={fetchedAt} />
      </Panel>
    </div>
  )
}
