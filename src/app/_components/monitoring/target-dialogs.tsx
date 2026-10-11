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
  SelectSeparator,
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
  targetAddressLabel,
  validateProbeConfig,
} from '@/lib/probe-config'
import { DualStackBadge, Ipv6Badge, TypeBadge } from './target-badges'
import {
  Plus,
  Pencil,
  Globe,
  Network,
  Plug,
  Wifi,
  Check,
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

/**
 * Each method with the question it answers. The names alone only help someone
 * who already knows what ICMP is; the question is what a person actually came
 * with, and all four are on show at once so they can be told apart.
 */
const PROBE_METHODS: { value: ProbeType; label: string; question: string; icon: typeof Wifi }[] = [
  { value: 'ping', label: 'Ping (ICMP)', question: 'Is it up, and how fast does it reply?', icon: Wifi },
  { value: 'tcp', label: 'TCP port', question: 'Is a service accepting connections?', icon: Plug },
  { value: 'http', label: 'Web page (HTTP)', question: 'Does a page load as expected?', icon: Globe },
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
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How to check it">
      {PROBE_METHODS.map(method => {
        const selected = value === method.value
        return (
          <button
            key={method.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(method.value)}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left outline-none transition-colors',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected ? 'border-primary bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted/60'
            )}
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
                selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
            >
              <method.icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-card-foreground">
                {method.label}
                {selected && suggested === method.value && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] leading-none text-primary">
                    Detected
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{method.question}</span>
            </span>
          </button>
        )
      })}
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
      <span className="flex shrink-0 items-center gap-1 pt-0.5">
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
 * "optional", and a field with neither already holds a sensible value.
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
      {optional && <span className="text-xs font-normal text-muted-foreground">optional</span>}
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

/** What a field is for or what it accepts, under the field. */
function FieldHint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs leading-relaxed text-muted-foreground">
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
  newGroupInputId,
  group,
  availableGroups,
  onChange,
}: {
  id: string
  /** The box that appears for a new group's name, which is where typing goes next. */
  newGroupInputId: string
  group: string
  availableGroups: string[]
  onChange: (group: string) => void
}) {
  return (
    <div className="space-y-2">
      <FieldLabel htmlFor={id} small>Group</FieldLabel>
      <Select value={group || NO_GROUP} onValueChange={value => onChange(value === NO_GROUP ? '' : value)}>
        <SelectTrigger id={id} className={cn(FIELD_INPUT, 'w-full')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          className="bg-popover border-border"
          // A closing list hands focus back to its button, which would take it
          // from the name box that "New group…" has just opened.
          onCloseAutoFocus={event => {
            const input = group === NEW_GROUP ? document.getElementById(newGroupInputId) : null
            if (!input) return
            event.preventDefault()
            input.focus()
          }}
        >
          <SelectItem value={NO_GROUP}>No group</SelectItem>
          {availableGroups.map(name => (
            <SelectItem key={name} value={name}>{groupLabel(name)}</SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={NEW_GROUP}>New group…</SelectItem>
        </SelectContent>
      </Select>
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
      <FieldLabel small>IP version</FieldLabel>
      {/* One tray, so the four read as a single setting rather than four buttons. */}
      <div
        className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5 sm:grid-cols-4"
        role="radiogroup"
        aria-label="IP version"
      >
        {IP_VERSION_CHOICES.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'cursor-pointer rounded-md px-2 py-1.5 text-xs outline-none transition-colors touch:py-2.5',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50',
              value === option.value
                ? 'bg-primary font-medium text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
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
    <div className="space-y-2">
      <FieldLabel htmlFor={id} small>Probe every</FieldLabel>
      <Select value={value.toString()} onValueChange={v => onChange(parseInt(v))}>
        <SelectTrigger id={id} className={cn(FIELD_INPUT, 'w-full')}>
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
  onCancel: () => void
}

type RequiredField = 'address' | 'port'

/**
 * The form reads top to bottom as the questions someone adding a target has,
 * in the order they have them: what, how, what to call it, and then the
 * settings that already hold a sensible answer. Only the first has to be
 * answered, so an address and Enter is a whole target.
 */
function TargetForm({ idPrefix, initial, availableGroups, submitLabel, onSubmit, onCancel }: TargetFormProps) {
  const initialGroupIsNew = !!initial.group && !availableGroups.includes(initial.group)

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
  const [customGroup, setCustomGroup] = useState(initialGroupIsNew ? initial.group : '')
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
  const config = validation.ok ? validation.config : {}
  const effectiveIpVersion = isDomain ? ipVersion : 'auto'

  // What each required field still needs, if anything.
  const problems: Record<RequiredField, string | null> = {
    address: !host ? 'Enter a hostname, an IP address or a URL.' : !hostValid ? 'Not a valid hostname, IPv4 address or IPv6 address.' : null,
    port: probeType !== 'tcp' || validation.ok
      ? null
      : draft.port.trim() === '' ? 'Enter the port to connect to.' : validation.error,
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
      group: group === NEW_GROUP ? normalizeGroupPath(customGroup) : group,
    })
  }

  const addressError = shown('address')
  // Nothing to describe until the address is something that can be probed.
  // What is wrong with it is said under the address field.
  const summary = host ? describeProbe(host, probeType, effectiveIpVersion, config) : ''
  // A setting that is filled in but wrong. Shown only once the address is
  // fine, and never for the port, which reports under its own field: two
  // messages for one mistake is one too many.
  const settingsError = hostValid && host && !validation.ok && probeType !== 'tcp' ? validation.error : null
  const hasSettings = probeType !== 'ping'

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={event => { event.preventDefault(); handleSubmit() }}
    >
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
        {/* What. The one field that has to be filled in, and built to look it. */}
        <div className="space-y-2">
          <FieldLabel htmlFor={`${idPrefix}-address`}>What do you want to monitor?</FieldLabel>
          <div className="relative">
            <Input
              id={`${idPrefix}-address`}
              placeholder="example.com"
              value={address}
              onChange={e => handleAddressChange(e.target.value)}
              onBlur={handleAddressBlur}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-required="true"
              aria-invalid={!!addressError}
              aria-describedby={`${idPrefix}-address-${addressError ? 'error' : 'hint'}`}
              className="h-12 border-border bg-input pr-10 font-mono text-base text-foreground md:text-base"
              autoFocus={initial.host === ''}
            />
            {host && hostValid && (
              <Check
                className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-signal-perfect"
                aria-hidden="true"
              />
            )}
          </div>
          {addressError ? (
            <FieldError id={`${idPrefix}-address-error`}>{addressError}</FieldError>
          ) : (
            <FieldHint id={`${idPrefix}-address-hint`}>
              A hostname, an IP address, <span className="font-mono">host:port</span> or a whole URL. Paste
              whatever you have: a port or path is moved into the settings below.
            </FieldHint>
          )}
        </div>

        {/* How, with the chosen method's own settings attached beneath it. */}
        <div className="space-y-2">
          <FieldLabel>How should it be checked?</FieldLabel>
          <ProbeMethodPicker
            value={probeType}
            suggested={suggested}
            onChange={value => { setProbeType(value); setProbeChosen(true); setSuggested(null) }}
          />
          {(hasSettings || summary) && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3.5">
              <ProbeConfigFields
                idPrefix={idPrefix}
                probeType={probeType}
                host={host}
                draft={draft}
                portError={shown('port') ?? undefined}
                onChange={changes => setDraft(current => ({ ...current, ...changes }))}
                onPortBlur={() => touch('port')}
              />
              {settingsError && <p className="text-xs text-destructive">{settingsError}</p>}
              {summary && (
                <div className={cn(hasSettings && 'border-t border-border pt-3')}>
                  <ProbeSummary host={host} probeType={probeType} ipVersion={effectiveIpVersion} summary={summary} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* What to call it. */}
        <div className="space-y-2">
          <FieldLabel htmlFor={`${idPrefix}-name`} optional>Name</FieldLabel>
          <Input
            id={`${idPrefix}-name`}
            placeholder={host && hostValid ? host : 'e.g. Office router'}
            value={name}
            onChange={e => setName(e.target.value)}
            aria-describedby={`${idPrefix}-name-hint`}
            className="border-border bg-input text-foreground"
          />
          <FieldHint id={`${idPrefix}-name-hint`}>Shown in the sidebar. Left blank, the address is used.</FieldHint>
        </div>

        {/* Everything from here down already holds a sensible answer. */}
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <IntervalSelect id={`${idPrefix}-interval`} value={interval} onChange={setInterval} />
          <GroupSelect
            id={`${idPrefix}-group`}
            newGroupInputId={`${idPrefix}-new-group`}
            group={group}
            availableGroups={availableGroups}
            onChange={next => { setGroup(next); if (next !== NEW_GROUP) setCustomGroup('') }}
          />
          {group === NEW_GROUP && (
            <div className="space-y-2 sm:col-span-2">
              <Input
                id={`${idPrefix}-new-group`}
                placeholder="New group name"
                aria-label="New group name"
                value={customGroup}
                onChange={e => setCustomGroup(e.target.value)}
                className={FIELD_INPUT}
              />
              <FieldHint>
                A <span className="font-mono">/</span> puts it inside another group:{' '}
                <span className="font-mono">Home/Network</span>.
              </FieldHint>
            </div>
          )}
        </div>

        {hostKind !== 'ipv4' && hostKind !== 'ipv6' && <IpVersionPicker value={ipVersion} onChange={setIpVersion} />}
      </div>

      {/* Outside the part that scrolls, so the button is on show however long
          the settings above it get. */}
      <div className="flex flex-col gap-3 border-t border-border bg-muted/20 px-5 py-3.5 sm:flex-row sm:items-center sm:px-6">
        {/* What pressing the button will do, or what is stopping it. */}
        <p
          className={cn(
            'min-w-0 flex-1 text-xs',
            attempted && !isValid ? 'text-destructive' : 'text-muted-foreground'
          )}
          role={attempted && !isValid ? 'alert' : undefined}
        >
          {missing.length > 0 ? (
            `Still needed: ${missing.join(', ')}.`
          ) : !validation.ok ? (
            validation.error
          ) : (
            <span className="block truncate" title={recapFor(host, probeType, config, interval)}>
              {recapFor(host, probeType, config, interval)}
            </span>
          )}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={onCancel}>
            Cancel
          </Button>
          {/* Left enabled while something is missing: pressing it says what,
              where a greyed-out button only says no. */}
          <Button type="submit" className="flex-1 sm:flex-none" aria-disabled={!isValid}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}

// ─── Add Target Dialog ──────────────────────────────────────────────────────

/**
 * The dialog as three stacked parts: a header and a footer that stay where
 * they are, and the form's fields scrolling between them. The dialog's own
 * padding and scrolling are turned off so each part can do its own.
 */
const DIALOG_SHELL = 'flex flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-xl sm:p-0'
const DIALOG_HEADER = 'border-b border-border px-5 py-4 text-left sm:px-6'

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
      <DialogContent className={DIALOG_SHELL} suppressHydrationWarning>
        <DialogHeader className={DIALOG_HEADER}>
          <DialogTitle className="text-card-foreground flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Plus className="h-4 w-4 text-primary" />
            </div>
            Add a target
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Only the address is needed. Everything else starts with a sensible default.
          </DialogDescription>
        </DialogHeader>

        {/* The form lives inside the dialog's content, which is unmounted on
            close, so every opening starts from a blank form without a reset. */}
        <TargetForm
          idPrefix="add"
          initial={BLANK_TARGET}
          availableGroups={availableGroups}
          submitLabel="Add target"
          onCancel={() => onOpenChange(false)}
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
      <DialogContent className={DIALOG_SHELL} suppressHydrationWarning>
        <DialogHeader className={DIALOG_HEADER}>
          <DialogTitle className="text-card-foreground flex items-center gap-2">
            <div className="h-8 w-8 shrink-0 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Pencil className="h-4 w-4 text-blue-500" />
            </div>
            <span className="min-w-0 break-words pr-6">Edit {target.name}</span>
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
          submitLabel="Save changes"
          onCancel={() => onOpenChange(false)}
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
