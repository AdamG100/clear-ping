'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { DnsRecordType, DnsResolver, IpVersion, ProbeConfig, ProbeType, Target, GameQuery } from '@/types/probe'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import { PROBE_AGENT_STATE } from '../settings/probe-agent-labels'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { Input } from '@/components/arc/input/input'
import { RadioCards } from '@/components/arc/radio-cards/radio-cards'
import { SegmentedField } from '@/components/segmented-field'
import { SearchField } from '@/components/arc/search-field/search-field'
import { Select } from '@/components/arc/select/select'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { addressFamilyFor, classifyHost, isDualStack, isWellKnownResolver, targetTypeFor } from '@/lib/probes/host'
import { groupLabel, joinGroupPath } from '@/lib/targets/group-path'
import { describeProbe } from '@/lib/probes/labels'
import {
  dnsQueryNameFor,
  DEFAULT_PING_PACKETS,
  DNS_RECORD_TYPES,
  isAddressRecord,
  isPort,
  MAX_PING_PACKETS,
  nameRecordType,
  parseAddressInput,
  targetAddressLabel,
  GAME_QUERIES,
  GAME_QUERY_INFO,
  validateProbeConfig,
} from '@/lib/probes/config'
import { DualStackBadge, Ipv6Badge, TypeBadge } from './target-badges'
import { ResolverList } from './resolver-list'
import { Gamepad2, Globe, MapPin, Network, Pause, Plug, Server, Trash2, Wifi } from 'lucide-react'

/**
 * The add and edit forms, which are the same form, and asking before a
 * target is deleted.
 *
 * They used to be two hand-kept copies of every field, so each new probe
 * setting had to be added, and kept in step, twice.
 */

// ─── Form state ─────────────────────────────────────────────────────────────

/**
 * Probe settings as they sit in the inputs: text, including half-typed text
 * that is not yet a valid number. Turned into a `ProbeConfig` only to be
 * checked and saved.
 */
interface ConfigDraft {
  packets: string
  port: string
  gameQuery: GameQuery
  scheme: 'http' | 'https'
  path: string
  expectedStatus: string
  keyword: string
  queryName: string
  recordType: DnsRecordType
  expectedAnswer: string
  /** Empty for the system resolver alone. A row may be half typed, like any other field. */
  resolvers: DnsResolver[]
}

function draftFrom(config: ProbeConfig = {}): ConfigDraft {
  return {
    packets: config.packets ? String(config.packets) : '',
    port: config.port ? String(config.port) : '',
    gameQuery: config.gameQuery ?? 'source',
    scheme: config.scheme ?? 'https',
    path: config.path ?? '/',
    expectedStatus: config.expectedStatus ? String(config.expectedStatus) : '',
    keyword: config.keyword ?? '',
    queryName: config.queryName ?? '',
    recordType: config.recordType ?? 'A',
    expectedAnswer: config.expectedAnswer ?? '',
    resolvers: config.resolvers ?? [],
  }
}

/** Blank means "not set"; anything else must survive as typed so it can be rejected. */
function numberOrUndefined(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text)
}

function configFrom(draft: ConfigDraft): Record<string, unknown> {
  return {
    packets: numberOrUndefined(draft.packets),
    port: numberOrUndefined(draft.port),
    gameQuery: draft.gameQuery,
    scheme: draft.scheme,
    path: draft.path,
    expectedStatus: numberOrUndefined(draft.expectedStatus),
    keyword: draft.keyword,
    queryName: draft.queryName,
    recordType: draft.recordType,
    expectedAnswer: draft.expectedAnswer,
    resolvers: draft.resolvers,
  }
}

export interface TargetFormValues {
  name: string
  host: string
  probeType: ProbeType
  ipVersion: IpVersion
  probeConfig: ProbeConfig
  interval: number
  /** Empty for no group. */
  group: string
  /** The probe agent it is probed from, or null for this server. */
  probeAgentId: string | null
}

/** Stands for "this server" in the list of places to probe from. */
const THIS_SERVER = 'local'

// ─── Probe method ───────────────────────────────────────────────────────────

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

/**
 * Each method with the question it answers. The names alone only help someone
 * who already knows what ICMP is; the question is what a person actually came
 * with, and all of them are on show at once so they can be told apart.
 */
const PROBE_METHODS: { value: ProbeType; label: string; question: string; icon: typeof Wifi }[] = [
  { value: 'ping', label: 'Ping', question: 'ICMP. Is it up, and how fast does it reply?', icon: Wifi },
  { value: 'tcp', label: 'TCP port', question: 'Is a service accepting connections?', icon: Plug },
  { value: 'game', label: 'Game server', question: 'Is a game server up, and how fast does it answer?', icon: Gamepad2 },
  { value: 'http', label: 'Web page', question: 'HTTP. Does a page load as expected?', icon: Globe },
  { value: 'dns', label: 'DNS lookup', question: 'Is DNS answering correctly?', icon: Network },
]

/**
 * How the target is measured. Out in the open rather than under Advanced: it
 * decides what every number on the target's page means.
 */
function ProbeMethodPicker({
  value,
  suggested,
  onChange,
}: {
  value: ProbeType
  /** The method the address itself asked for, marked so the jump to it is explained. */
  suggested: ProbeType | null
  onChange: (probeType: ProbeType) => void
}) {
  return (
    <RadioCards
      aria-label="How to check it"
      value={value}
      onValueChange={next => onChange(next as ProbeType)}
      minColumnWidth={180}
      options={PROBE_METHODS.map(method => ({
        value: method.value,
        label: method.label,
        description: method.question,
        icon: <method.icon {...ICON} />,
        meta: value === method.value && suggested === method.value ? <Badge size="sm" tone="info">Detected</Badge> : undefined,
      }))}
    />
  )
}

/** Past this many probe agents, a search narrows the cards down and they scroll. */
const PROBE_FROM_SEARCH_AFTER = 5

/**
 * Where the target is probed from: this server or a probe agent, as cards side
 * by side that wrap onto more rows. With many probe agents a search narrows
 * them, and the list scrolls inside a set height so the form below stays in
 * reach. This server and the chosen one are always shown, whatever is typed.
 */
function ProbeFromPicker({
  idPrefix,
  probeAgents,
  value,
  onChange,
}: {
  idPrefix: string
  probeAgents: ProbeAgentSummary[]
  value: string | null
  onChange: (probeAgentId: string | null) => void
}) {
  const [search, setSearch] = useState('')
  const many = probeAgents.length > PROBE_FROM_SEARCH_AFTER
  const query = search.trim().toLowerCase()
  const shown = probeAgents.filter(agent =>
    !query || agent.id === value || [agent.name, agent.address, agent.hostname ?? ''].some(text => text.toLowerCase().includes(query))
  )
  const labelId = `${idPrefix}-probe-from-label`

  return (
    <div className="space-y-3">
      <p id={labelId} className="sr-only">Where should it be probed from?</p>
      {many && (
        <SearchField
          label="Find a probe agent"
          placeholder={`Search ${probeAgents.length} probe agents`}
          value={search}
          onValueChange={setSearch}
        />
      )}
      <div className={cn(many && 'max-h-80 overflow-y-auto p-0.5')}>
        <RadioCards
          aria-labelledby={labelId}
          name={`${idPrefix}-probe-from`}
          value={value ?? THIS_SERVER}
          onValueChange={next => onChange(next === THIS_SERVER ? null : next)}
          minColumnWidth={200}
          options={[
            { value: THIS_SERVER, label: 'This server', description: 'Where this dashboard runs', icon: <Server {...ICON} /> },
            ...shown.map(agent => ({
              value: agent.id,
              // Wrapped rather than cut short: the name is how the card is told apart.
              label: <span className="block whitespace-normal wrap-break-word">{agent.name}</span>,
              description: <span className="break-all">{agent.hostname ?? agent.address}</span>,
              icon: <MapPin {...ICON} />,
              meta: agent.state === 'online'
                ? undefined
                : <Badge size="sm" tone={PROBE_AGENT_STATE[agent.state].tone}>{PROBE_AGENT_STATE[agent.state].label}</Badge>,
            })),
          ]}
        />
      </div>
      {query && shown.length === 0 && <FieldHint>No probe agent matches &ldquo;{search.trim()}&rdquo;.</FieldHint>}
    </div>
  )
}

/** What the current address, probe and settings add up to, in a sentence. */
function ProbeSummary({
  host,
  probeType,
  ipVersion,
  summary,
}: {
  host: string
  probeType: ProbeType
  ipVersion: IpVersion
  summary: string
}) {
  return (
    <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1">
        <TypeBadge type={targetTypeFor(host, probeType)} />
        {isDualStack(host, ipVersion)
          ? <DualStackBadge />
          : addressFamilyFor(host, ipVersion) === 6 && <Ipv6Badge />}
      </span>
      <span className="min-w-0 break-words">{summary}</span>
    </div>
  )
}

/** What a field is for or what it accepts, said under a group of fields. */
function FieldHint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}

// ─── Probe-specific settings ────────────────────────────────────────────────

/** A name's address record, A or AAAA as its IP version has it, as one item of a list. */
const ADDRESS_RECORD = 'address'

/**
 * The settings only the chosen probe has: the fields that appear are the ones
 * that mean something for it.
 */
function ProbeConfigFields({
  idPrefix,
  probeType,
  host,
  ipVersion,
  draft,
  portError,
  onChange,
  onPortBlur,
}: {
  idPrefix: string
  probeType: ProbeType
  host: string
  /** Which of a name's two kinds of address a DNS lookup asks for. */
  ipVersion: IpVersion
  draft: ConfigDraft
  /** Set when a TCP or UDP target's port is missing or wrong and it is time to say so. */
  portError?: string
  onChange: (changes: Partial<ConfigDraft>) => void
  onPortBlur: () => void
}) {
  if (probeType === 'ping') {
    return (
      <div className="space-y-2">
        <div className="max-w-48">
          <Input
            id={`${idPrefix}-packets`}
            label="Packets per probe"
            inputMode="numeric"
            placeholder={String(DEFAULT_PING_PACKETS)}
            value={draft.packets}
            onChange={e => onChange({ packets: e.target.value })}
          />
        </div>
        <FieldHint>
          Loss is counted in whole packets, so this is how finely it is read: {DEFAULT_PING_PACKETS} gives steps of 5%,
          50 gives 2% and {MAX_PING_PACKETS} gives 1%. More packets take longer, up to a second for each one a failing
          path never answers.
        </FieldHint>
      </div>
    )
  }

  if (probeType === 'tcp') {
    return (
      <div className="max-w-48">
        <Input
          id={`${idPrefix}-port`}
          label="Port"
          inputMode="numeric"
          placeholder="e.g., 443, 22, 5432"
          value={draft.port}
          onChange={e => onChange({ port: e.target.value })}
          onBlur={onPortBlur}
          required
          error={portError}
        />
      </div>
    )
  }

  if (probeType === 'game') {
    const query = GAME_QUERY_INFO[draft.gameQuery]
    return (
      <div className="space-y-4">
        <div className="grid items-start gap-3 sm:grid-cols-[1fr_9rem]">
          <Select
            id={`${idPrefix}-game-query`}
            label="Game"
            value={draft.gameQuery}
            onValueChange={value => onChange({ gameQuery: value as GameQuery })}
            options={GAME_QUERIES.map(value => ({ value, label: GAME_QUERY_INFO[value].label }))}
          />
          <Input
            id={`${idPrefix}-port`}
            label="Port"
            inputMode="numeric"
            placeholder={query.port}
            value={draft.port}
            onChange={e => onChange({ port: e.target.value })}
            onBlur={onPortBlur}
            required
            error={portError}
          />
        </div>
        <FieldHint>
          {query.answers}
          {query.queryPort &&
            ' Use the query port, which for some games is not the one players join on: Rust, ARK and Valheim each have one of their own.'}
        </FieldHint>
        {/* The question most people bring here, answered before they find out the hard way. */}
        {draft.gameQuery !== 'unreachable' && (
          <FieldHint>
            Call of Duty, Valorant, League of Legends? Their servers answer no query: pick {GAME_QUERY_INFO.unreachable.label}.
          </FieldHint>
        )}
      </div>
    )
  }

  if (probeType === 'http') {
    return (
      <div className="space-y-4">
        <SegmentedField
          label="Scheme"
          value={draft.scheme}
          onValueChange={value => onChange({ scheme: value as 'http' | 'https' })}
          options={[
            { value: 'https', label: 'HTTPS' },
            { value: 'http', label: 'HTTP' },
          ]}
        />
        <div className="grid items-start gap-3 sm:grid-cols-[7rem_1fr]">
          <Input
            id={`${idPrefix}-http-port`}
            label="Port"
            inputMode="numeric"
            placeholder={draft.scheme === 'https' ? '443' : '80'}
            value={draft.port}
            onChange={e => onChange({ port: e.target.value })}
          />
          <Input
            id={`${idPrefix}-path`}
            label="Path"
            placeholder="/"
            value={draft.path}
            onChange={e => onChange({ path: e.target.value })}
            style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
          />
        </div>
        <div className="grid items-start gap-3 sm:grid-cols-[9rem_1fr]">
          <Input
            id={`${idPrefix}-status`}
            label="Expect status (optional)"
            inputMode="numeric"
            placeholder="2xx / 3xx"
            value={draft.expectedStatus}
            onChange={e => onChange({ expectedStatus: e.target.value })}
          />
          <Input
            id={`${idPrefix}-keyword`}
            label="Page must contain (optional)"
            placeholder="e.g., Sign in"
            value={draft.keyword}
            onChange={e => onChange({ keyword: e.target.value })}
          />
        </div>
      </div>
    )
  }

  // DNS. A server can be asked anything. A name is itself the question, so
  // what is left to say about it is who to ask, and what the answer ought to be.
  const isServer = classifyHost(host) !== 'hostname'
  // Resolvers of its own choosing are asked directly, and so can be asked for
  // any kind of record; the system resolver only ever hands back addresses.
  const choosesRecord = !isServer && draft.resolvers.length > 0

  const expectedAnswer = (
    <Input
      id={`${idPrefix}-answer`}
      label={`${isServer ? 'Answer must include' : choosesRecord ? 'Every answer must include' : 'Must resolve to'} (optional)`}
      placeholder={isServer || choosesRecord ? 'e.g., 203.0.113.10 or mx.example.com' : 'e.g., 203.0.113.10'}
      value={draft.expectedAnswer}
      onChange={e => onChange({ expectedAnswer: e.target.value })}
    />
  )

  const recordType = (
    <Select
      id={`${idPrefix}-record`}
      label="Record"
      value={draft.recordType}
      onValueChange={value => onChange({ recordType: value as DnsRecordType })}
      options={DNS_RECORD_TYPES.map(type => ({ value: type, label: type }))}
    />
  )

  if (!isServer) {
    // A name has an address of each kind, and which is asked for is the IP
    // version's to say, as it is for every other probe. So the two are one
    // choice here, reading as whatever the IP version makes of it.
    const asksForAddress = isAddressRecord(draft.recordType)
    const addressRecord = nameRecordType(draft.recordType, ipVersion)
    const nameRecord = (
      <Select
        id={`${idPrefix}-record`}
        label="Record"
        value={asksForAddress ? ADDRESS_RECORD : draft.recordType}
        onValueChange={value => {
          if (value !== ADDRESS_RECORD) onChange({ recordType: value as DnsRecordType })
          else if (!asksForAddress) onChange({ recordType: 'A' })
        }}
        options={[
          {
            value: ADDRESS_RECORD,
            label: ipVersion === 'both' ? 'A + AAAA' : asksForAddress ? addressRecord : nameRecordType(undefined, ipVersion),
          },
          ...DNS_RECORD_TYPES.filter(type => !isAddressRecord(type)).map(type => ({ value: type, label: type })),
        ]}
      />
    )

    return (
      <div className="space-y-4">
        <ResolverList idPrefix={idPrefix} resolvers={draft.resolvers} onChange={resolvers => onChange({ resolvers })} />
        {choosesRecord ? (
          <>
            <div className="grid items-start gap-3 sm:grid-cols-[9rem_1fr]">
              {nameRecord}
              {expectedAnswer}
            </div>
            {asksForAddress && (
              <FieldHint>
                {ipVersion === 'both'
                  ? 'A is asked for and charted as the IPv4 line, AAAA as the IPv6 line. IP version, below, is what chooses between them.'
                  : `Asks for the ${addressRecord} record. IP version, below, chooses between A and AAAA, or asks for both.`}
              </FieldHint>
            )}
          </>
        ) : (
          expectedAnswer
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-3 sm:grid-cols-[1fr_8rem]">
        <Input
          id={`${idPrefix}-query`}
          label="Name to look up"
          placeholder={dnsQueryNameFor(host)}
          value={draft.queryName}
          onChange={e => onChange({ queryName: e.target.value })}
        />
        {recordType}
      </div>
      {expectedAnswer}
    </div>
  )
}

// ─── Shared fields ──────────────────────────────────────────────────────────

const NEW_GROUP = '__custom__'
/** The select cannot hold an empty value, so "no group" needs a name. */
const NO_GROUP = '__none__'

/**
 * Which group the target sits in. A list rather than a row of buttons: with a
 * dozen nested groups the buttons wrapped into a block taller than the rest of
 * the form.
 */
function GroupSelect({
  id,
  group,
  availableGroups,
  onChange,
}: {
  id: string
  group: string
  availableGroups: string[]
  onChange: (group: string) => void
}) {
  return (
    <Select
      id={id}
      label="Group"
      value={group || NO_GROUP}
      onValueChange={value => onChange(value === NO_GROUP ? '' : value)}
      options={[
        { value: NO_GROUP, label: 'No group' },
        ...availableGroups.map(name => ({ value: name, label: groupLabel(name) })),
        { value: NEW_GROUP, label: 'New group…' },
      ]}
    />
  )
}

const IP_VERSION_CHOICES: { value: IpVersion; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automatic', hint: 'Uses whichever address the system prefers, as a browser would.' },
  { value: 'ipv4', label: 'IPv4 only', hint: 'Always probed over IPv4, even where IPv6 is available.' },
  { value: 'ipv6', label: 'IPv6 only', hint: 'Always probed over IPv6. Fails if the name has no IPv6 address.' },
  { value: 'both', label: 'Both', hint: 'Probed over IPv4 and over IPv6 every time, and charted as two lines.' },
]

/**
 * Which address family a target is probed over. The same for every kind of
 * probe, and offered only while there is a choice to make: an IP address
 * belongs to one family already, so for one the control is not there at all.
 */
function IpVersionPicker({
  value,
  onChange,
}: {
  value: IpVersion
  onChange: (ipVersion: IpVersion) => void
}) {
  const selected = IP_VERSION_CHOICES.find(option => option.value === value) ?? IP_VERSION_CHOICES[0]

  return (
    <div className="space-y-2">
      <SegmentedField
        label="IP version"
        value={value}
        onValueChange={next => onChange(next as IpVersion)}
        options={IP_VERSION_CHOICES.map(option => ({ value: option.value, label: option.label }))}
      />
      <FieldHint>{selected.hint}</FieldHint>
    </div>
  )
}

/** `every` is how the interval reads in the sentence at the foot of the form. */
const INTERVALS = [
  { seconds: 30, label: '30 seconds', every: 'every 30 seconds' },
  { seconds: 60, label: '1 minute', every: 'every minute' },
  { seconds: 120, label: '2 minutes', every: 'every 2 minutes' },
  { seconds: 300, label: '5 minutes', every: 'every 5 minutes' },
  { seconds: 600, label: '10 minutes', every: 'every 10 minutes' },
  { seconds: 1800, label: '30 minutes', every: 'every 30 minutes' },
  { seconds: 3600, label: '1 hour', every: 'every hour' },
]

const RECAP_VERB: Record<ProbeType, string> = {
  ping: 'Pings',
  tcp: 'Connects to',
  game: 'Queries',
  http: 'Requests',
  dns: 'Looks up',
}

/** The whole target in a line, beside the button that creates it. */
function recapFor(host: string, probeType: ProbeType, config: ProbeConfig, interval: number): string {
  const every = INTERVALS.find(option => option.seconds === interval)?.every ?? `every ${interval} seconds`
  // A DNS probe of a server asks it a question; of a name, it is the question.
  const verb = probeType === 'dns' && classifyHost(host) !== 'hostname' ? 'Queries' : RECAP_VERB[probeType]
  return `${verb} ${targetAddressLabel({ host, probeType, probeConfig: config })} ${every}`
}

function IntervalSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: number
  onChange: (seconds: number) => void
}) {
  return (
    <Select
      id={id}
      label="Probe every"
      value={value.toString()}
      onValueChange={v => onChange(parseInt(v))}
      options={INTERVALS.map(option => ({ value: option.seconds.toString(), label: option.label }))}
    />
  )
}

// ─── The form ───────────────────────────────────────────────────────────────

export interface TargetFormProps {
  idPrefix: string
  initial: TargetFormValues
  availableGroups: string[]
  submitLabel: string
  onSubmit: (values: TargetFormValues) => void
  onCancel: () => void
  /** The other machines it could be probed from. None, and the question is not asked. */
  probeAgents?: ProbeAgentSummary[]
}

type RequiredField = 'address' | 'port'

/**
 * One question of the form, in a panel tinted with a colour of its own so each
 * is told apart at a glance (never amber, which reads as a warning): its
 * number, what it is and a line about it on the left, its fields on the
 * right, stacked where the page is narrow.
 * Probe from is purple, the colour of the Remote badge in the sidebar.
 */
function FormSection({ number, tone, title, hint, children }: {
  number: number
  tone: 'neutral' | 'series-1' | 'series-2' | 'series-4'
  title: string
  hint: string
  children: ReactNode
}) {
  const colour = tone === 'neutral' ? 'var(--text-secondary)' : `var(--${tone})`
  return (
    <section
      className="grid gap-4 rounded-2xl border p-4 @2xl/main:p-5 @4xl/main:grid-cols-[15rem_minmax(0,1fr)] @4xl/main:gap-10"
      style={{
        background: `color-mix(in oklab, ${colour} 5%, var(--surface))`,
        borderColor: `color-mix(in oklab, ${colour} 22%, var(--border))`,
      }}
    >
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span
            className="grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-medium tabular-nums"
            style={{ color: colour, background: `color-mix(in oklab, ${colour} 16%, var(--surface))` }}
          >
            {number}
          </span>
          {title}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <div className="min-w-0 max-w-5xl space-y-4">{children}</div>
    </section>
  )
}

/**
 * The form reads top to bottom as the questions someone adding a target has,
 * in the order they have them: what, how, from where, and then the name and
 * schedule, which already hold a sensible answer. Only the first has to be
 * answered, so an address and Enter is a whole target.
 */
export function TargetForm({ idPrefix, initial, availableGroups, submitLabel, onSubmit, onCancel, probeAgents = [] }: TargetFormProps) {
  const initialGroupIsNew = !!initial.group && !availableGroups.includes(initial.group)
  const [probeAgentId, setProbeAgentId] = useState<string | null>(initial.probeAgentId)
  const placeName = (id: string | null) => (id ? probeAgents.find(agent => agent.id === id)?.name ?? 'a removed probe agent' : 'this server')

  const [name, setName] = useState(initial.name)
  const [address, setAddress] = useState(initial.host)
  const [probeType, setProbeType] = useState<ProbeType>(initial.probeType)
  // Once the method has been picked by hand, typing more of the address must
  // not quietly switch it back. An existing target's method was picked.
  const [probeChosen, setProbeChosen] = useState(initial.host !== '')
  // The method the address asked for by being a URL, a host:port or a
  // well-known resolver, so the card it jumped to can say why.
  const [suggested, setSuggested] = useState<ProbeType | null>(null)
  // Set once the part of the address that asked for a method has been moved
  // out of the box. After that the box holds a bare host, which must not be
  // read as a request to go back to ping.
  const [settled, setSettled] = useState(false)
  const [ipVersion, setIpVersion] = useState<IpVersion>(initial.ipVersion)
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFrom(initial.probeConfig))
  const [interval, setInterval] = useState(initial.interval)
  const [group, setGroup] = useState(initialGroupIsNew ? NEW_GROUP : initial.group)
  // A new group is a name and the group it goes inside, picked from a list.
  const [customGroup, setCustomGroup] = useState(initialGroupIsNew ? initial.group : '')
  const [customParent, setCustomParent] = useState('')
  const newGroupPath = joinGroupPath(customParent, customGroup)
  // A required field is only called out once it has been left, or once the
  // form has been submitted: flagging an empty box before anyone has had the
  // chance to type in it is nagging, not help.
  const [touched, setTouched] = useState<Record<RequiredField, boolean>>({ address: false, port: false })
  const [attempted, setAttempted] = useState(false)

  // The address box takes whatever is pasted into it: a bare host, a URL, or
  // host:port. The host is what gets stored; anything else it carried is
  // copied into the settings fields below as it is typed.
  const parsed = parseAddressInput(address)
  const host = parsed.host
  const hostKind = classifyHost(host)
  const isDomain = hostKind === 'hostname'

  const handleAddressChange = (value: string) => {
    setAddress(value)

    const next = parseAddressInput(value)
    const carried: Partial<ConfigDraft> = {}
    if (next.config.port !== undefined) carried.port = String(next.config.port)
    if (next.config.scheme) carried.scheme = next.config.scheme
    if (next.config.path) carried.path = next.config.path
    if (Object.keys(carried).length > 0) setDraft(current => ({ ...current, ...carried }))

    if (probeChosen) return

    const implied = next.probeType ?? (isWellKnownResolver(next.host) ? 'dns' : null)
    if (implied) {
      setProbeType(implied)
      setSuggested(implied)
    } else if (!settled || value.trim() === '') {
      // An emptied box is a fresh start, whatever was pasted into it before.
      setProbeType('ping')
      setSuggested(null)
      setSettled(false)
    }
  }

  const touch = (field: RequiredField) => setTouched(current => ({ ...current, [field]: true }))

  // Leaving the box reduces it to the host. From then on the port and path
  // live only in their own fields, so there is never a second copy in the
  // address to disagree with them.
  const handleAddressBlur = () => {
    if (address.trim() !== host) setAddress(host)
    if (!probeChosen && parsed.probeType) setSettled(true)
    touch('address')
  }

  const validation = validateProbeConfig(probeType, host, configFrom(draft))
  const hostValid = hostKind !== 'invalid'
  // Half-typed settings describe nothing, except which game query was picked:
  // the sentence under the form should not fall back to another one.
  const config: ProbeConfig = validation.ok ? validation.config : probeType === 'game' ? { gameQuery: draft.gameQuery } : {}
  // A record that is not an address has no IP version to be asked for over:
  // set to both, the same question would be put twice and charted as two lines.
  const asksNoAddress = probeType === 'dns' && draft.resolvers.length > 0 && !isAddressRecord(draft.recordType)
  const hasIpVersion = isDomain && !asksNoAddress
  const effectiveIpVersion = hasIpVersion ? ipVersion : 'auto'

  // What each required field still needs, if anything.
  const needsPort = probeType === 'tcp' || probeType === 'game'
  const problems: Record<RequiredField, string | null> = {
    address: !host ? 'Enter a hostname, an IP address or a URL.' : !hostValid ? 'Not a valid hostname, IPv4 address or IPv6 address.' : null,
    port: !needsPort || isPort(numberOrUndefined(draft.port))
      ? null
      : draft.port.trim() === '' ? `Enter the port to ${probeType === 'game' ? 'query' : 'connect to'}.` : 'The port must be between 1 and 65535.',
  }
  const shown = (field: RequiredField) => (attempted || touched[field] ? problems[field] : null)

  const missing = [
    problems.address && (host ? 'a valid address' : 'an address'),
    problems.port && 'a port',
  ].filter((item): item is string => !!item)

  const isValid = missing.length === 0 && validation.ok

  const handleSubmit = () => {
    if (!isValid || !validation.ok) {
      // Say what is wrong and go to it, instead of a button that does nothing.
      setAttempted(true)
      const first = (['address', 'port'] as const).find(field => problems[field])
      if (first) document.getElementById(`${idPrefix}-${first}`)?.focus()
      return
    }

    onSubmit({
      // A target nobody named is called by its address, which is what the
      // name box shows it will be.
      name: name.trim() || host,
      host,
      probeType,
      // Only a domain has a choice of family; a literal already fixes its own.
      ipVersion: effectiveIpVersion,
      probeConfig: validation.config,
      interval,
      group: group === NEW_GROUP ? newGroupPath : group,
      probeAgentId,
    })
  }

  const addressError = shown('address')
  // Nothing to describe until the address is something that can be probed.
  // What is wrong with it is said under the address field.
  const summary = host ? describeProbe(host, probeType, effectiveIpVersion, config) : ''
  // A setting that is filled in but wrong. Shown only once the address is
  // fine, and never for the port, which reports under its own field: two
  // messages for one mistake is one too many.
  const settingsError = hostValid && host && !validation.ok && !problems.port ? validation.error : null
  const recap = isValid && validation.ok ? recapFor(host, probeType, config, interval) : null

  // "New group…" picked: typing goes to the new group's name next. Once the
  // list has closed, which hands focus back to itself first.
  useEffect(() => {
    if (group !== NEW_GROUP) return
    const frame = requestAnimationFrame(() => document.getElementById(`${idPrefix}-new-group`)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [group, idPrefix])

  const addressField = (
    <Input
      id={`${idPrefix}-address`}
      label="Address"
      placeholder="example.com"
      value={address}
      onChange={e => handleAddressChange(e.target.value)}
      onBlur={handleAddressBlur}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      required
      error={addressError ?? undefined}
      style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
      autoFocus={initial.host === ''}
    />
  )

  const methodSection = (
    <fieldset className="space-y-3">
      <legend className="sr-only">How should it be checked?</legend>
      <ProbeMethodPicker
        value={probeType}
        suggested={suggested}
        onChange={value => { setProbeType(value); setProbeChosen(true); setSuggested(null) }}
      />
      {/* Every method has a setting of its own, ping its packet count. */}
      <div className="space-y-4 rounded-2xl border border-border bg-background p-4">
        <ProbeConfigFields
          idPrefix={idPrefix}
          probeType={probeType}
          host={host}
          ipVersion={isDomain ? ipVersion : 'auto'}
          draft={draft}
          portError={shown('port') ?? undefined}
          onChange={changes => setDraft(current => ({ ...current, ...changes }))}
          onPortBlur={() => touch('port')}
        />
        {settingsError && <Alert tone="danger" title="A setting is not right">{settingsError}</Alert>}
        {summary && (
          <div className="border-t border-border pt-3">
            <ProbeSummary host={host} probeType={probeType} ipVersion={effectiveIpVersion} summary={summary} />
          </div>
        )}
      </div>
    </fieldset>
  )

  return (
    <form noValidate onSubmit={event => { event.preventDefault(); handleSubmit() }}>
      {/* The questions in the order they come up, each a numbered panel of
          its own colour: what, what to call it, how, and from where. Nothing
          to step through, so an address and Enter is a target. */}
      <div className="space-y-4">
        <FormSection
          number={1}
          tone="neutral"
          title="Target"
          hint="A hostname, an IP address, host:port or a whole URL. A port or path moves into the check's settings."
        >
          {addressField}
        </FormSection>

        <FormSection number={2} tone="series-4" title="Name" hint="Optional. Left blank, the name is the address.">
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Input
              id={`${idPrefix}-name`}
              label="Name"
              placeholder={host && hostValid ? host : 'e.g. Office router'}
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <GroupSelect
              id={`${idPrefix}-group`}
              group={group}
              availableGroups={availableGroups}
              onChange={next => { setGroup(next); if (next !== NEW_GROUP) { setCustomGroup(''); setCustomParent('') } }}
            />
            {group === NEW_GROUP && (
              <div className="grid items-start gap-4 rounded-2xl border border-border bg-background p-4 sm:col-span-2 sm:grid-cols-2">
                <Input
                  id={`${idPrefix}-new-group`}
                  label="New group's name"
                  required
                  placeholder="e.g. Network"
                  value={customGroup}
                  onChange={e => setCustomGroup(e.target.value)}
                />
                <Select
                  id={`${idPrefix}-new-group-parent`}
                  label="Inside"
                  value={customParent || NO_GROUP}
                  onValueChange={value => setCustomParent(value === NO_GROUP ? '' : value)}
                  options={[
                    { value: NO_GROUP, label: 'Nothing (top level)' },
                    ...availableGroups.map(each => ({ value: each, label: groupLabel(each) })),
                  ]}
                />
                <div className="sm:col-span-2">
                  <FieldHint>
                    {newGroupPath
                      ? <>The target goes in <span className="font-medium text-foreground">{groupLabel(newGroupPath)}</span>, which is made along with it.</>
                      : 'Name the group and it is made along with the target.'}
                  </FieldHint>
                </div>
              </div>
            )}
          </div>
        </FormSection>

        <FormSection number={3} tone="series-1" title="Check" hint="Picked from the address where it can tell, and how often it runs.">
          {methodSection}
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <IntervalSelect id={`${idPrefix}-interval`} value={interval} onChange={setInterval} />
          </div>
          {hostKind !== 'ipv4' && hostKind !== 'ipv6' && !asksNoAddress && <IpVersionPicker value={ipVersion} onChange={setIpVersion} />}
        </FormSection>

        {/* From where: asked only once there is somewhere besides here. */}
        {probeAgents.length > 0 && (
          <FormSection number={4} tone="series-2" title="Probe from" hint="Readings show the network as seen from the chosen machine.">
            <ProbeFromPicker idPrefix={idPrefix} probeAgents={probeAgents} value={probeAgentId} onChange={setProbeAgentId} />
            {initial.host !== '' && probeAgentId !== initial.probeAgentId && (
              <FieldHint>
                Readings before this change were taken from {placeName(initial.probeAgentId)}, and stay in its history.
                From now on they come from {placeName(probeAgentId)}.
              </FieldHint>
            )}
          </FormSection>
        )}
      </div>

      {/* Held at the foot of the page as it scrolls, so the button is on show
          however long the settings above it get. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 mt-6 flex flex-col gap-3 rounded-b-3xl border-t border-border bg-card px-4 py-4 @2xl/main:-mx-6 @2xl/main:-mb-6 @2xl/main:px-6 @5xl/main:flex-row @5xl/main:items-center @5xl/main:justify-between">
        {/* What pressing the button will do, or what is stopping it. */}
        <p
          className={cn('min-w-0 text-xs', attempted && !isValid ? 'text-destructive' : 'text-muted-foreground')}
          role={attempted && !isValid ? 'alert' : undefined}
        >
          {missing.length > 0 ? (
            `Still needed: ${missing.join(', ')}.`
          ) : !validation.ok ? (
            validation.error
          ) : (
            recap && (
              <Tooltip content={recap}>
                <span className="block truncate">{recap}</span>
              </Tooltip>
            )
          )}
        </p>
        {/* Halves of the bar while it is narrow, their own width beside the recap once it is wide. */}
        <div className="flex shrink-0 gap-2 *:flex-1 @5xl/main:*:flex-none">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          {/* Left enabled while something is missing: pressing it says what,
              where a greyed-out button only says no. */}
          <Button type="submit" aria-disabled={!isValid}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}

// ─── Starting values ────────────────────────────────────────────────────────

export const BLANK_TARGET: TargetFormValues = {
  name: '',
  host: '',
  probeType: 'ping',
  ipVersion: 'auto',
  probeConfig: {},
  interval: 300,
  group: '',
  probeAgentId: null,
}

/** A target as the form holds it. */
export function formValuesOf(target: Target): TargetFormValues {
  return {
    name: target.name,
    host: target.host,
    probeType: target.probeType,
    ipVersion: target.ipVersion ?? 'auto',
    probeConfig: target.probeConfig ?? {},
    interval: target.interval,
    group: target.group || '',
    probeAgentId: target.probeAgentId ?? null,
  }
}

// ─── Delete Target Dialog ───────────────────────────────────────────────────

interface DeleteTargetDialogProps {
  /** The target about to be deleted; the dialog is open while this is set. */
  target: Target | null
  onCancel: () => void
  onConfirm: (id: string) => void
  /** Offered as the way out for someone who only wanted the probing to stop. */
  onPause: (target: Target) => void
}

/**
 * Asked before a target is deleted.
 *
 * The delete button sits one icon along from edit and pause on a row a few
 * pixels tall, and what it removes cannot be brought back: the target's whole
 * measurement history goes with it.
 */
export function DeleteTargetDialog({ target, onCancel, onConfirm, onPause }: DeleteTargetDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent title="Delete this target?" description="It cannot be undone.">
        {target && (
          <div className="space-y-4 text-foreground">
            {/* Which one, plainly: the name, what it is and where it is. */}
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-background p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{target.name}</span>
                  <span className="shrink-0"><TypeBadge type={target.type ?? targetTypeFor(target.host, target.probeType)} /></span>
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {targetAddressLabel(target)}
                  {target.group ? <span className="font-sans"> · in {groupLabel(target.group)}</span> : null}
                </p>
              </div>
            </div>

            <Alert tone="danger" title="Everything recorded for it goes too">
              Its measurement history, its alert rules and its saved routes, and its group if that is left empty.
            </Alert>

            {target.status !== 'paused' && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <p className="text-sm text-muted-foreground">Only want the probing to stop?</p>
                <Button type="button" size="sm" variant="ghost" onClick={() => { onPause(target); onCancel() }}>
                  <Pause size={14} strokeWidth={1.75} aria-hidden="true" />
                  Pause it instead
                </Button>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              {/* Focused first, so Enter on a dialog opened by accident keeps the target. */}
              <Button type="button" variant="secondary" onClick={onCancel} autoFocus>
                Keep it
              </Button>
              <Button type="button" variant="danger" onClick={() => onConfirm(target.id)}>
                <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                Delete target
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
