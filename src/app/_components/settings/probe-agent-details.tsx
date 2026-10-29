'use client'

import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, CircleArrowUp, KeyRound, Pencil, Plug, ShieldCheck, Trash2, X } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge, type BadgeTone } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Input } from '@/components/arc/input/input'
import { NumberField } from '@/components/arc/number-field/number-field'
import { useToast } from '@/components/notifications'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { exposureOfAddress } from '@/lib/probe-agents/exposure'
import { PROBE_AGENT_NAME_MAX, readProbeAgentAddress } from '@/lib/probe-agents/input'
import type { ProbeAgentInstall } from '@/lib/probe-agents/install'
import { inDisplayZone } from '@/lib/time-zone'
import { compareVersions } from '@/lib/version'
import { cn } from '@/lib/utils'
import type { ProbeAgent, ProbeAgentExposure, ProbeAgentState } from '@/types/probe-agent'
import { PROBE_AGENT_EXPOSURE, PROBE_AGENT_STATE } from './probe-agent-labels'
import { Masked } from '../privacy/masked'

/**
 * One probe agent's details, in the panel that opens from its row in
 * Settings → Probe agents: how it is doing, how it is reached, the machine it
 * runs on and its targets, and what can be done to it, renaming included.
 * With the bits the page and the panel share.
 */

export const HINT = 'text-xs leading-relaxed text-muted-foreground'
export const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

export type Outcome =
  | { ok: true; fingerprint: string; pinned: boolean; info: { version: string; hostname: string } }
  | { ok: false; state: ProbeAgentState; error: string; offeredFingerprint?: string }

export async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: response.ok, body: await response.json().catch(() => ({})) }
}

export function when(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' })) : 'never'
}

/** How long ago, in the words a list of machines uses: "Just now", "5 min ago". */
export function ago(ms: number | undefined, now: number): string {
  if (!ms) return 'Never'
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return when(ms)
}

export function addressOf(agent: Pick<ProbeAgent, 'address' | 'port'>): string {
  return `${agent.address.includes(':') ? `[${agent.address}]` : agent.address}:${agent.port}`
}

/**
 * How to take a probe agent off its machine again, for each way it can have
 * been put there. The Linux one is the install script again, told to uninstall.
 */
export function uninstallCommands(install: ProbeAgentInstall): { docker: string; linux: string } {
  return {
    docker: ['docker rm -f clearping-probe-agent', 'docker volume rm clearping-probe-agent'].join('\n'),
    linux: `curl -fsSL ${install.scriptUrl} | sudo sh -s -- uninstall`,
  }
}

/** What the address typed so far says about how the agent will be reached. */
export function ExposureNote({ exposure }: { exposure: ProbeAgentExposure }) {
  if (exposure === 'public') {
    return (
      <Alert tone="warning" title="This probe agent is reached over the internet">
        ClearPing encrypts the connection and the agent only answers this dashboard&apos;s token, but its port is open
        to anyone who finds it. On the agent&apos;s machine, allow only this dashboard&apos;s address through the
        firewall, or connect the two over a tailnet such as Tailscale.
      </Alert>
    )
  }
  if (exposure === 'tailnet') {
    return (
      <Alert tone="success" title="Over a tailnet">
        Nothing outside the tailnet can reach the agent&apos;s port, so there is no port to open on the internet.
      </Alert>
    )
  }
  return <p className={HINT}>{PROBE_AGENT_EXPOSURE.private.detail}</p>
}

export function OutcomeAlert({ outcome, name }: { outcome: Outcome; name: string }) {
  if (outcome.ok) {
    return (
      <Alert tone="success" title={`Connected to ${name}`}>
        {outcome.info.hostname}, version {outcome.info.version}.{' '}
        {outcome.pinned ? 'Its certificate is trusted from now on' : 'Its certificate is the trusted one'}: SHA-256{' '}
        <span className="break-all font-mono">{outcome.fingerprint}</span>. It should match the fingerprint the probe
        agent printed when it started.
      </Alert>
    )
  }
  return (
    <Alert tone={outcome.state === 'cert-changed' ? 'warning' : 'danger'} title={`Could not connect to ${name}`}>
      {outcome.error}.
      {outcome.offeredFingerprint && (
        <>
          {' '}It presents <span className="break-all font-mono">{outcome.offeredFingerprint}</span>. If that is the one in
          its log (it was reinstalled, say), trust it from its details.
        </>
      )}
    </Alert>
  )
}

/** The colours of a state, as a block, a dot and its text: the same tones as its badge in the list. */
const STATUS: Record<BadgeTone, { block: string; dot: string; text: string }> = {
  success: { block: 'border-success/25 bg-success/10', dot: 'bg-success', text: 'text-success' },
  danger: { block: 'border-destructive/25 bg-destructive/10', dot: 'bg-destructive', text: 'text-destructive' },
  warning: { block: 'border-warning/25 bg-warning/10', dot: 'bg-warning', text: 'text-warning' },
  info: { block: 'border-border bg-muted/40', dot: 'bg-primary', text: 'text-foreground' },
  neutral: { block: 'border-border bg-muted/40', dot: 'bg-muted-foreground', text: 'text-foreground' },
}

/** A titled group of facts, each a row with its label on the left and the fact on the right. */
function Facts({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <dl className="divide-y divide-border rounded-2xl border border-border bg-muted/30">{children}</dl>
    </section>
  )
}

function Fact({ label, children, below }: { label: string; children: ReactNode; below?: ReactNode }) {
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
        <dd className="min-w-0 text-right text-sm text-foreground">{children}</dd>
      </div>
      {below}
    </div>
  )
}

/** Whether a probe agent is on an older version than this dashboard: never when either is not a numbered release. */
export function isOutdated(agent: ProbeAgent, dashboardVersion: string | undefined): boolean {
  if (!agent.version || !dashboardVersion) return false
  return (compareVersions(agent.version, dashboardVersion) ?? 0) < 0
}

export function OutdatedBadge() {
  return (
    <Badge size="sm" tone="warning" icon={<CircleArrowUp size={11} strokeWidth={2} aria-hidden />}>
      Out of date
    </Badge>
  )
}

/** A certificate fingerprint, in full, in a box of its own: it is read pair by pair against the agent's log. */
function Fingerprint({ value, tone = 'neutral' }: { value: string; tone?: 'neutral' | 'warning' }) {
  return (
    <p
      className={cn(
        'break-all rounded-lg px-3 py-2 font-mono text-[11px] leading-relaxed',
        tone === 'warning' ? 'bg-warning/10 text-warning' : 'bg-background text-muted-foreground'
      )}
    >
      {value}
    </p>
  )
}

/** Changing a probe agent's name, or where it is reached. Its certificate stays pinned: it is the same agent. */
function EditForm({ agent, onDone, onCancel }: { agent: ProbeAgent; onDone: () => void; onCancel: () => void }) {
  const { notify, reportError } = useToast()
  const [name, setName] = useState(agent.name)
  const [address, setAddress] = useState(agent.address)
  const [port, setPort] = useState(agent.port)
  const [busy, setBusy] = useState(false)
  const typed = readProbeAgentAddress(address)
  const moved = typed.ok && typed.value !== agent.address
  const changed = name.trim() !== agent.name || address.trim() !== agent.address || port !== agent.port

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!changed) return onCancel()
    setBusy(true)
    const body: Record<string, unknown> = {}
    if (name.trim() !== agent.name) body.name = name.trim()
    if (address.trim() !== agent.address) body.address = address
    if (port !== agent.port) body.port = port
    const { ok, body: answer } = await send(`/api/security/probe-agents/${agent.id}`, 'PATCH', body)
    setBusy(false)
    if (!ok) return reportError(`Could not change ${agent.name}`, answer.error)
    notify({ tone: 'success', title: body.name ? `Renamed to ${name.trim()}` : `${name.trim()} is changed` })
    onDone()
  }

  return (
    <form noValidate onSubmit={save} className="space-y-4 rounded-2xl border border-border bg-muted/30 p-4">
      <Input label="Name" required maxLength={PROBE_AGENT_NAME_MAX} value={name} onChange={event => setName(event.target.value)} autoFocus />
      {/* The port as wide as its field needs, the address the rest. */}
      <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          label="Address"
          required
          value={address}
          onChange={event => setAddress(event.target.value)}
          error={address.trim() && !typed.ok ? typed.error : undefined}
        />
        <NumberField
          id={`probe-agent-${agent.id}-port`}
          label="Port"
          min={1}
          max={65535}
          value={port}
          onValueChange={setPort}
          formatOptions={{ useGrouping: false }}
        />
      </div>
      {moved && typed.ok && <ExposureNote exposure={exposureOfAddress(typed.value)} />}
      <p className={HINT}>
        Its certificate stays trusted: it is the same probe agent, reached another way, and has to prove it with the
        same certificate. Its targets keep their history.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          <X {...ICON} />
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={busy || !name.trim() || !typed.ok}>
          <Check {...ICON} />
          Save
        </Button>
      </div>
    </form>
  )
}

export function ProbeAgentDetails({
  agent,
  install,
  dashboardVersion,
  now,
  outcome,
  connecting,
  onConnect,
  onRenewToken,
  onRemove,
  onChanged,
  onShowTargets,
}: {
  agent: ProbeAgent
  /** Where the probe agent is installed from, for the command that takes it off again. */
  install: ProbeAgentInstall
  /** This dashboard's version, which the probe agent's is compared with. */
  dashboardVersion?: string
  now: number
  /** How the last connection to it went, if it was this session. */
  outcome: Outcome | null
  connecting: boolean
  onConnect: (trust?: boolean) => Promise<void>
  onRenewToken: () => Promise<void>
  onRemove: () => Promise<void>
  onChanged: () => void
  onShowTargets?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const state = PROBE_AGENT_STATE[agent.state]
  const status = STATUS[state.tone]
  const exposure = PROBE_AGENT_EXPOSURE[agent.exposure]
  const outdated = isOutdated(agent, dashboardVersion)
  const missingTools = agent.tools ? [!agent.tools.ping && 'ping', !agent.tools.traceroute && 'traceroute'].filter(Boolean) : []

  return (
    <div className="space-y-6 text-foreground">
      {/* How it is doing, first and in its colour. */}
      <div className={cn('space-y-3 rounded-2xl border p-4', status.block)}>
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2.5">
            <span className={cn('size-2.5 shrink-0 rounded-full', status.dot)} aria-hidden />
            <span className={cn('text-base font-medium', status.text)}>{state.label}</span>
          </p>
          <span className="text-xs text-muted-foreground" title={agent.lastSeenAt ? when(agent.lastSeenAt) : undefined}>
            {agent.lastSeenAt ? `Seen ${ago(agent.lastSeenAt, now).toLowerCase()}` : 'Never seen'}
          </span>
        </div>
        {agent.state !== 'online' && agent.lastError && <p className="text-sm text-foreground">{agent.lastError}</p>}
        {agent.state === 'cert-changed' && agent.offeredFingerprint && (
          <div className="space-y-1.5">
            <p className="text-sm">It now presents another certificate:</p>
            <Fingerprint value={agent.offeredFingerprint} tone="warning" />
            <p className={HINT}>Trust it below if this is the fingerprint in its log, say after it was reinstalled.</p>
          </div>
        )}
      </div>

      {outcome && <OutcomeAlert outcome={outcome} name={agent.name} />}

      {editing ? (
        <EditForm agent={agent} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onChanged() }} />
      ) : (
        <>
          <Facts title="Connection">
            <Fact label="Address">
              <span className="break-all font-mono text-xs"><Masked value={addressOf(agent)} /></span>
            </Fact>
            <Fact label="Reached over" below={<p className={cn(HINT, 'text-left')}>{exposure.detail}</p>}>
              <Badge size="sm" tone={exposure.tone}>{exposure.label}</Badge>
            </Fact>
            <Fact
              label="Certificate"
              below={agent.fingerprint ? <Fingerprint value={agent.fingerprint} /> : undefined}
            >
              {agent.fingerprint ? (
                <Badge size="sm" tone="success" icon={<ShieldCheck size={11} strokeWidth={2} aria-hidden />}>Trusted</Badge>
              ) : (
                <span className="text-muted-foreground">Not connected yet</span>
              )}
            </Fact>
          </Facts>

          <Facts title="Machine">
            <Fact label="Name">{agent.hostname ?? <span className="text-muted-foreground">Not known yet</span>}</Fact>
            <Fact
              label="Version"
              below={outdated ? (
                <p className={HINT}>
                  This dashboard is on <span className="font-mono">{dashboardVersion}</span>. Update it with{' '}
                  <span className="font-mono">docker compose pull</span>, or by running the install line again.
                </p>
              ) : undefined}
            >
              {agent.version ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  {outdated && <OutdatedBadge />}
                  <span className="font-mono text-xs">{agent.version}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Not known yet</span>
              )}
            </Fact>
            {agent.platform && <Fact label="Platform"><span className="font-mono text-xs">{agent.platform}</span></Fact>}
            {agent.tools && (
              <Fact label="Tools">
                <span className="inline-flex flex-wrap justify-end gap-1">
                  <Badge size="sm" tone={agent.tools.ping ? 'success' : 'warning'}>ping</Badge>
                  <Badge size="sm" tone={agent.tools.traceroute ? 'success' : 'warning'}>traceroute</Badge>
                </span>
              </Fact>
            )}
          </Facts>
          {missingTools.length > 0 && (
            <Alert tone="warning" title={`No ${missingTools.join(' or ')} on that machine`}>
              Install it there, or its targets that need it cannot be probed.
            </Alert>
          )}

          <Facts title="Targets">
            <Fact label="Targets probed from it">
              {agent.targetCount > 0 && onShowTargets ? (
                <button type="button" className="text-sm font-medium text-primary underline-offset-4 hover:underline" onClick={onShowTargets}>
                  {agent.targetCount} {agent.targetCount === 1 ? 'target' : 'targets'}
                </button>
              ) : (
                <span className="text-muted-foreground">None yet</span>
              )}
            </Fact>
            <Fact label="Added">{when(agent.createdAt)}</Fact>
          </Facts>
        </>
      )}

      {/* What can be done to it: the everyday two side by side, then the two that change how it is set up. */}
      {!editing && (
        <div className="space-y-4 border-t border-border pt-5">
          <div className="grid gap-2 sm:grid-cols-2">
            {agent.state === 'cert-changed' && agent.offeredFingerprint ? (
              <ConfirmMorph
                label="Trust new certificate"
                icon={<ShieldCheck {...ICON} />}
                tone="neutral"
                prompt="Trust it?"
                confirmLabel="Trust"
                doneLabel="Trusted"
                onConfirm={() => onConnect(true)}
              />
            ) : (
              <Button type="button" loading={connecting} onClick={() => onConnect().catch(() => {})}>
                <Plug {...ICON} />
                {agent.fingerprint ? 'Test the connection' : 'Connect'}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil {...ICON} />
              Rename or move
            </Button>
          </div>

          <div className="divide-y divide-border rounded-2xl border border-border">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 max-w-60">
                <p className="text-sm font-medium">New token</p>
                <p className={HINT}>If the token is lost. The old one stops working straight away.</p>
              </div>
              <ConfirmMorph
                label="New token"
                icon={<KeyRound {...ICON} />}
                tone="neutral"
                prompt="Replace it?"
                confirmLabel="Replace"
                doneLabel="Made"
                onConfirm={onRenewToken}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 max-w-60">
                <p className="text-sm font-medium">Remove</p>
                <p className={HINT}>Only once no target is probed from it.</p>
              </div>
              <ConfirmMorph
                label="Remove"
                icon={<Trash2 {...ICON} />}
                prompt="Remove it?"
                confirmLabel="Remove"
                doneLabel="Removed"
                onConfirm={onRemove}
              />
            </div>
          </div>

          {/* Removing it here forgets it; this takes it off the machine it runs on. */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Uninstalling it from {agent.hostname ?? 'its machine'}</h3>
            <CodeBlock code={uninstallCommands(install).docker} filename="Run with Docker" language="bash" />
            <CodeBlock code={uninstallCommands(install).linux} filename="Installed with the Linux command" language="bash" />
            <p className={HINT}>
              Both also delete its certificate, so a fresh install is trusted as a new probe agent. Remove it here too.
            </p>
          </section>
        </div>
      )}
    </div>
  )
}
