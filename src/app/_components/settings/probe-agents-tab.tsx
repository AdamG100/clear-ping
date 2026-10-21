'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { KeyRound, Plug, RadioTower, ShieldCheck, Trash2 } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { NumberField } from '@/components/arc/number-field/number-field'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/arc/tabs/tabs'
import { useToast } from '@/components/notifications'
import { isIpv6 } from '@/lib/probes/host'
import { exposureOfAddress } from '@/lib/probe-agents/exposure'
import { readProbeAgentAddress } from '@/lib/probe-agents/input'
import type { ProbeAgentInstall } from '@/lib/probe-agents/install'
import { PROBE_AGENT_DEFAULT_PORT } from '@/lib/probe-agents/protocol'
import { inDisplayZone } from '@/lib/time-zone'
import type { ProbeAgent, ProbeAgentExposure, ProbeAgentState } from '@/types/probe-agent'
import { CopyField } from './mcp-setup'
import { PROBE_AGENT_EXPOSURE, PROBE_AGENT_STATE } from './probe-agent-labels'

/**
 * Settings → Probe agents: the other machines targets can be probed from.
 *
 * A probe agent is a small ClearPing program on another machine (a VPS in
 * another country, a box at the office) that takes readings from there and
 * hands them to this dashboard. Nothing to do with AI agents. Adding one makes
 * a token and shows how to start the agent with it; connecting pins the
 * agent's certificate, so from then on this dashboard talks to that agent and
 * nothing else, encrypted, on any network.
 */

const HINT = 'text-xs leading-relaxed text-muted-foreground'
const SECTION_TITLE = 'text-sm font-medium text-card-foreground'
const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

interface Loaded {
  probeAgents: ProbeAgent[]
  install: ProbeAgentInstall
}

type Outcome =
  | { ok: true; fingerprint: string; pinned: boolean; info: { version: string; hostname: string } }
  | { ok: false; state: ProbeAgentState; error: string; offeredFingerprint?: string }

/** A token just made, shown with how to start the agent with it. Never kept: a reload loses it. */
interface Made {
  agent: ProbeAgent
  token: string
  install: ProbeAgentInstall
  /** A replacement for a token that was lost, rather than a new agent. */
  renewed: boolean
}

type Way = 'docker' | 'compose' | 'linux'

const WAYS: { value: Way; label: string }[] = [
  { value: 'docker', label: 'Docker' },
  { value: 'compose', label: 'Docker Compose' },
  { value: 'linux', label: 'Linux, no Docker' },
]

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: response.ok, body: await response.json().catch(() => ({})) }
}

function when(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' })) : 'never'
}

/** The first few pairs of a fingerprint, enough to tell two apart at a glance. */
function shortFingerprint(fingerprint: string): string {
  return `${fingerprint.slice(0, 23)}…`
}

/**
 * How to start the agent, with everything filled in. Where it is reached by a
 * private or tailnet IP, the port is published on that address only, which
 * keeps it off every other interface the machine has.
 */
function installCommands(agent: ProbeAgent, token: string, install: ProbeAgentInstall): Record<Way, string> {
  const bindIp = agent.exposure !== 'public' && /^[\d.]+$|:/.test(agent.address) ? agent.address : null
  const bindHost = bindIp && isIpv6(bindIp) ? `[${bindIp}]` : bindIp
  const published = bindHost ? `${bindHost}:${agent.port}:7380` : `${agent.port}:7380`
  const image = `${install.image}:${install.tag}`
  const listen = `${bindHost ?? '0.0.0.0'}:${agent.port}`

  return {
    docker: [
      'docker run -d --name clearping-probe-agent --restart unless-stopped \\',
      `  -p ${published} \\`,
      `  -e CLEARPING_PROBE_AGENT_TOKEN=${token} \\`,
      '  -v clearping-probe-agent:/data \\',
      `  ${image}`,
    ].join('\n'),
    compose: [
      'services:',
      '  clearping-probe-agent:',
      `    image: ${image}`,
      '    container_name: clearping-probe-agent',
      '    restart: unless-stopped',
      '    ports:',
      `      - "${published}"`,
      '    environment:',
      `      CLEARPING_PROBE_AGENT_TOKEN: "${token}"`,
      '    volumes:',
      '      - probe-agent-data:/data',
      '',
      'volumes:',
      '  probe-agent-data:',
    ].join('\n'),
    linux: `curl -fsSL ${install.scriptUrl} | sudo CLEARPING_PROBE_AGENT_TOKEN=${token} CLEARPING_PROBE_AGENT_LISTEN=${listen} sh`,
  }
}

/** What the address typed so far says about how the agent will be reached. */
function ExposureNote({ exposure }: { exposure: ProbeAgentExposure }) {
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

function OutcomeAlert({ outcome, name }: { outcome: Outcome; name: string }) {
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
          its log (it was reinstalled, say), trust it from the list below.
        </>
      )}
    </Alert>
  )
}

export function ProbeAgentsTab({ onShowTargets }: { onShowTargets?: (probeAgentId: string) => void }) {
  const { notify, reportError } = useToast()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [port, setPort] = useState(PROBE_AGENT_DEFAULT_PORT)
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const [way, setWay] = useState<Way>('docker')
  const [connecting, setConnecting] = useState<string | null>(null)
  // How the last connection went, shown once, above the list.
  const [lastOutcome, setLastOutcome] = useState<{ id: string; name: string; outcome: Outcome } | null>(null)

  const load = useCallback(async () => {
    const { ok, body } = await send('/api/security/probe-agents', 'GET')
    if (!ok) return setLoadError(String(body.error ?? 'Could not load the probe agents'))
    setLoaded(body as unknown as Loaded)
  }, [])

  useEffect(() => {
    // Loaded when the tab opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const typed = readProbeAgentAddress(address)
  const exposure = typed.ok ? exposureOfAddress(typed.value) : null

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/probe-agents', 'POST', { name: name.trim(), address, port })
    setBusy(false)
    if (!ok) return reportError('Could not add the probe agent', body.error)
    setMade({ agent: body.probeAgent as ProbeAgent, token: String(body.token), install: body.install as ProbeAgentInstall, renewed: false })
    setName('')
    setAddress('')
    setPort(PROBE_AGENT_DEFAULT_PORT)
    void load()
  }

  const connect = async (agent: ProbeAgent, trust = false) => {
    setConnecting(agent.id)
    const { ok, body } = await send(`/api/security/probe-agents/${agent.id}/connect`, 'POST', trust ? { trust: true } : {})
    setConnecting(null)
    if (!ok) {
      reportError(`Could not connect to ${agent.name}`, body.error)
      throw new Error(String(body.error ?? 'Could not connect'))
    }
    const outcome = body.outcome as Outcome
    setLastOutcome({ id: agent.id, name: agent.name, outcome })
    if (outcome.ok) notify({ tone: 'success', title: `Connected to ${agent.name}`, detail: `Version ${outcome.info.version}` })
    void load()
    if (trust && !outcome.ok) throw new Error(outcome.error)
  }

  const renewToken = async (agent: ProbeAgent) => {
    const { ok, body } = await send(`/api/security/probe-agents/${agent.id}/token`, 'POST')
    if (!ok) {
      reportError('Could not make a new token', body.error)
      throw new Error(String(body.error ?? 'Could not make a new token'))
    }
    setMade({ agent: body.probeAgent as ProbeAgent, token: String(body.token), install: body.install as ProbeAgentInstall, renewed: true })
    void load()
  }

  const remove = async (agent: ProbeAgent) => {
    const { ok, body } = await send(`/api/security/probe-agents/${agent.id}`, 'DELETE')
    if (!ok) {
      reportError(`Could not remove ${agent.name}`, body.error)
      throw new Error(String(body.error ?? 'Could not remove it'))
    }
    if (made?.agent.id === agent.id) setMade(null)
    void load()
  }

  if (loadError) return <Alert tone="danger" title="Could not load the probe agents">{loadError}</Alert>
  if (!loaded) return <Skeleton label="Loading the probe agents" lines={4} />

  const madeAgent = made ? loaded.probeAgents.find(agent => agent.id === made.agent.id) ?? made.agent : null
  const commands = made && madeAgent ? installCommands(madeAgent, made.token, made.install) : null
  const rows = loaded.probeAgents.map(agent => ({ ...agent, agent }))

  return (
    <div className="space-y-6 text-foreground">
      <div className="space-y-1">
        <p className={SECTION_TITLE}>Take readings from other machines</p>
        <p className={HINT}>
          A probe agent is a small ClearPing program that runs on another machine, such as a VPS in another country, and
          takes readings from there for this dashboard. A target probed from it shows the network as seen from that
          machine. Probe agents have nothing to do with AI agents or the assistant.
        </p>
      </div>

      {made && madeAgent && commands && (
        <div className="space-y-3">
          <Alert tone="success" title={made.renewed ? `A new token for ${madeAgent.name}` : `Now start ${madeAgent.name}`}>
            Copy the token now: it is not shown again. {made.renewed
              ? 'The old one no longer works, so restart the probe agent with this one.'
              : 'Run one of these on the machine the probe agent is for, then connect to it.'}
          </Alert>
          <CopyField id="probe-agent-token" label="Token" value={made.token} />

          <Tabs value={way} onValueChange={value => setWay(value as Way)}>
            <TabsList aria-label="How to run it">
              {WAYS.map(option => (
                <TabsTrigger key={option.value} value={option.value}>
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="docker">
              <div className="space-y-2 text-foreground">
                <CodeBlock code={commands.docker} filename="On the probe agent's machine" language="bash" />
                <p className={HINT}>
                  Its certificate is kept in the volume, so it stays the same when the container is replaced. For IPv6
                  targets, run it with <span className="font-mono">--network host</span> in place of{' '}
                  <span className="font-mono">-p</span>, and set{' '}
                  <span className="font-mono">CLEARPING_PROBE_AGENT_LISTEN</span> to the address to listen on.
                </p>
              </div>
            </TabsContent>
            <TabsContent value="compose">
              <div className="space-y-2 text-foreground">
                <CodeBlock code={commands.compose} filename="compose.yaml" language="yaml" />
                <p className={HINT}>Then <span className="font-mono">docker compose up -d</span> beside it.</p>
              </div>
            </TabsContent>
            <TabsContent value="linux">
              <div className="space-y-2 text-foreground">
                <CodeBlock code={commands.linux} filename="On the probe agent's machine" language="bash" />
                <p className={HINT}>
                  Installs a single program for x64 or ARM64 and runs it as a service, under a user of its own. Run it
                  again to update. It needs <span className="font-mono">ping</span> and{' '}
                  <span className="font-mono">traceroute</span> on the machine, and says if they are missing.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          {lastOutcome?.id === madeAgent.id && <OutcomeAlert outcome={lastOutcome.outcome} name={madeAgent.name} />}

          {/* Each on a line of its own: buttons are inline. */}
          <div className="flex flex-wrap gap-2">
            <Button type="button" loading={connecting === madeAgent.id} onClick={() => connect(madeAgent).catch(() => {})}>
              <Plug {...ICON} />
              {madeAgent.state === 'online' ? 'Test the connection' : 'Connect'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMade(null)}>
              Done, I have copied it
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={add} className="space-y-3">
        <div className="space-y-1">
          <p className={SECTION_TITLE}>Add a probe agent</p>
          <p className={HINT}>
            Where this dashboard will find it. Over a tailnet, use the machine&apos;s tailnet address or name, and no port
            has to be opened anywhere.
          </p>
        </div>
        <Input label="Name" placeholder="Germany VPS" value={name} maxLength={60} onChange={event => setName(event.target.value)} />
        <div className="grid items-start gap-4 sm:grid-cols-[1fr_10rem]">
          <Input
            label="Address"
            placeholder="100.84.12.7 or vps.tail1234.ts.net"
            value={address}
            onChange={event => setAddress(event.target.value)}
            error={address.trim() && !typed.ok ? typed.error : undefined}
          />
          <NumberField
            id="probe-agent-port"
            label="Port"
            min={1}
            max={65535}
            value={port}
            onValueChange={setPort}
            formatOptions={{ useGrouping: false }}
          />
        </div>
        {exposure && <ExposureNote exposure={exposure} />}
        <div>
          <Button type="submit" loading={busy} disabled={!name.trim() || !typed.ok}>
            <RadioTower {...ICON} />
            Add probe agent
          </Button>
        </div>
      </form>

      {lastOutcome && lastOutcome.id !== made?.agent.id && <OutcomeAlert outcome={lastOutcome.outcome} name={lastOutcome.name} />}

      {loaded.probeAgents.length === 0 ? (
        <EmptyState
          icon={<RadioTower size={24} strokeWidth={1.75} />}
          title="No probe agents yet"
          description="Every target is probed from the machine this dashboard runs on."
        />
      ) : (
        <SortableDataTable
          caption="Probe agents"
          emptyMessage="No probe agents yet"
          itemName={{ one: 'probe agent', other: 'probe agents' }}
          rows={rows}
          rowKey="id"
          defaultSort={{ key: 'name', direction: 'asc' }}
          columns={[
            {
              key: 'name',
              label: 'Probe agent',
              render: (_, { agent }) => (
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{agent.name}</span>
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {agent.address.includes(':') ? `[${agent.address}]` : agent.address}:{agent.port}
                  </span>
                  {agent.fingerprint && (
                    <span className="font-mono text-[11px] text-muted-foreground" title={agent.fingerprint}>
                      <ShieldCheck size={11} strokeWidth={1.75} aria-hidden className="mr-1 inline" />
                      {shortFingerprint(agent.fingerprint)}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'state',
              label: 'State',
              render: (_, { agent }) => (
                <span className="flex flex-col items-start gap-1">
                  <Badge size="sm" tone={PROBE_AGENT_STATE[agent.state].tone}>{PROBE_AGENT_STATE[agent.state].label}</Badge>
                  {agent.state !== 'online' && agent.lastError && (
                    <span className="max-w-64 text-xs text-muted-foreground">{agent.lastError}</span>
                  )}
                  {agent.state === 'cert-changed' && agent.offeredFingerprint && (
                    <span className="max-w-64 break-all font-mono text-[11px] text-muted-foreground">
                      Now presents {agent.offeredFingerprint}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">Last seen {when(agent.lastSeenAt)}</span>
                </span>
              ),
            },
            {
              key: 'exposure',
              label: 'Reached over',
              render: (_, { agent }) => (
                <span className="flex flex-col items-start gap-1">
                  <Badge size="sm" tone={PROBE_AGENT_EXPOSURE[agent.exposure].tone}>{PROBE_AGENT_EXPOSURE[agent.exposure].label}</Badge>
                  {agent.exposure === 'public' && (
                    <span className="max-w-56 text-xs text-muted-foreground">Firewall its port to this dashboard&apos;s address</span>
                  )}
                </span>
              ),
            },
            {
              key: 'version',
              label: 'Machine',
              render: (_, { agent }) => (
                <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  <span className="text-foreground">{agent.hostname ?? 'Not known yet'}</span>
                  {agent.version && <span>Version {agent.version}</span>}
                  {agent.tools && (!agent.tools.ping || !agent.tools.traceroute) && (
                    <span className="text-warning">
                      No {[!agent.tools.ping && 'ping', !agent.tools.traceroute && 'traceroute'].filter(Boolean).join(' or ')} installed
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'targetCount',
              label: 'Targets',
              numeric: true,
              render: (_, { agent }) =>
                agent.targetCount > 0 && onShowTargets ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => onShowTargets(agent.id)}>
                    {agent.targetCount} {agent.targetCount === 1 ? 'target' : 'targets'}
                  </Button>
                ) : (
                  <span className="text-muted-foreground">{agent.targetCount}</span>
                ),
            },
            {
              key: 'actions',
              label: 'Actions',
              sortable: false,
              // Room for a question once open: the table's layout is fixed, so a cell never widens to fit one.
              width: 288,
              render: (_, { agent }) => (
                <span className="flex flex-col items-start gap-1">
                  {agent.state === 'cert-changed' && agent.offeredFingerprint ? (
                    <ConfirmMorph
                      label="Trust new certificate"
                      icon={<ShieldCheck {...ICON} />}
                      tone="neutral"
                      prompt="Trust it?"
                      confirmLabel="Trust"
                      doneLabel="Trusted"
                      onConfirm={() => connect(agent, true)}
                    />
                  ) : (
                    <Button type="button" size="sm" variant="secondary" loading={connecting === agent.id} onClick={() => connect(agent).catch(() => {})}>
                      <Plug {...ICON} />
                      {agent.fingerprint ? 'Test' : 'Connect'}
                    </Button>
                  )}
                  <ConfirmMorph
                    label="New token"
                    icon={<KeyRound {...ICON} />}
                    tone="neutral"
                    prompt="Replace it?"
                    confirmLabel="Replace"
                    doneLabel="Made"
                    onConfirm={() => renewToken(agent)}
                  />
                  <ConfirmMorph
                    label="Remove"
                    icon={<Trash2 {...ICON} />}
                    prompt="Remove it?"
                    confirmLabel="Remove"
                    doneLabel="Removed"
                    onConfirm={() => remove(agent)}
                  />
                </span>
              ),
            },
          ]}
        />
      )}
    </div>
  )
}
