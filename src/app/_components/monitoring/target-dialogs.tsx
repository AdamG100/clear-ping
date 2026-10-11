'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { DnsRecordType, IpVersion, ProbeConfig, ProbeType, Target } from '@/types/probe'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { addressFamilyFor, classifyHost, isDualStack, isWellKnownResolver, targetTypeFor } from '@/lib/host'
import { groupLabel, normalizeGroupPath } from '@/lib/group-path'
import { describeProbe } from '@/lib/probe-labels'
import {
  DEFAULT_DNS_QUERY_NAME,
  DNS_RECORD_TYPES,
  parseAddressInput,
  validateProbeConfig,
} from '@/lib/probe-config'
import { DualStackBadge, Ipv6Badge, TypeBadge } from './target-badges'
import {
  Plus,
  Pencil,
  Globe,
  Network,
  Plug,
  FolderPlus,
  Wifi,
  Search,
  Trash2,
} from 'lucide-react'

/**
 * The add and edit dialogs, which are the same form.
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
  port: string
  scheme: 'http' | 'https'
  path: string
  expectedStatus: string
  keyword: string
  queryName: string
  recordType: DnsRecordType
  expectedAnswer: string
}

function draftFrom(config: ProbeConfig = {}): ConfigDraft {
  return {
    port: config.port ? String(config.port) : '',
    scheme: config.scheme ?? 'https',
    path: config.path ?? '/',
    expectedStatus: config.expectedStatus ? String(config.expectedStatus) : '',
    keyword: config.keyword ?? '',
    queryName: config.queryName ?? '',
    recordType: config.recordType ?? 'A',
    expectedAnswer: config.expectedAnswer ?? '',
  }
}

/** Blank means "not set"; anything else must survive as typed so it can be rejected. */
function numberOrUndefined(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text)
}

function configFrom(draft: ConfigDraft): Record<string, unknown> {
  return {
    port: numberOrUndefined(draft.port),
    scheme: draft.scheme,
    path: draft.path,
    expectedStatus: numberOrUndefined(draft.expectedStatus),
    keyword: draft.keyword,
    queryName: draft.queryName,
    recordType: draft.recordType,
    expectedAnswer: draft.expectedAnswer,
  }
}

interface TargetFormValues {
  name: string
  host: string
  probeType: ProbeType
  ipVersion: IpVersion
  probeConfig: ProbeConfig
  interval: number
  /** Empty for no group. */
  group: string
}

// ─── Probe method ───────────────────────────────────────────────────────────

const PROBE_METHODS: { value: ProbeType; label: string; icon: typeof Wifi }[] = [
  { value: 'ping', label: 'Ping (ICMP)', icon: Wifi },
  { value: 'tcp', label: 'TCP port', icon: Plug },
  { value: 'http', label: 'HTTP(S)', icon: Globe },
  { value: 'dns', label: 'DNS query', icon: Network },
]

/**
 * How the target is measured. Out in the open rather than under Advanced: it
 * decides what every number on the target's page means.
 */
function ProbeMethodPicker({
  value,
  onChange,
}: {
  value: ProbeType
  onChange: (probeType: ProbeType) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Probe method">
      {PROBE_METHODS.map(method => (
        <button
          key={method.value}
          type="button"
          role="radio"
          aria-checked={value === method.value}
          onClick={() => onChange(method.value)}
          className={cn(
            'flex items-center justify-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors cursor-pointer touch:py-2.5',
            value === method.value
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
          )}
        >
          <method.icon className="h-3.5 w-3.5" />
          {method.label}
        </button>
      ))}
    </div>
  )
}

/** What the current address, probe and settings add up to, in a sentence. */
function ProbeSummary({
  host,
  probeType,
  ipVersion,
  config,
}: {
  host: string
  probeType: ProbeType
  ipVersion: IpVersion
  config: ProbeConfig
}) {
  const summary = describeProbe(host, probeType, ipVersion, config)

  // Nothing to describe until the address is something that can be probed.
  // What is wrong with it is said under the address field.
  if (!host || !summary) return null

  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1 pt-px">
        <TypeBadge type={targetTypeFor(host, probeType)} />
        {isDualStack(host, ipVersion)
          ? <DualStackBadge />
          : addressFamilyFor(host, ipVersion) === 6 && <Ipv6Badge />}
      </span>
      <span className="min-w-0 break-words">{summary}</span>
    </div>
  )
}

// ─── Field labels ───────────────────────────────────────────────────────────

/**
 * A field's label, saying whether it has to be filled in.
 *
 * Every field used to look the same, so the only way to find out which ones
 * the form insisted on was to watch the button stay grey. Now the ones it
 * cannot do without carry a red asterisk, the ones that can be left alone say
 * "Optional", and a field with neither already holds a sensible value.
 */
function FieldLabel({
  htmlFor,
  required = false,
  optional = false,
  small = false,
  children,
}: {
  htmlFor?: string
  required?: boolean
  optional?: boolean
  /** The quieter size used for a probe's own settings. */
  small?: boolean
  children: ReactNode
}) {
  return (
    <Label htmlFor={htmlFor} className={cn('gap-1.5 text-card-foreground', small ? 'text-xs' : 'text-sm font-medium')}>
      {children}
      {required && (
        <>
          <span className="text-base leading-none text-destructive" aria-hidden="true">*</span>
          <span className="sr-only">(required)</span>
        </>
      )}
      {optional && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase leading-none tracking-wider text-muted-foreground">
          Optional
        </span>
      )}
    </Label>
  )
}

/** Why a required field is not acceptable yet, under the field it is about. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-destructive">
      {children}
    </p>
  )
}

// ─── Probe-specific settings ────────────────────────────────────────────────

const FIELD_INPUT = 'bg-input border-border text-foreground h-9 text-sm'

/**
 * The settings only the chosen probe has. Nothing at all for a ping, which is
 * the point: the fields that appear are the ones that mean something.
 */
function ProbeConfigFields({
  idPrefix,
  probeType,
  host,
  draft,
  portError,
  onChange,
  onPortBlur,
}: {
  idPrefix: string
  probeType: ProbeType
  host: string
  draft: ConfigDraft
  /** Set when a TCP target's port is missing or wrong and it is time to say so. */
  portError?: string
  onChange: (changes: Partial<ConfigDraft>) => void
  onPortBlur: () => void
}) {
  if (probeType === 'ping') return null

  if (probeType === 'tcp') {
    return (
      <div className="space-y-2">
        <FieldLabel htmlFor={`${idPrefix}-port`} required>Port</FieldLabel>
        <Input
          id={`${idPrefix}-port`}
          inputMode="numeric"
          placeholder="e.g., 443, 22, 5432"
          value={draft.port}
          onChange={e => onChange({ port: e.target.value })}
          onBlur={onPortBlur}
          aria-required="true"
          aria-invalid={!!portError}
          aria-describedby={portError ? `${idPrefix}-port-error` : undefined}
          className={cn(FIELD_INPUT, 'w-40')}
        />
        {portError && <FieldError id={`${idPrefix}-port-error`}>{portError}</FieldError>}
      </div>
    )
  }

  if (probeType === 'http') {
    return (
      <div className="space-y-3">
        {/* Three across leaves the path a few letters wide in a dialog the
            width of a phone, so there it has the second line to itself. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[7rem_6rem_1fr]">
          <div className="space-y-2">
            <FieldLabel htmlFor={`${idPrefix}-scheme`} small>Scheme</FieldLabel>
            <Select value={draft.scheme} onValueChange={(v: 'http' | 'https') => onChange({ scheme: v })}>
              <SelectTrigger id={`${idPrefix}-scheme`} className={cn(FIELD_INPUT, 'w-full')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                <SelectItem value="https">HTTPS</SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor={`${idPrefix}-http-port`} small>Port</FieldLabel>
            <Input
              id={`${idPrefix}-http-port`}
              inputMode="numeric"
              placeholder={draft.scheme === 'https' ? '443' : '80'}
              value={draft.port}
              onChange={e => onChange({ port: e.target.value })}
              className={FIELD_INPUT}
            />
          </div>
          <div className="col-span-2 space-y-2 sm:col-span-1">
            <FieldLabel htmlFor={`${idPrefix}-path`} small>Path</FieldLabel>
            <Input
              id={`${idPrefix}-path`}
              placeholder="/"
              value={draft.path}
              onChange={e => onChange({ path: e.target.value })}
              className={cn(FIELD_INPUT, 'font-mono')}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
          <div className="space-y-2">
            <FieldLabel htmlFor={`${idPrefix}-status`} small optional>Expect status</FieldLabel>
            <Input
              id={`${idPrefix}-status`}
              inputMode="numeric"
              placeholder="2xx / 3xx"
              value={draft.expectedStatus}
              onChange={e => onChange({ expectedStatus: e.target.value })}
              className={FIELD_INPUT}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor={`${idPrefix}-keyword`} small optional>Page must contain</FieldLabel>
            <Input
              id={`${idPrefix}-keyword`}
              placeholder="e.g., Sign in"
              value={draft.keyword}
              onChange={e => onChange({ keyword: e.target.value })}
              className={FIELD_INPUT}
            />
          </div>
        </div>
      </div>
    )
  }

  // DNS. A server can be asked anything; a name is itself the question, so the
  // only thing left to say about it is what the answer ought to be.
  const isServer = classifyHost(host) !== 'hostname'

  return (
    <div className="space-y-3">
      {isServer && (
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <div className="space-y-2">
            <FieldLabel htmlFor={`${idPrefix}-query`} small>Name to look up</FieldLabel>
            <Input
              id={`${idPrefix}-query`}
              placeholder={DEFAULT_DNS_QUERY_NAME}
              value={draft.queryName}
              onChange={e => onChange({ queryName: e.target.value })}
              className={FIELD_INPUT}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor={`${idPrefix}-record`} small>Record</FieldLabel>
            <Select value={draft.recordType} onValueChange={(v: DnsRecordType) => onChange({ recordType: v })}>
              <SelectTrigger id={`${idPrefix}-record`} className={cn(FIELD_INPUT, 'w-full')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                {DNS_RECORD_TYPES.map(type => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <FieldLabel htmlFor={`${idPrefix}-answer`} small optional>
          {isServer ? 'Answer must include' : 'Must resolve to'}
        </FieldLabel>
        <Input
          id={`${idPrefix}-answer`}
          placeholder={isServer ? 'e.g., 203.0.113.10 or mx.example.com' : 'e.g., 203.0.113.10'}
          value={draft.expectedAnswer}
          onChange={e => onChange({ expectedAnswer: e.target.value })}
          className={FIELD_INPUT}
        />
      </div>
    </div>
  )
}

// ─── Shared fields ──────────────────────────────────────────────────────────

/** One of a row of mutually exclusive choices. */
const choice = (selected: boolean) =>
  cn(
    'text-xs px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer touch:py-2.5',
    selected
      ? 'bg-primary text-primary-foreground border-primary'
      : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
  )

const NEW_GROUP = '__custom__'

function GroupPicker({
  group,
  customGroup,
  availableGroups,
  onGroupChange,
  onCustomGroupChange,
}: {
  group: string
  customGroup: string
  availableGroups: string[]
  onGroupChange: (group: string) => void
  onCustomGroupChange: (name: string) => void
}) {
  return (
    <div className="space-y-2">
      <FieldLabel small>Group</FieldLabel>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => onGroupChange('')} className={choice(group === '')}>
          None
        </button>
        {availableGroups.map(name => (
          <button key={name} type="button" onClick={() => onGroupChange(name)} className={choice(group === name)}>
            {groupLabel(name)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onGroupChange(NEW_GROUP)}
          className={cn(choice(group === NEW_GROUP), 'flex items-center gap-1')}
        >
          <FolderPlus className="h-3 w-3" />
          New
        </button>
      </div>
      {group === NEW_GROUP && (
        <Input
          placeholder="New group name, or Home/Network for a group inside a group"
          value={customGroup}
          onChange={e => onCustomGroupChange(e.target.value)}
          className="bg-input border-border text-foreground text-sm mt-1.5"
          autoFocus
        />
      )}
      <p className="text-[11px] text-muted-foreground">
        Targets in a group can be compared on one chart. A <span className="font-mono">/</span> in
        a new group&apos;s name puts it inside another: <span className="font-mono">Home/Network</span>.
      </p>
    </div>
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
 * probe, and offered whenever the address is a name: an IP address belongs to
 * one family already, and that is said rather than offered.
 */
function IpVersionPicker({
  host,
  value,
  onChange,
}: {
  host: string
  value: IpVersion
  onChange: (ipVersion: IpVersion) => void
}) {
  const kind = classifyHost(host)
  const selected = IP_VERSION_CHOICES.find(option => option.value === value) ?? IP_VERSION_CHOICES[0]

  return (
    <div className="space-y-2">
      <FieldLabel small>IP version</FieldLabel>
      {kind === 'ipv4' || kind === 'ipv6' ? (
        <p className="text-xs text-muted-foreground">
          {kind === 'ipv6' ? 'IPv6' : 'IPv4'} only: the address is an {kind === 'ipv6' ? 'IPv6' : 'IPv4'} address. Enter a
          hostname to choose, or to monitor both.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="IP version">
            {IP_VERSION_CHOICES.map(option => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={value === option.value}
                onClick={() => onChange(option.value)}
                className={choice(value === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">{selected.hint}</p>
        </>
      )}
    </div>
  )
}

const INTERVALS = [
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 1800, label: '30 minutes' },
  { seconds: 3600, label: '1 hour' },
]

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
    <div className="space-y-2">
      <FieldLabel htmlFor={id} small>Probe every</FieldLabel>
      <Select value={value.toString()} onValueChange={v => onChange(parseInt(v))}>
        <SelectTrigger id={id} className={cn(FIELD_INPUT, 'w-44')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-popover border-border">
          {INTERVALS.map(option => (
            <SelectItem key={option.seconds} value={option.seconds.toString()}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ─── The form ───────────────────────────────────────────────────────────────

interface TargetFormProps {
  idPrefix: string
  initial: TargetFormValues
  availableGroups: string[]
  submitLabel: string
  onSubmit: (values: TargetFormValues) => void
}

type RequiredField = 'address' | 'port' | 'name'

function TargetForm({ idPrefix, initial, availableGroups, submitLabel, onSubmit }: TargetFormProps) {
  const initialGroupIsNew = !!initial.group && !availableGroups.includes(initial.group)

  const [name, setName] = useState(initial.name)
  const [address, setAddress] = useState(initial.host)
  const [probeType, setProbeType] = useState<ProbeType>(initial.probeType)
  // Once the method has been picked by hand, typing more of the address must
  // not quietly switch it back. An existing target's method was picked.
  const [probeChosen, setProbeChosen] = useState(initial.host !== '')
  const [ipVersion, setIpVersion] = useState<IpVersion>(initial.ipVersion)
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFrom(initial.probeConfig))
  const [interval, setInterval] = useState(initial.interval)
  const [group, setGroup] = useState(initialGroupIsNew ? NEW_GROUP : initial.group)
  const [customGroup, setCustomGroup] = useState(initialGroupIsNew ? initial.group : '')
  // A required field is only called out once it has been left, or once the
  // form has been submitted: flagging an empty box before anyone has had the
  // chance to type in it is nagging, not help.
  const [touched, setTouched] = useState<Record<RequiredField, boolean>>({ address: false, port: false, name: false })
  const [attempted, setAttempted] = useState(false)

  // The address box takes whatever is pasted into it: a bare host, a URL, or
  // host:port. The host is what gets stored; anything else it carried is
  // copied into the settings fields below as it is typed.
  const parsed = parseAddressInput(address)
  const host = parsed.host
  const isDomain = classifyHost(host) === 'hostname'

  const handleAddressChange = (value: string) => {
    setAddress(value)

    const next = parseAddressInput(value)
    const carried: Partial<ConfigDraft> = {}
    if (next.config.port !== undefined) carried.port = String(next.config.port)
    if (next.config.scheme) carried.scheme = next.config.scheme
    if (next.config.path) carried.path = next.config.path
    if (Object.keys(carried).length > 0) setDraft(current => ({ ...current, ...carried }))

    if (!probeChosen) {
      setProbeType(next.probeType ?? (isWellKnownResolver(next.host) ? 'dns' : 'ping'))
    }
  }

  const touch = (field: RequiredField) => setTouched(current => ({ ...current, [field]: true }))

  // Leaving the box reduces it to the host. From then on the port and path
  // live only in their own fields, so there is never a second copy in the
  // address to disagree with them.
  const handleAddressBlur = () => {
    if (address.trim() !== host) setAddress(host)
    touch('address')
  }

  const validation = validateProbeConfig(probeType, host, configFrom(draft))
  const hostValid = classifyHost(host) !== 'invalid'

  // What each required field still needs, if anything.
  const problems: Record<RequiredField, string | null> = {
    address: !host ? 'Enter a hostname, an IP address or a URL.' : !hostValid ? 'Not a valid hostname, IPv4 address or IPv6 address.' : null,
    port: probeType !== 'tcp' || validation.ok
      ? null
      : draft.port.trim() === '' ? 'Enter the port to connect to.' : validation.error,
    name: name.trim() ? null : 'Give the target a name to show in the sidebar.',
  }
  const shown = (field: RequiredField) => (attempted || touched[field] ? problems[field] : null)

  const missing = [
    problems.address && (host ? 'a valid address' : 'an address'),
    problems.port && 'a port',
    problems.name && 'a display name',
  ].filter((item): item is string => !!item)

  const isValid = missing.length === 0 && validation.ok

  const handleSubmit = () => {
    if (!isValid || !validation.ok) {
      // Say what is wrong and go to it, instead of a button that does nothing.
      setAttempted(true)
      const first = (['address', 'port', 'name'] as const).find(field => problems[field])
      if (first) document.getElementById(`${idPrefix}-${first}`)?.focus()
      return
    }

    onSubmit({
      name: name.trim(),
      host,
      probeType,
      // Only a domain has a choice of family; a literal already fixes its own.
      ipVersion: isDomain ? ipVersion : 'auto',
      probeConfig: validation.config,
      interval,
      group: group === NEW_GROUP ? normalizeGroupPath(customGroup) : group,
    })
  }

  const addressError = shown('address')
  const nameError = shown('name')

  return (
    <form
      className="space-y-4 pt-2"
      noValidate
      onSubmit={event => { event.preventDefault(); handleSubmit() }}
    >
      <p className="text-xs text-muted-foreground">
        Fields marked <span className="text-sm leading-none text-destructive" aria-hidden="true">*</span>
        <span className="sr-only">with an asterisk</span> are required. Everything else can be left as it is.
      </p>

      {/* Address — the most important field, first */}
      <div className="space-y-2">
        <FieldLabel htmlFor={`${idPrefix}-address`} required>Address</FieldLabel>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id={`${idPrefix}-address`}
            placeholder="192.168.1.1, example.com, host:5432, https://example.com/health"
            value={address}
            onChange={e => handleAddressChange(e.target.value)}
            onBlur={handleAddressBlur}
            aria-required="true"
            aria-invalid={!!addressError}
            aria-describedby={addressError ? `${idPrefix}-address-error` : undefined}
            className="bg-input border-border text-foreground pl-9"
            autoFocus={initial.host === ''}
          />
        </div>
        {addressError && <FieldError id={`${idPrefix}-address-error`}>{addressError}</FieldError>}
      </div>

      {/* Probe method, and what it will measure for this address */}
      <div className="space-y-2">
        <FieldLabel>Monitor with</FieldLabel>
        <ProbeMethodPicker
          value={probeType}
          onChange={value => { setProbeType(value); setProbeChosen(true) }}
        />
        <ProbeSummary
          host={host}
          probeType={probeType}
          ipVersion={isDomain ? ipVersion : 'auto'}
          config={validation.ok ? validation.config : {}}
        />
      </div>

      <ProbeConfigFields
        idPrefix={idPrefix}
        probeType={probeType}
        host={host}
        draft={draft}
        portError={shown('port') ?? undefined}
        onChange={changes => setDraft(current => ({ ...current, ...changes }))}
        onPortBlur={() => touch('port')}
      />
      {/* A setting that is filled in but wrong. Shown only once the address is
          fine, and never for the port, which reports under its own field: two
          messages for one mistake is one too many. */}
      {hostValid && host && !validation.ok && probeType !== 'tcp' && (
        <p className="text-xs text-destructive">{validation.error}</p>
      )}

      {/* Name */}
      <div className="space-y-2">
        <FieldLabel htmlFor={`${idPrefix}-name`} required>Display name</FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          placeholder="e.g., Production Server, Google DNS"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={() => touch('name')}
          aria-required="true"
          aria-invalid={!!nameError}
          aria-describedby={nameError ? `${idPrefix}-name-error` : undefined}
          className="bg-input border-border text-foreground"
        />
        {nameError && <FieldError id={`${idPrefix}-name-error`}>{nameError}</FieldError>}
      </div>

      {/* Everything below has a default, and is set apart so that is obvious. */}
      <div className="flex items-center gap-3 pt-1" role="presentation">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Optional settings
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <IpVersionPicker host={host} value={ipVersion} onChange={setIpVersion} />

      <GroupPicker
        group={group}
        customGroup={customGroup}
        availableGroups={availableGroups}
        onGroupChange={next => { setGroup(next); if (next !== NEW_GROUP) setCustomGroup('') }}
        onCustomGroupChange={setCustomGroup}
      />

      <IntervalSelect id={`${idPrefix}-interval`} value={interval} onChange={setInterval} />

      <div className="space-y-2 pt-1">
        {/* Left enabled while something is missing: pressing it says what,
            where a greyed-out button only says no. */}
        <Button type="submit" className="w-full" aria-disabled={!isValid}>
          {submitLabel}
        </Button>
        {missing.length > 0 && (
          <p
            className={cn('text-center text-xs', attempted ? 'text-destructive' : 'text-muted-foreground')}
            role={attempted ? 'alert' : undefined}
          >
            Still needed: {missing.join(', ')}.
          </p>
        )}
      </div>
    </form>
  )
}

// ─── Add Target Dialog ──────────────────────────────────────────────────────

const BLANK_TARGET: TargetFormValues = {
  name: '',
  host: '',
  probeType: 'ping',
  ipVersion: 'auto',
  probeConfig: {},
  interval: 300,
  group: '',
}

interface AddTargetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddTarget: (target: Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>) => void
  availableGroups: string[]
}

export function AddTargetDialog({ open, onOpenChange, onAddTarget, availableGroups }: AddTargetDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-md" suppressHydrationWarning>
        <DialogHeader>
          <DialogTitle className="text-card-foreground flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Plus className="h-4 w-4 text-primary" />
            </div>
            Add New Target
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Add a server, port, website, or DNS target to monitor.
          </DialogDescription>
        </DialogHeader>

        {/* The form lives inside the dialog's content, which is unmounted on
            close, so every opening starts from a blank form without a reset. */}
        <TargetForm
          idPrefix="add"
          initial={BLANK_TARGET}
          availableGroups={availableGroups}
          submitLabel="Add Target"
          onSubmit={values => {
            onAddTarget({
              ...values,
              group: values.group || undefined,
              status: 'active',
              createdAt: new Date(),
              updatedAt: new Date(),
              type: targetTypeFor(values.host, values.probeType),
            })
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

// ─── Edit Target Dialog ─────────────────────────────────────────────────────

interface EditTargetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: Target | null
  onSave: (id: string, updates: Partial<Target>) => void
  availableGroups: string[]
}

export function EditTargetDialog({ open, onOpenChange, target, onSave, availableGroups }: EditTargetDialogProps) {
  if (!target) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-md" suppressHydrationWarning>
        <DialogHeader>
          <DialogTitle className="text-card-foreground flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Pencil className="h-4 w-4 text-blue-500" />
            </div>
            Edit Target
          </DialogTitle>
        </DialogHeader>

        <TargetForm
          key={target.id}
          idPrefix="edit"
          initial={{
            name: target.name,
            host: target.host,
            probeType: target.probeType,
            ipVersion: target.ipVersion ?? 'auto',
            probeConfig: target.probeConfig ?? {},
            interval: target.interval,
            group: target.group || '',
          }}
          availableGroups={availableGroups}
          submitLabel="Save Changes"
          onSubmit={values => {
            // The group is sent even when empty: that is how choosing "None"
            // takes the target out of its group.
            onSave(target.id, { ...values, updatedAt: new Date() })
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
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
      <DialogContent className="bg-card border-border sm:max-w-md" suppressHydrationWarning>
        {target && (
          <>
            <DialogHeader>
              <DialogTitle className="text-card-foreground flex items-center gap-2">
                <div className="h-8 w-8 shrink-0 rounded-lg bg-destructive/10 flex items-center justify-center">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </div>
                <span className="min-w-0 break-words">Delete {target.name}?</span>
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                This removes the target and everything recorded for it: its measurement history, its alert
                rules and its saved routes. It cannot be undone.
              </DialogDescription>
            </DialogHeader>

            {target.status !== 'paused' && (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                To stop probing but keep the history,{' '}
                <button
                  type="button"
                  onClick={() => { onPause(target); onCancel() }}
                  className="cursor-pointer font-medium text-foreground underline underline-offset-2"
                >
                  pause it instead
                </button>
                .
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              {/* Focused first, so Enter on a dialog opened by accident keeps the target. */}
              <Button variant="outline" onClick={onCancel} autoFocus>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => onConfirm(target.id)}>
                Delete target
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
