'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, ChevronRight, CircleCheck, Plug, Plus, RadioTower, RefreshCw, Server, type LucideIcon } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { AnimatedCounter } from '@/components/arc/animated-counter/animated-counter'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { Drawer, DrawerContent, useDrawerItem } from '@/components/arc/drawer/drawer'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { NumberField } from '@/components/arc/number-field/number-field'
import { SearchField } from '@/components/arc/search-field/search-field'
import { SearchResults } from '@/components/search-results'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/arc/tabs/tabs'
import { useToast } from '@/components/notifications'
import { isIpv6 } from '@/lib/probes/host'
import { exposureOfAddress } from '@/lib/probe-agents/exposure'
import { readProbeAgentAddress } from '@/lib/probe-agents/input'
import type { ProbeAgentInstall } from '@/lib/probe-agents/install'
import { PROBE_AGENT_DEFAULT_PORT } from '@/lib/probe-agents/protocol'
import { cn } from '@/lib/utils'
import type { ProbeAgent } from '@/types/probe-agent'
import { CopyField } from './mcp-setup'
import { PROBE_AGENT_EXPOSURE, PROBE_AGENT_STATE } from './probe-agent-labels'
import { DuplicateMonitors } from './duplicate-monitors'
import { LocalProbe } from './local-probe'
import { ProbeHeartbeat } from './probe-heartbeat'
import { ProbePlaces } from './probe-places'
import { AddProbeToMonitors } from './add-probe-to-monitors'
import { addressOf, ago, ExposureNote, HINT, ICON, isOutdated, OutcomeAlert, OutdatedBadge, ProbeAgentDetails, send, uninstallCommands, when, type Outcome } from './probe-agent-details'
import { Masked } from '../privacy/masked'

/**
 * Settings → Probe agents: the other machines targets can be probed from.
 *
 * A probe agent is a small ClearPing program on another machine (a VPS in
 * another country, a box at the office) that takes readings from there and
 * hands them to this dashboard. Nothing to do with AI agents. Adding one makes
 * a token and shows how to start the agent with it; connecting pins the
 * agent's certificate, so from then on this dashboard talks to that agent and
 * nothing else, encrypted, on any network.
 *
 * Laid out as a fleet: this server, a count of how they are doing, then every
 * probe agent in a table, with what can be done to one in its details panel.
 */

const SECTION_TITLE = 'text-sm font-medium text-card-foreground'
const PANEL = 'min-w-0 space-y-4 rounded-2xl border border-border p-4'

interface Loaded {
  probeAgents: ProbeAgent[]
  install: ProbeAgentInstall
  dashboardVersion?: string
}

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

type StatusFilter = 'all' | 'online' | 'attention'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'online', label: 'Online' },
  { value: 'attention', label: 'Needs attention' },
]

/** The clock "ago" is measured against, moved on every half minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])
  return now
}

/** Anything but answering: not connected yet counts, since it takes no readings either. */
function needsAttention(agent: ProbeAgent): boolean {
  return agent.state !== 'online'
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

type TileTone = 'neutral' | 'success' | 'danger'

const TILE: Record<TileTone, { tile: string; icon: string }> = {
  neutral: { tile: 'border-border bg-muted/40', icon: 'bg-muted text-muted-foreground' },
  success: { tile: 'border-success/25 bg-success/10', icon: 'bg-success/15 text-success' },
  danger: { tile: 'border-destructive/25 bg-destructive/10', icon: 'bg-destructive/15 text-destructive' },
}

/** One count in the summary, in the colour of what it counts. */
function Tile({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: number; tone: TileTone }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3 rounded-2xl border p-4', TILE[tone].tile)}>
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-full', TILE[tone].icon)}>
        <Icon size={18} strokeWidth={1.75} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xl font-medium tabular-nums text-foreground">
          <AnimatedCounter value={value} />
        </span>
      </span>
    </div>
  )
}

export function ProbeAgentsTab({ onShowTargets }: { onShowTargets?: (probeAgentId: string) => void }) {
  const { notify, reportError } = useToast()
  const now = useNow()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [port, setPort] = useState(PROBE_AGENT_DEFAULT_PORT)
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const [way, setWay] = useState<Way>('docker')
  const [connecting, setConnecting] = useState<string | null>(null)
  // How the last connection went, shown once, above the list and in its details.
  const [lastOutcome, setLastOutcome] = useState<{ id: string; name: string; outcome: Outcome } | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [detailsId, setDetailsId] = useState<string | null>(null)

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

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  // The panel keeps showing the agent while it slides away.
  const shownDetails = useDrawerItem(loaded?.probeAgents.find(agent => agent.id === detailsId) ?? null)

  const typed = readProbeAgentAddress(address)
  const exposure = typed.ok ? exposureOfAddress(typed.value) : null

  const closeAdding = () => {
    setAdding(false)
    setName('')
    setAddress('')
    setPort(PROBE_AGENT_DEFAULT_PORT)
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/probe-agents', 'POST', { name: name.trim(), address, port })
    setBusy(false)
    if (!ok) return reportError('Could not add the probe agent', body.error)
    setMade({ agent: body.probeAgent as ProbeAgent, token: String(body.token), install: body.install as ProbeAgentInstall, renewed: false })
    closeAdding()
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
    // The token is shown on the page, under the panel.
    setDetailsId(null)
    void load()
  }

  const remove = async (agent: ProbeAgent) => {
    const { ok, body } = await send(`/api/security/probe-agents/${agent.id}`, 'DELETE')
    if (!ok) {
      reportError(`Could not remove ${agent.name}`, body.error)
      throw new Error(String(body.error ?? 'Could not remove it'))
    }
    if (made?.agent.id === agent.id) setMade(null)
    setDetailsId(null)
    void load()
  }

  if (loadError) return <Alert tone="danger" title="Could not load the probe agents">{loadError}</Alert>
  if (!loaded) return <Skeleton label="Loading the probe agents" lines={4} />

  const agents = loaded.probeAgents
  const madeAgent = made ? agents.find(agent => agent.id === made.agent.id) ?? made.agent : null
  const commands = made && madeAgent ? installCommands(madeAgent, made.token, made.install) : null
  const online = agents.filter(agent => agent.state === 'online').length
  const attention = agents.filter(needsAttention).length
  const seen = agents.map(agent => agent.lastSeenAt).filter((at): at is number => !!at)
  const oldestCheck = seen.length > 0 ? Math.min(...seen) : undefined

  const query = search.trim().toLowerCase()
  const shown = agents.filter(agent => {
    if (statusFilter === 'online' && agent.state !== 'online') return false
    if (statusFilter === 'attention' && !needsAttention(agent)) return false
    if (!query) return true
    return [agent.name, agent.address, agent.hostname ?? ''].some(text => text.toLowerCase().includes(query))
  })
  const rows = shown.map(agent => ({ ...agent, agent }))

  return (
    <div className="space-y-5 text-foreground">
      <LocalProbe />
      <ProbeHeartbeat />
      <ProbePlaces />
      <DuplicateMonitors />
      <AddProbeToMonitors />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className={`${HINT} min-w-0 max-w-xl pt-1`}>
          Install a probe agent on another machine, add it here, then tick it under Probes in a monitor&apos;s settings.
          Its readings are then taken from there, beside those of any other probe the monitor has.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" loading={refreshing} onClick={() => void refresh()}>
            <RefreshCw {...ICON} />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            <Plus {...ICON} />
            Add probe agent
          </Button>
        </div>
      </div>

      {/* This server, which every target is probed from unless told otherwise. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border px-4 py-3">
        <span className="text-sm font-medium">This server</span>
        <span className="text-sm text-muted-foreground">Where this dashboard runs</span>
        <Badge size="sm" tone="success" icon={<CircleCheck size={11} strokeWidth={2} aria-hidden />}>
          Always probes
        </Badge>
        {loaded.dashboardVersion && (
          <span className="text-xs text-muted-foreground">
            Version <span className="font-mono">{loaded.dashboardVersion}</span>
          </span>
        )}
        {oldestCheck && (
          <span className="ml-auto text-xs text-muted-foreground" title={when(oldestCheck)}>
            Oldest probe agent check {ago(oldestCheck, now).toLowerCase()}
          </span>
        )}
      </div>

      {made && madeAgent && commands && (
        <div className={cn(PANEL, 'border-success/30')}>
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
                  monitors, run it with <span className="font-mono">--network host</span> in place of{' '}
                  <span className="font-mono">-p</span>, and set{' '}
                  <span className="font-mono">CLEARPING_PROBE_AGENT_LISTEN</span> to the address to listen on.
                </p>
              </div>
            </TabsContent>
            <TabsContent value="compose">
              <div className="space-y-2 text-foreground">
                <CodeBlock code={commands.compose} filename="compose.yaml" language="yaml" />
                <p className={HINT}>
                  Then <span className="font-mono">docker compose up -d</span> beside it. To keep its certificate in a
                  folder such as <span className="font-mono">./data</span> instead of a volume, give the folder to uid
                  1000 first: <span className="font-mono">sudo chown 1000:1000 data</span>.
                </p>
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
                <p className={HINT}>To take it all off the machine again, the same script uninstalls it:</p>
                <CodeBlock code={uninstallCommands(made.install).linux} filename="To uninstall it" language="bash" />
              </div>
            </TabsContent>
          </Tabs>

          {lastOutcome?.id === madeAgent.id && <OutcomeAlert outcome={lastOutcome.outcome} name={madeAgent.name} />}

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

      {lastOutcome && lastOutcome.id !== made?.agent.id && lastOutcome.id !== detailsId && (
        <OutcomeAlert outcome={lastOutcome.outcome} name={lastOutcome.name} />
      )}

      <section className={PANEL} aria-labelledby="probe-agents-summary">
        <p id="probe-agents-summary" className={SECTION_TITLE}>Summary</p>
        <div className="grid gap-3 @2xl/main:grid-cols-3">
          <Tile icon={Server} label="Probe agents" value={agents.length} tone="neutral" />
          <Tile icon={CircleCheck} label="Online" value={online} tone={online > 0 ? 'success' : 'neutral'} />
          <Tile icon={AlertTriangle} label="Needs attention" value={attention} tone={attention > 0 ? 'danger' : 'neutral'} />
        </div>
      </section>

      <section className={PANEL} aria-labelledby="probe-agents-list">
        <div className="space-y-1">
          <p id="probe-agents-list" className={SECTION_TITLE}>All probe agents</p>
          <p className={HINT}>Choose one in a monitor&apos;s settings to take that monitor&apos;s readings from there.</p>
        </div>

        {agents.length === 0 ? (
          <EmptyState
            icon={<RadioTower size={24} strokeWidth={1.75} />}
            title="No probe agents yet"
            description="Every monitor is probed from this server. Add a probe agent to take readings from somewhere else too."
          />
        ) : (
          <>
            <div className="grid items-end gap-3 @2xl/main:grid-cols-[minmax(0,20rem)_12rem]">
              <SearchField label="Search" placeholder="Name, address or machine" value={search} onValueChange={setSearch} />
              <Select
                id="probe-agents-status"
                label="Status"
                value={statusFilter}
                onValueChange={value => setStatusFilter(value as StatusFilter)}
                options={STATUS_FILTERS}
              />
            </div>

            <SearchResults query={`${statusFilter}|${query}`}>
              <SortableDataTable
                caption="Probe agents"
                emptyMessage="No probe agent matches"
                itemName={{ one: 'probe agent', other: 'probe agents' }}
                rows={rows}
                rowKey="id"
                defaultSort={{ key: 'name', direction: 'asc' }}
                columns={[
                  {
                    key: 'name',
                    label: 'Name',
                    render: (_, { agent }) => (
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium wrap-break-word">{agent.name}</span>
                        {agent.hostname && agent.hostname !== agent.name && (
                          <span className="text-xs wrap-break-word text-muted-foreground" title="The name the machine gives itself">
                            on <Masked value={agent.hostname} />
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'address',
                    label: 'IP and port',
                    render: (_, { agent }) => <span className="break-all font-mono text-xs"><Masked value={addressOf(agent)} /></span>,
                  },
                  {
                    key: 'exposure',
                    label: 'Reached over',
                    render: (_, { agent }) => (
                      <Badge size="sm" tone={PROBE_AGENT_EXPOSURE[agent.exposure].tone}>{PROBE_AGENT_EXPOSURE[agent.exposure].label}</Badge>
                    ),
                  },
                  {
                    key: 'version',
                    label: 'Version',
                    render: (_, { agent }) => (
                      <span className="inline-flex items-center gap-2">
                        <span className={cn('font-mono text-xs', agent.version ? 'text-foreground' : 'text-muted-foreground')}>
                          {agent.version ?? '—'}
                        </span>
                        {isOutdated(agent, loaded.dashboardVersion) && <OutdatedBadge />}
                      </span>
                    ),
                  },
                  {
                    key: 'state',
                    label: 'Status',
                    render: (_, { agent }) => (
                      <Badge size="sm" tone={PROBE_AGENT_STATE[agent.state].tone}>{PROBE_AGENT_STATE[agent.state].label}</Badge>
                    ),
                  },
                  {
                    key: 'lastSeenAt',
                    label: 'Last seen',
                    render: (_, { agent }) => (
                      <span className="text-xs text-muted-foreground" title={agent.lastSeenAt ? when(agent.lastSeenAt) : undefined}>
                        {ago(agent.lastSeenAt, now)}
                      </span>
                    ),
                  },
                  {
                    key: 'targetCount',
                    label: 'Monitors',
                    numeric: true,
                    render: (_, { agent }) =>
                      agent.targetCount > 0 && onShowTargets ? (
                        <Button type="button" size="sm" variant="ghost" onClick={() => onShowTargets(agent.id)}>
                          {agent.targetCount}
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">{agent.targetCount}</span>
                      ),
                  },
                  {
                    key: 'actions',
                    label: 'Actions',
                    sortable: false,
                    render: (_, { agent }) => (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDetailsId(agent.id)} aria-label={`Details of ${agent.name}`}>
                        Details
                        <ChevronRight {...ICON} />
                      </Button>
                    ),
                  },
                ]}
              />
            </SearchResults>
          </>
        )}
      </section>

      <Dialog open={adding} onOpenChange={open => { if (!open) closeAdding() }}>
        <DialogContent
          title="Add a probe agent"
          description="The address this dashboard connects to. On a tailnet, use the machine's tailnet address or name, and no ports need opening."
        >
          <form noValidate onSubmit={add} className="space-y-3 text-foreground">
            <Input label="Name" placeholder="Germany VPS" required value={name} maxLength={60} onChange={event => setName(event.target.value)} />
            <div className="grid items-start gap-4 sm:grid-cols-[1fr_8rem]">
              <Input
                label="Address"
                required
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
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={closeAdding}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!name.trim() || !typed.ok}>
                <RadioTower {...ICON} />
                Add probe agent
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Drawer open={detailsId !== null && shownDetails !== null} onOpenChange={open => { if (!open) setDetailsId(null) }}>
        {shownDetails && (
          <DrawerContent title={shownDetails.name} description={addressOf(shownDetails)}>
            <ProbeAgentDetails
              agent={shownDetails}
              install={loaded.install}
              dashboardVersion={loaded.dashboardVersion}
              now={now}
              outcome={lastOutcome?.id === shownDetails.id ? lastOutcome.outcome : null}
              connecting={connecting === shownDetails.id}
              onConnect={trust => connect(shownDetails, trust)}
              onRenewToken={() => renewToken(shownDetails)}
              onRemove={() => remove(shownDetails)}
              onChanged={() => void load()}
              onShowTargets={onShowTargets && (() => onShowTargets(shownDetails.id))}
            />
          </DrawerContent>
        )}
      </Drawer>
    </div>
  )
}
