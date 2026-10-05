'use client'

import { useMemo, useState } from 'react'
import { Bell, BellOff, Check, Minus, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { alertTitle, describeCondition, isDiscordWebhook, parseMentionIds } from '@/lib/alert-delivery'
import { groupDepth, groupName } from '@/lib/group-path'
import { buildSidebarLayout, groupsInOrder, targetsWithin } from '@/lib/sidebar-layout'
import type { Alert, AlertDestination, AlertMetric, AlertTargetState, GroupOrder, Target } from '@/types/probe'
import { ALERT_DESTINATION_LABELS, ALERT_METRIC_LABELS } from '@/types/probe'

/**
 * Every alert in one place.
 *
 * Alerts used to be set on each target's own page, one target at a time, so
 * "tell me when anything stops responding" meant making the same rule again
 * for every target and keeping the copies in step by hand. An alert is now
 * made once, here, and ticked for the targets it should watch.
 */

/** An alert as the API sends it: its dates are still text. */
export interface AlertResponse extends Omit<Alert, 'createdAt' | 'targets'> {
  createdAt: string
  targets: (Omit<AlertTargetState, 'lastFiredAt' | 'lastResolvedAt'> & {
    lastFiredAt: string | null
    lastResolvedAt: string | null
  })[]
}

interface Preset {
  label: string
  metric: AlertMetric
  threshold: number
  consecutiveProbes: number
}

/**
 * Thresholds match the severity bands: 5% loss is one dropped packet in a
 * 20-packet probe, and 200ms is where interactive traffic starts to suffer.
 * The certificate one waits for a single probe, unlike the others: a
 * certificate does not flap, so there is no blip to wait out.
 */
const PRESETS: Preset[] = [
  { label: 'Stops responding', metric: 'unreachable', threshold: 0, consecutiveProbes: 3 },
  { label: 'Loss above 5%', metric: 'packetLoss', threshold: 5, consecutiveProbes: 3 },
  { label: 'Latency above 200ms', metric: 'latency', threshold: 200, consecutiveProbes: 3 },
  { label: 'Certificate expires within 14 days', metric: 'certExpiry', threshold: 14, consecutiveProbes: 1 },
]

const DEFAULT_THRESHOLD: Record<AlertMetric, string> = {
  packetLoss: '5',
  latency: '200',
  jitter: '50',
  unreachable: '0',
  certExpiry: '14',
}

function deliveryLabel(alert: Pick<AlertResponse, 'destination' | 'mentionRoleIds' | 'mentionUserIds'>): string {
  if (alert.destination === 'none') return 'Shown here only'
  if (alert.destination !== 'discord') return ALERT_DESTINATION_LABELS[alert.destination]

  const mentions = (alert.mentionRoleIds?.length ?? 0) + (alert.mentionUserIds?.length ?? 0)
  return mentions > 0 ? `Discord, mentioning ${mentions}` : 'Discord'
}

/**
 * What is asked for, and said, about each place an alert can be sent. A new
 * kind of destination is a new entry here and its own fields in the form.
 */
const DESTINATIONS: Record<Exclude<AlertDestination, 'none'>, { placeholder: string; hint: string }> = {
  discord: {
    placeholder: 'https://discord.com/api/webhooks/…',
    hint: 'Posted to the channel as an embed: red when the alert fires, green when it clears.',
  },
  webhook: {
    placeholder: 'https://hooks.example.com/…',
    hint: 'Sent a JSON payload when the alert fires and when it clears.',
  },
}

// ─── Target checklist ───────────────────────────────────────────────────────

function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    // Drawn here rather than left to the browser, whose own checkbox is a
    // white square whatever the page around it looks like.
    <span className="relative inline-flex h-3.5 w-3.5 shrink-0">
      <input
        type="checkbox"
        checked={checked}
        // Not an attribute, so it can only be set on the element itself.
        ref={element => { if (element) element.indeterminate = indeterminate }}
        onChange={event => onChange(event.target.checked)}
        aria-label={label}
        className={cn(
          'peer h-3.5 w-3.5 cursor-pointer appearance-none rounded-[4px] border border-border bg-input transition-colors',
          'hover:border-muted-foreground checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
      />
      {indeterminate ? (
        <Minus className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-primary-foreground" strokeWidth={3.5} />
      ) : (
        <Check
          className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-primary-foreground opacity-0 peer-checked:opacity-100"
          strokeWidth={3.5}
        />
      )}
    </span>
  )
}

/**
 * The targets an alert is ticked for, laid out as the sidebar lays them out.
 * Ticking a group ticks everything in it, and in the groups inside it.
 */
function TargetChecklist({
  targets,
  groupOrders,
  selected,
  onChange,
}: {
  targets: Target[]
  groupOrders: GroupOrder[]
  selected: Set<string>
  onChange: (selected: Set<string>) => void
}) {
  const layout = useMemo(() => buildSidebarLayout(targets, groupOrders), [targets, groupOrders])
  const byId = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])

  const setMany = (ids: string[], ticked: boolean) => {
    const next = new Set(selected)
    for (const id of ids) {
      if (ticked) next.add(id)
      else next.delete(id)
    }
    onChange(next)
  }

  if (targets.length === 0) {
    return <p className="text-xs text-muted-foreground">There are no targets yet. Add one from the sidebar first.</p>
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {selected.size} of {targets.length} ticked
        </span>
        <button
          type="button"
          onClick={() => onChange(new Set(targets.map(target => target.id)))}
          className="ml-auto cursor-pointer text-primary underline-offset-2 hover:underline"
        >
          All
        </button>
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="cursor-pointer text-primary underline-offset-2 hover:underline"
        >
          None
        </button>
      </div>

      <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background/60 p-2">
        {groupsInOrder(layout).map(group => {
          const members = targetsWithin(layout, group)
          const ticked = members.filter(id => selected.has(id)).length
          const depth = groupDepth(group)

          return (
            <div key={group}>
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50"
                style={{ paddingLeft: 4 + depth * 16 }}
              >
                <Checkbox
                  checked={members.length > 0 && ticked === members.length}
                  indeterminate={ticked > 0 && ticked < members.length}
                  onChange={next => setMany(members, next)}
                  label={`Every target in ${groupName(group)}`}
                />
                <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {groupName(group)}
                </span>
                <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  {ticked}/{members.length}
                </span>
              </label>

              {(layout.items[group] ?? []).map(id => {
                const target = byId.get(id)
                if (!target) return null
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50"
                    style={{ paddingLeft: 20 + depth * 16 }}
                  >
                    <Checkbox
                      checked={selected.has(id)}
                      onChange={next => setMany([id], next)}
                      label={target.name}
                    />
                    <span className="min-w-0 truncate text-xs text-foreground">{target.name}</span>
                    <span className="ml-auto min-w-0 max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">
                      {target.host}
                    </span>
                  </label>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Editor ─────────────────────────────────────────────────────────────────

interface AlertPayload {
  name: string
  metric: AlertMetric
  threshold: number
  consecutiveProbes: number
  destination: AlertDestination
  webhookUrl: string
  mentionRoleIds: string[]
  mentionUserIds: string[]
  targetIds: string[]
}

const SECTION_LABEL = 'text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'
const FIELD_LABEL = 'text-xs text-card-foreground'
const FIELD_INPUT = 'bg-input border-border text-foreground h-9 text-sm'

function AlertForm({
  alert,
  targets,
  groupOrders,
  saving,
  onSubmit,
}: {
  /** The alert being edited; absent for a new one. */
  alert: AlertResponse | null
  targets: Target[]
  groupOrders: GroupOrder[]
  saving: boolean
  onSubmit: (payload: AlertPayload) => void
}) {
  const [name, setName] = useState(alert?.name ?? '')
  const [metric, setMetric] = useState<AlertMetric>(alert?.metric ?? 'unreachable')
  const [threshold, setThreshold] = useState(alert ? String(alert.threshold) : DEFAULT_THRESHOLD.unreachable)
  const [consecutiveProbes, setConsecutiveProbes] = useState(String(alert?.consecutiveProbes ?? 3))
  const [destination, setDestination] = useState<AlertDestination>(alert?.destination ?? 'none')
  const [webhookUrl, setWebhookUrl] = useState(alert?.webhookUrl ?? '')
  const [roleIds, setRoleIds] = useState((alert?.mentionRoleIds ?? []).join(', '))
  const [userIds, setUserIds] = useState((alert?.mentionUserIds ?? []).join(', '))
  const [selected, setSelected] = useState(() => new Set(alert?.targets.map(entry => entry.targetId) ?? []))
  const [attempted, setAttempted] = useState(false)

  const url = webhookUrl.trim()
  const discord = destination === 'discord'
  const sending = destination !== 'none'
  const roles = parseMentionIds(roleIds)
  const users = parseMentionIds(userIds)
  const probes = Number(consecutiveProbes)
  const limit = Number(threshold)

  const problems = [
    metric !== 'unreachable' && (threshold.trim() === '' || !Number.isFinite(limit) || limit < 0) &&
      'The threshold must be a number, zero or more.',
    (!Number.isInteger(probes) || probes < 1 || probes > 100) && 'The number of probes must be between 1 and 100.',
    sending && url === '' && `Paste the webhook URL to send to, or choose "${ALERT_DESTINATION_LABELS.none}".`,
    sending && url !== '' && !/^https?:\/\//i.test(url) && 'The webhook URL must start with http:// or https://.',
    discord && !roles && 'Role IDs must be numbers, separated by commas or spaces.',
    discord && !users && 'User IDs must be numbers, separated by commas or spaces.',
    selected.size === 0 && 'Tick at least one target for the alert to watch.',
  ].filter((problem): problem is string => !!problem)

  const applyPreset = (preset: Preset) => {
    setMetric(preset.metric)
    setThreshold(String(preset.threshold))
    setConsecutiveProbes(String(preset.consecutiveProbes))
  }

  const handleSubmit = () => {
    if (problems.length > 0) {
      setAttempted(true)
      return
    }
    onSubmit({
      name: name.trim(),
      metric,
      threshold: metric === 'unreachable' ? 0 : limit,
      consecutiveProbes: probes,
      destination,
      webhookUrl: sending ? url : '',
      // Kept only for Discord: nothing else understands them.
      mentionRoleIds: discord ? roles ?? [] : [],
      mentionUserIds: discord ? users ?? [] : [],
      targetIds: [...selected],
    })
  }

  const condition = describeCondition({ metric, threshold: Number.isFinite(limit) ? limit : 0 })

  return (
    <form className="space-y-5 pt-2" noValidate onSubmit={event => { event.preventDefault(); handleSubmit() }}>
      {/* Condition */}
      <div className="space-y-3">
        <p className={SECTION_LABEL}>Alert when</p>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(preset => {
            const active =
              metric === preset.metric && (preset.metric === 'unreachable' || limit === preset.threshold)
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset)}
                className={cn(
                  'cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted'
                )}
              >
                {preset.label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="alert-metric" className={FIELD_LABEL}>Watching</Label>
            <Select
              value={metric}
              onValueChange={value => {
                const next = value as AlertMetric
                setMetric(next)
                setThreshold(DEFAULT_THRESHOLD[next])
                if (next === 'certExpiry') setConsecutiveProbes('1')
              }}
            >
              <SelectTrigger id="alert-metric" className={cn(FIELD_INPUT, 'w-48')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ALERT_METRIC_LABELS) as AlertMetric[]).map(option => (
                  <SelectItem key={option} value={option}>{ALERT_METRIC_LABELS[option].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {metric !== 'unreachable' && (
            <div className="space-y-1.5">
              <Label htmlFor="alert-threshold" className={FIELD_LABEL}>
                {ALERT_METRIC_LABELS[metric].comparison === 'below' ? 'Under' : 'Above'} (
                {ALERT_METRIC_LABELS[metric].unit.trim()})
              </Label>
              <Input
                id="alert-threshold"
                type="number"
                min={0}
                value={threshold}
                onChange={e => setThreshold(e.target.value)}
                className={cn(FIELD_INPUT, 'w-24')}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="alert-consecutive" className={FIELD_LABEL}>For (probes in a row)</Label>
            <Input
              id="alert-consecutive"
              type="number"
              min={1}
              max={100}
              value={consecutiveProbes}
              onChange={e => setConsecutiveProbes(e.target.value)}
              className={cn(FIELD_INPUT, 'w-24')}
            />
          </div>
        </div>
        {metric === 'certExpiry' && (
          <p className="text-[11px] text-muted-foreground">
            Only HTTPS targets have a certificate to watch. On anything else this alert never fires.
          </p>
        )}
      </div>

      {/* Delivery */}
      <div className="space-y-3">
        <p className={SECTION_LABEL}>Send it to</p>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Where the alert is sent">
          {(Object.keys(ALERT_DESTINATION_LABELS) as AlertDestination[]).map(option => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={destination === option}
              onClick={() => setDestination(option)}
              className={cn(
                'cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                destination === option
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted'
              )}
            >
              {ALERT_DESTINATION_LABELS[option]}
            </button>
          ))}
        </div>

        {destination === 'none' ? (
          <p className="text-[11px] text-muted-foreground">
            Nothing is sent. A firing alert is shown on this screen and counted beside the Alerts button.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="alert-webhook" className={FIELD_LABEL}>
              {discord ? 'Discord webhook URL' : 'Webhook URL'}
            </Label>
            <Input
              id="alert-webhook"
              placeholder={DESTINATIONS[destination].placeholder}
              value={webhookUrl}
              onChange={e => setWebhookUrl(e.target.value)}
              className={cn(FIELD_INPUT, 'font-mono text-xs')}
            />
            <p className="text-[11px] text-muted-foreground">{DESTINATIONS[destination].hint}</p>
            {/* Said, not enforced: a relay that takes Discord's format is a
                fair thing to point this at. */}
            {url !== '' && discord !== isDiscordWebhook(url) && (
              <p className="text-[11px] text-amber-500">
                {discord
                  ? 'This does not look like a Discord webhook URL. It will be sent Discord’s format all the same.'
                  : 'This looks like a Discord webhook URL. Choose Discord above to post an embed there.'}
              </p>
            )}
          </div>
        )}

        {discord && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="alert-roles" className={FIELD_LABEL}>Role IDs to mention (optional)</Label>
              <Input
                id="alert-roles"
                placeholder="123456789012345678"
                value={roleIds}
                onChange={e => setRoleIds(e.target.value)}
                aria-invalid={!roles}
                className={cn(FIELD_INPUT, 'font-mono text-xs')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="alert-users" className={FIELD_LABEL}>User IDs to mention (optional)</Label>
              <Input
                id="alert-users"
                placeholder="123456789012345678"
                value={userIds}
                onChange={e => setUserIds(e.target.value)}
                aria-invalid={!users}
                className={cn(FIELD_INPUT, 'font-mono text-xs')}
              />
            </div>
            <p className="text-[11px] text-muted-foreground sm:col-span-2">
              Mentioned when the alert fires, not when it clears. Separate several with commas. To copy an ID,
              turn on Developer Mode in Discord, then right-click the role or user.
            </p>
          </div>
        )}
      </div>

      {/* Targets */}
      <div className="space-y-3">
        <p className={SECTION_LABEL}>On these targets</p>
        <TargetChecklist targets={targets} groupOrders={groupOrders} selected={selected} onChange={setSelected} />
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor="alert-name" className={FIELD_LABEL}>Name (optional)</Label>
        <Input
          id="alert-name"
          placeholder={condition}
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={80}
          className={FIELD_INPUT}
        />
      </div>

      <div className="space-y-2">
        <Button type="submit" className="w-full" disabled={saving} aria-disabled={problems.length > 0}>
          {saving ? 'Saving…' : alert ? 'Save changes' : 'Create alert'}
        </Button>
        {attempted && problems.length > 0 && (
          <p className="text-center text-xs text-destructive" role="alert">{problems[0]}</p>
        )}
      </div>
    </form>
  )
}

// ─── The view ───────────────────────────────────────────────────────────────

interface AlertsViewProps {
  alerts: AlertResponse[]
  /** False until the first load has finished. */
  loaded: boolean
  targets: Target[]
  groupOrders: GroupOrder[]
  onChanged: () => Promise<void>
  onSelectTarget: (id: string) => void
}

/** `'new'` for an alert that does not exist yet. */
type Editing = AlertResponse | 'new' | null

export function AlertsView({ alerts, loaded, targets, groupOrders, onChanged, onSelectTarget }: AlertsViewProps) {
  const { notify, reportError } = useToast()
  const [editing, setEditing] = useState<Editing>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Deleting takes two presses of the same button: an alert ticked for twenty
  // targets is a lot to rebuild after a slip of the hand.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const targetsById = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])

  /** Send a change to the API; true if it was accepted. */
  const request = async (url: string, method: string, failure: string, body?: unknown): Promise<boolean> => {
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError(failure, error)
        return false
      }
      await onChanged()
      return true
    } catch (error) {
      reportError(failure, error)
      return false
    }
  }

  const save = async (payload: AlertPayload) => {
    setSaving(true)
    const existing = editing !== 'new' ? editing : null
    const ok = existing
      ? await request(`/api/alerts/${existing.id}`, 'PATCH', 'Could not save the alert', payload)
      : await request('/api/alerts', 'POST', 'Could not create the alert', payload)
    setSaving(false)

    if (ok) {
      setEditing(null)
      notify({ tone: 'success', title: existing ? 'Alert saved' : 'Alert created', detail: alertTitle(payload) })
    }
  }

  const toggle = async (alert: AlertResponse) => {
    setBusyId(alert.id)
    await request(`/api/alerts/${alert.id}`, 'PATCH', 'Could not update the alert', { enabled: !alert.enabled })
    setBusyId(null)
  }

  const remove = async (alert: AlertResponse) => {
    if (confirmingId !== alert.id) {
      setConfirmingId(alert.id)
      return
    }
    setConfirmingId(null)
    setBusyId(alert.id)
    await request(`/api/alerts/${alert.id}`, 'DELETE', 'Could not delete the alert')
    setBusyId(null)
  }

  const sendTest = async (alert: AlertResponse) => {
    setBusyId(alert.id)
    try {
      const response = await fetch(`/api/alerts/${alert.id}/test`, { method: 'POST' })
      const result = await response.json().catch(() => ({}))
      if (response.ok && result.ok) {
        notify({ tone: 'success', title: 'Test sent', detail: 'Check the channel the webhook posts to.' })
      } else {
        reportError('The test was not delivered', result.detail ?? result.error ?? `Server responded ${response.status}`)
      }
    } catch (error) {
      reportError('The test was not delivered', error)
    } finally {
      setBusyId(null)
    }
  }

  const firingCount = alerts.filter(
    alert => alert.enabled && alert.targets.some(entry => entry.state === 'firing')
  ).length

  return (
    <div className="p-6 space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Alerts</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>Get told when a path breaks, instead of finding out here.</span>
            {firingCount > 0 && (
              <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
                {firingCount} firing
              </span>
            )}
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing('new')} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          New alert
        </Button>
      </header>

      {!loaded ? (
        <div className="h-24 animate-pulse rounded-xl border border-border bg-card" />
      ) : alerts.length === 0 ? (
        <section className="rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
          <h2 className="text-sm font-medium text-foreground">No alerts yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            An alert is a condition, such as a target not responding, and the targets to watch for it on.
            Make one, tick the targets it applies to, and choose where it is sent.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setEditing('new')}>
            <Plus className="mr-2 h-4 w-4" />
            New alert
          </Button>
        </section>
      ) : (
        <ul className="space-y-3">
          {alerts.map(alert => {
            const firing = alert.enabled ? alert.targets.filter(entry => entry.state === 'firing') : []
            const isFiring = firing.length > 0
            const busy = busyId === alert.id
            const title = alertTitle(alert)
            const condition = describeCondition(alert)

            return (
              <li
                key={alert.id}
                className={cn(
                  'rounded-xl border bg-card px-5 py-4',
                  isFiring ? 'border-destructive/50' : 'border-border',
                  !alert.enabled && 'opacity-60'
                )}
              >
                <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          isFiring ? 'bg-destructive' : alert.enabled ? 'bg-signal-perfect' : 'bg-muted-foreground'
                        )}
                        aria-hidden="true"
                      />
                      <h2 className="min-w-0 break-words text-sm font-medium text-foreground">{title}</h2>
                      {!alert.enabled && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                          Muted
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {title !== condition && `${condition} · `}
                      {alert.consecutiveProbes === 1
                        ? 'on a single probe'
                        : `for ${alert.consecutiveProbes} probes in a row`}
                      {' · '}
                      {alert.targets.length} target{alert.targets.length === 1 ? '' : 's'}
                      {' · '}
                      {deliveryLabel(alert)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {alert.destination !== 'none' && alert.webhookUrl && (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => sendTest(alert)}>
                        <Send className="mr-1.5 h-3 w-3" />
                        Send test
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggle(alert)}
                      disabled={busy}
                      className="cursor-pointer rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                      aria-label={alert.enabled ? `Mute ${title}` : `Unmute ${title}`}
                      title={alert.enabled ? 'Mute: stop judging and sending this alert' : 'Unmute'}
                    >
                      {alert.enabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(alert)}
                      disabled={busy}
                      className="cursor-pointer rounded p-1.5 transition-colors hover:bg-blue-500/20 disabled:opacity-40"
                      aria-label={`Edit ${title}`}
                    >
                      <Pencil className="h-3.5 w-3.5 text-blue-500" />
                    </button>
                    {confirmingId === alert.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => remove(alert)}
                        onBlur={() => setConfirmingId(null)}
                        autoFocus
                      >
                        Delete?
                      </Button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => remove(alert)}
                        disabled={busy}
                        className="cursor-pointer rounded p-1.5 transition-colors hover:bg-destructive/20 disabled:opacity-40"
                        aria-label={`Delete ${title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>

                {isFiring && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-destructive">Firing on</span>
                    {firing.map(entry => {
                      const target = targetsById.get(entry.targetId)
                      if (!target) return null
                      return (
                        <button
                          key={entry.targetId}
                          type="button"
                          onClick={() => onSelectTarget(entry.targetId)}
                          title={`Open ${target.name}`}
                          className="cursor-pointer rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-destructive/20"
                        >
                          {target.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={open => { if (!open) setEditing(null) }}>
        <DialogContent className="bg-card border-border sm:max-w-xl max-h-[90vh] overflow-y-auto" suppressHydrationWarning>
          {editing !== null && (
            <>
              <DialogHeader>
                <DialogTitle className="text-card-foreground flex items-center gap-2">
                  <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Bell className="h-4 w-4 text-primary" />
                  </div>
                  {editing === 'new' ? 'New alert' : 'Edit alert'}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  One condition, watched on every target you tick. Each target fires and clears on its own.
                </DialogDescription>
              </DialogHeader>

              <AlertForm
                key={editing === 'new' ? 'new' : editing.id}
                alert={editing === 'new' ? null : editing}
                targets={targets}
                groupOrders={groupOrders}
                saving={saving}
                onSubmit={save}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
