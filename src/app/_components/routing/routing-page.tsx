'use client'

import { useState, type FormEvent } from 'react'
import { Database, Network, Plus, Settings } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { useToast } from '@/components/notifications'
import { addressIn, isAddress, isPublicAddress } from '@/lib/bgp/prefix'
import type { BgpOverview, BgpPrefixSummary } from '@/types/bgp'
import type { GroupOrder, Target } from '@/types/probe'
import { PANE, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import { TargetChecklist } from '../sidebar/target-checklist'
import { RegionBars } from './region-visibility'
import { RoutingSkeleton } from './skeleton'
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
            For networks that announce their own address space. ClearPing follows the routes to the prefixes you pick,
            live, as RIPE RIS route collectors at exchanges on every continent see them. You are told when a prefix is
            withdrawn, when traffic to it moves to a different upstream (DDoS scrubbing taking over from the exchange, say),
            when a more-specific appears, and when another network announces it.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            It is off until you turn it on in Settings. Then ClearPing keeps one connection open to RIS Live
            (ris-live.ripe.net) and asks RIPEstat (stat.ripe.net) and PeeringDB (peeringdb.com) about the prefixes you
            watch. Updates are kept for two days, and the changes they add up to for two weeks.
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

/** The IP address a target is at, if it is known: a public one is what BGP can follow. */
function addressOf(target: Target): string | null {
  const address = isAddress(target.host) ? target.host : target.resolvedAddress
  return address && isPublicAddress(address) ? address : null
}

/** What was typed, as the separate addresses and prefixes in it. */
function wordsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter(Boolean))]
}

/**
 * Adding a prefix to watch, in a dialog: the page is the list, not the form.
 * The box holds every address and prefix to watch, separated by commas;
 * ticking a target puts its address there and unticking takes it out, so what
 * will be watched is always what the box says.
 */
function AddPrefixDialog({
  open,
  onOpenChange,
  onAdded,
  targets,
  groupOrders,
  watched,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
  /** Your targets, to choose from. */
  targets: Target[]
  groupOrders: GroupOrder[]
  /** The prefixes already watched. */
  watched: string[]
}) {
  const { notify, reportError } = useToast()
  const [resource, setResource] = useState('')
  const [label, setLabel] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Targets with a public address. Those a watched prefix already holds are
  // not offered: ticking one could do nothing.
  const usable = targets.flatMap(target => {
    const address = addressOf(target)
    return address ? [{ target, address }] : []
  })
  const choices = usable.filter(each => !watched.some(prefix => addressIn(each.address, prefix)))
  const coveredCount = usable.length - choices.length
  const words = wordsOf(resource)
  // A target is ticked when its address is in the box, however it got there.
  const chosen = new Set(choices.filter(each => words.includes(each.address)).map(each => each.target.id))

  const tick = (next: Set<string>) => {
    const added = choices.filter(each => next.has(each.target.id) && !chosen.has(each.target.id)).map(each => each.address)
    // Targets that share an address tick and untick together: unticking one takes the address out.
    const removed = new Set(choices.filter(each => !next.has(each.target.id) && chosen.has(each.target.id)).map(each => each.address))
    const kept = words.filter(word => !removed.has(word))
    setResource([...new Set([...kept, ...added])].join(', '))
    setProblem(null)
  }

  // Closed, it starts empty next time rather than with what was ticked before.
  const change = (next: boolean) => {
    if (busy) return
    if (!next) {
      setResource('')
      setLabel('')
      setProblem(null)
    }
    onOpenChange(next)
  }

  /** The label for one address or prefix: what was typed for a single one, else a ticked target's own name. */
  const labelFor = (word: string) => {
    const typed = label.trim()
    if (typed && words.length === 1) return typed
    return choices.find(each => each.address === word)?.target.name ?? typed
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (words.length === 0) {
      setProblem('Give an IP address or a prefix, or tick a target')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const added: BgpPrefixSummary[] = []
      // Two addresses in one announced prefix: the second finds it watched already, which is not a failure.
      const already: string[] = []
      const failed: { word: string; reason: string }[] = []
      for (const word of words) {
        const response = await fetch('/api/bgp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resource: word, label: labelFor(word) }),
        })
        const body = await response.json().catch(() => null)
        if (response.ok) added.push(body as BgpPrefixSummary)
        else if (response.status === 409) already.push(word)
        else failed.push({ word, reason: body?.error ?? `Server responded ${response.status}` })
      }
      if (added.length > 0) {
        notify({
          tone: 'success',
          title: added.length === 1 ? `Watching ${added[0].prefix}` : `Watching ${added.length} prefixes`,
          detail:
            added.length === 1
              ? `${added[0].address ? `The announced prefix that holds ${added[0].address}. ` : ''}Its routes are being read from RIPEstat, which can take a minute.`
              : `${added.map(each => each.prefix).join(', ')}. Their routes are being read from RIPEstat, which can take a minute.`,
        })
        onAdded()
      }
      if (already.length > 0) {
        notify({
          tone: 'info',
          title: `${already.length === 1 ? already[0] : `${already.length} of them`} already watched`,
          detail: 'The announced prefix that holds it is watched already, so nothing more was added.',
        })
      }
      if (failed.length > 0) {
        // What was added is done; what failed stays in the box to be put right.
        setResource(failed.map(each => each.word).join(', '))
        setProblem(failed.map(each => (words.length > 1 ? `${each.word}: ${each.reason}` : each.reason)).join('. '))
        return
      }
      setResource('')
      setLabel('')
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
        description="Give a prefix, or an IP address to watch the announced prefix it sits in, following the most specific route to it."
        style={{ width: 'min(calc(100vw - 2rem), 600px)' }}
      >
        <form onSubmit={submit} noValidate className="space-y-4 text-foreground">
          <Input
            label="IP addresses or prefixes"
            placeholder="203.0.113.10 or 203.0.113.0/24, separated by commas"
            value={resource}
            onChange={event => setResource(event.target.value)}
            error={problem ?? undefined}
            required
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <ResourcePreview resource={words.length === 1 ? words[0] : ''} />
          <Input
            label="Label"
            placeholder={words.length > 1 ? 'Each ticked target is labelled with its name' : 'Game servers, Johannesburg'}
            value={label}
            onChange={event => setLabel(event.target.value)}
          />
          {choices.length > 0 && (
            // Disabled while watching, so what is ticked cannot change under it.
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="text-sm font-medium">Or tick your targets</legend>
              <p className="text-xs text-muted-foreground">
                Ticking a target puts its address in the box above, and unticking takes it out. Each is labelled with the
                target&apos;s name; a label given is used when there is only one.
              </p>
              <TargetChecklist
                targets={choices.map(({ target, address }) => ({ ...target, host: address }))}
                groupOrders={groupOrders}
                selected={chosen}
                onChange={tick}
                searchable
                maxHeight="min(14rem, 28dvh)"
              />
            </fieldset>
          )}
          {coveredCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {coveredCount === usable.length ? 'Every one of your targets is' : `${coveredCount} of your targets ${coveredCount === 1 ? 'is' : 'are'}`} in
              a prefix already watched, so {coveredCount === 1 ? 'it is' : 'they are'} not listed.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            It is added at once and its routes read from RIPEstat in the background; how it is carried when they arrive
            is taken as normal.
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
  targets,
  groupOrders,
  onOpenPrefix,
  onTurnOn,
  reportError,
}: {
  readOnly: boolean
  /** Your targets, to choose prefixes to watch from. */
  targets: Target[]
  groupOrders: GroupOrder[]
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
        <RoutingSkeleton />
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
                description="Add a server's IP address or one of your prefixes to see how the rest of the internet reaches it."
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
              How the rest of the internet reaches your prefixes, live from RIPE RIS route collectors
            </p>
          </Tooltip>

          {!readOnly && (
            <AddPrefixDialog
              open={adding}
              onOpenChange={setAdding}
              onAdded={() => void reload()}
              targets={targets}
              groupOrders={groupOrders}
              watched={overview.prefixes.map(each => each.prefix)}
            />
          )}
          {!readOnly && (
            <NetworkDialog key={overview.homeAsns.join()} open={settingNetwork} onOpenChange={setSettingNetwork} asns={overview.homeAsns} agents={overview.agents} onSaved={() => void reload()} />
          )}
        </>
      )}
    </div>
  )
}
