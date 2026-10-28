'use client'

import { useState, type FormEvent } from 'react'
import { Database, Network, Plus, Settings } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { useToast } from '@/components/notifications'
import type { BgpOverview, BgpPrefixSummary } from '@/types/bgp'
import { PANE, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import { RegionBars } from './region-visibility'
import { asLabel, ago, CONNECTION_LABEL, CONNECTION_TONE, SOURCE_NOTE, STATE_COLOR, STATE_LABEL, STATE_TONE } from './state'
import { UpstreamBar } from './upstream-mix'
import { NetworkDialog } from './network-dialog'
import { ResourcePreview } from './resource-preview'
import { useBgpOverview } from './use-bgp'

/**
 * BGP monitoring: the prefixes watched and how each is carried, as RIPE RIS's
 * route collectors see it. A tool of its own within ClearPing, for networks
 * that run their own address space, and off until it is turned on in Settings.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const
const PANEL = 'rounded-3xl border border-border bg-card p-4 text-foreground @2xl/main:p-6'

function ConnectionBadge({ overview }: { overview: BgpOverview }) {
  const { connection } = overview
  const state = overview.enabled ? connection.state : 'off'
  return (
    <Tooltip content={connection.error && state === 'offline' ? connection.error : 'RIPE NCC’s stream of the BGP updates its route collectors receive'}>
      <span>
        <Badge tone={CONNECTION_TONE[state]}>
          {state === 'live' && <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden="true" />}
          {CONNECTION_LABEL[state]}
        </Badge>
      </span>
    </Tooltip>
  )
}

/** What it is and what turning it on does, before it is on. */
function Intro({ onTurnOn }: { onTurnOn?: () => void }) {
  return (
    <section className={PANEL}>
      <div className="flex max-w-3xl flex-col gap-4">
        <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-primary">
          <Network {...ICON} size={20} />
        </span>
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Watch your prefixes in BGP</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            For networks that announce their own address space. ClearPing follows the routes to the prefixes you choose
            as RIPE RIS&apos;s route collectors see them, at exchanges on every continent, live as the updates arrive. It
            tells you when a prefix is withdrawn, when the world starts reaching it through a different upstream (a DDoS
            mitigation moving your traffic from the exchange to a scrubbing network, say), when a more-specific appears,
            and when another network announces it.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            It is off. Turned on, in Settings, it keeps one connection open to RIS Live (ris-live.ripe.net) and asks
            RIPEstat (stat.ripe.net) and PeeringDB (peeringdb.com) about the prefixes watched. What arrives is kept for two
            days, and the changes it adds up to for two weeks.
          </p>
        </div>
        {onTurnOn ? (
          <div>
            <Button onClick={onTurnOn}>
              <Settings {...ICON} />
              Turn it on in Settings
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">An admin can turn it on in Settings.</p>
        )}
      </div>
    </section>
  )
}

/** Adding a prefix to watch, in a dialog: the page is the list, not the form. */
function AddPrefixDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const { notify, reportError } = useToast()
  const [resource, setResource] = useState('')
  const [label, setLabel] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const change = (next: boolean) => {
    if (!next) {
      setProblem(null)
      setBusy(false)
    }
    onOpenChange(next)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!resource.trim()) {
      setProblem('Give an IP address or a prefix')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const response = await fetch('/api/bgp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource, label }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setProblem(body?.error ?? `Server responded ${response.status}`)
        return
      }
      const added = body as BgpPrefixSummary
      notify({
        tone: 'success',
        title: `Watching ${added.prefix}`,
        detail: added.address ? `The announced prefix that holds ${added.address}.` : 'Its routes are being followed now.',
      })
      setResource('')
      setLabel('')
      onAdded()
      onOpenChange(false)
    } catch (error) {
      reportError('Could not watch that', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        title="Watch a prefix"
        description="An IP address watches the announced prefix that holds it, and follows the most specific route to that address."
      >
        <form onSubmit={submit} noValidate className="space-y-4 text-foreground">
          <Input
            label="IP address or prefix"
            placeholder="203.0.113.10 or 203.0.113.0/24"
            value={resource}
            onChange={event => setResource(event.target.value)}
            error={problem ?? undefined}
            required
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <ResourcePreview resource={resource} />
          <Input label="Label" placeholder="Game servers, Johannesburg" value={label} onChange={event => setLabel(event.target.value)} />
          <p className="text-xs text-muted-foreground">
            Its routes are read from RIPEstat now, and how it is carried at this moment is taken as normal.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              <Plus {...ICON} />
              Watch
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PrefixCard({ prefix, names, now, onOpen }: { prefix: BgpPrefixSummary; names: Record<number, string>; now: number; onOpen: () => void }) {
  const { status } = prefix
  const origin = prefix.baseline?.origins[0] ?? status.origins[0]
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full cursor-pointer flex-col gap-4 rounded-3xl border border-border bg-card p-4 text-left text-foreground transition-colors hover:border-border-strong @2xl/main:p-5"
      style={status.state !== 'normal' && status.state !== 'learning' ? { borderColor: `color-mix(in oklab, ${STATE_COLOR[status.state]} 45%, var(--border))` } : undefined}
    >
      <div className="flex w-full flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-base">{prefix.prefix}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[prefix.label, origin !== undefined ? asLabel(origin, names) : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Badge tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Badge>
      </div>

      <div className="flex w-full flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-muted-foreground">
            Seen by <span className="font-mono text-foreground">{status.visibility.seen}</span> of {status.visibility.total} peers
            {status.lastChange !== null && now > 0 ? ` · last change ${ago(status.lastChange, now)}` : ''}
          </p>
          <UpstreamBar upstreams={status.upstreams} names={names} />
        </div>
        <RegionBars byRegion={status.byRegion} />
      </div>

      {status.state !== 'normal' && (
        <p className="text-xs" style={{ color: STATE_COLOR[status.state] }}>{status.reasons[0]}</p>
      )}
    </button>
  )
}

export function RoutingPage({
  readOnly,
  onOpenPrefix,
  onTurnOn,
  reportError,
}: {
  readOnly: boolean
  onOpenPrefix: (id: string) => void
  /** Open Settings where it is turned on: for an admin, who can. */
  onTurnOn?: () => void
  reportError: (title: string, error?: unknown) => void
}) {
  const { data: overview, fetchedAt, reload } = useBgpOverview(reportError)
  const [adding, setAdding] = useState(false)
  const [settingNetwork, setSettingNetwork] = useState(false)

  const attention = overview?.prefixes.filter(each => !['normal', 'learning'].includes(each.status.state)) ?? []

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Routing</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            BGP for the prefixes you watch, as RIPE RIS&apos;s route collectors see them
          </p>
        </div>
        {overview && (
          <div className="flex flex-wrap items-center gap-3">
            <ConnectionBadge overview={overview} />
            {!readOnly && overview.enabled && (
              <Button onClick={() => setAdding(true)}>
                <Plus {...ICON} />
                Watch a prefix
              </Button>
            )}
          </div>
        )}
      </header>

      {!overview ? (
        <div className={PANEL}><Skeleton label="Loading BGP monitoring" lines={4} /></div>
      ) : !overview.enabled ? (
        <Intro onTurnOn={onTurnOn} />
      ) : (
        <>
          {overview.prefixes.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {overview.prefixes.length} prefix{overview.prefixes.length === 1 ? '' : 'es'} watched
              {attention.length > 0 ? `, ${attention.length} not as normal` : ', all carried as normal'}
            </p>
          )}

          {overview.prefixes.length > 0 ? (
            <div className="grid gap-3 @2xl/main:gap-4 @5xl/main:grid-cols-2">
              {[...attention, ...overview.prefixes.filter(each => !attention.includes(each))].map(prefix => (
                <PrefixCard key={prefix.id} prefix={prefix} names={overview.asNames} now={fetchedAt} onOpen={() => onOpenPrefix(prefix.id)} />
              ))}
            </div>
          ) : (
            <section className={`${PANEL} flex justify-center`}>
              <EmptyState
                title="Nothing watched yet"
                description="Add a server's IP address or one of your prefixes, and how the world reaches it shows here."
                action={
                  readOnly ? undefined : (
                    <Button onClick={() => setAdding(true)}>
                      <Plus {...ICON} />
                      Watch a prefix
                    </Button>
                  )
                }
              />
            </section>
          )}

          <section className={`${PANEL} flex flex-wrap items-center gap-3`}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Network {...ICON} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {overview.homeAsns.length > 0
                  ? `Your network: ${overview.homeAsns.map(asn => asLabel(asn, overview.asNames)).join(', ')}`
                  : 'Your network is not set'}
              </p>
              <p className="text-xs text-muted-foreground">
                Each prefix&apos;s page shows how it reaches the prefix: its routes, and the exchange your traffic crosses.
              </p>
            </div>
            {!readOnly && (
              <Button variant="secondary" size="sm" onClick={() => setSettingNetwork(true)}>
                {overview.homeAsns.length > 0 ? 'Change' : 'Set your network'}
              </Button>
            )}
          </section>

          <Tooltip content={SOURCE_NOTE}>
            <p className="inline-flex cursor-default items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} strokeWidth={1.75} aria-hidden="true" />
              Routes from RIPE RIS route collectors, via RIPEstat and RIS Live: how other networks reach your prefixes
            </p>
          </Tooltip>

          {!readOnly && <AddPrefixDialog open={adding} onOpenChange={setAdding} onAdded={() => void reload()} />}
          {!readOnly && (
            <NetworkDialog key={overview.homeAsns.join()} open={settingNetwork} onOpenChange={setSettingNetwork} asns={overview.homeAsns} onSaved={() => void reload()} />
          )}
        </>
      )}
    </div>
  )
}
