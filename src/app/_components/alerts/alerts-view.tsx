'use client'

import { useMemo, useState, type CSSProperties } from 'react'
import { Bell, BellOff, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { Alert as Notice } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Card } from '@/components/arc/card/card'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { NumberField } from '@/components/arc/number-field/number-field'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Switch } from '@/components/arc/switch/switch'
import { Textarea } from '@/components/arc/textarea/textarea'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { useToast } from '@/components/notifications'
import { alertTitle, describeCondition, notifyUrlLabel, parseNotifyUrls } from '@/lib/alerts/delivery'
import { cn } from '@/lib/utils'
import { PANE, PANE_TITLE } from '../dashboard/pane-layout'
import { PageFrame } from '../targets/target-page'
import { TargetChecklist } from '../sidebar/target-checklist'
import type { Alert, AlertMetric, AlertTargetState, GroupOrder, Target } from '@/types/probe'
import {
  ALERT_METRIC_LABELS,
  DEFAULT_TRACE_COOLDOWN_MINUTES,
  MAX_TRACE_COOLDOWN_MINUTES,
  TRACEABLE_ALERT_METRICS,
  tracesByDefault,
} from '@/types/probe'

/**
 * Every alert in one place.
 *
 * Alerts used to be set on each target's own page, one target at a time, so
 * "tell me when anything stops responding" meant making the same rule again
 * for every target and keeping the copies in step by hand. An alert is now
 * made once, here, and ticked for the targets it should watch.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

/** The edge of an alert's card while it fires, and while it is on and quiet. */
const FIRING_EDGE = { '--border': 'var(--danger)', '--border-strong': 'var(--danger)' }
const ON_EDGE = {
  '--border': 'color-mix(in oklab, var(--success) 45%, transparent)',
  '--border-strong': 'color-mix(in oklab, var(--success) 70%, transparent)',
}

/**
 * What an alert is doing, first thing on its card: firing, on and watching,
 * or muted. The switch says whether it is on, but a switch in the corner of
 * every card looks the same from across the room, firing or not.
 */
function AlertState({ enabled, firing, watching }: { enabled: boolean; firing: number; watching: number }) {
  const dot = (pulse: boolean) => (
    <span className={cn('size-1.5 rounded-full bg-current', pulse && 'motion-safe:animate-pulse')} aria-hidden="true" />
  )
  if (firing > 0) return <Badge tone="danger" icon={dot(true)}>Firing on {firing}</Badge>
  if (enabled) {
    return <Badge tone="success" icon={dot(false)}>On · watching {watching} target{watching === 1 ? '' : 's'}</Badge>
  }
  return <Badge icon={<BellOff size={12} strokeWidth={2} aria-hidden />}>Muted: not judged or sent</Badge>
}

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

/** Where an alert goes, by the names of the services and never by their URLs. */
function deliveryLabel(alert: Pick<AlertResponse, 'notifyUrls'>): string {
  if (alert.notifyUrls.length === 0) return 'Shown here only'
  return `Sent to ${[...new Set(alert.notifyUrls.map(notifyUrlLabel))].join(', ')}`
}

/** Every service Apprise can send to, and how the URL for each is written. */
const APPRISE_SERVICES = 'https://appriseit.com/services/'

// ─── Editor ─────────────────────────────────────────────────────────────────

interface AlertPayload {
  name: string
  metric: AlertMetric
  threshold: number
  consecutiveProbes: number
  notifyUrls: string[]
  traceOnFire: boolean
  traceCooldownMinutes: number
  targetIds: string[]
}

/** "every 15 minutes", "every 2 hours": the pause between traces, as said on an alert's card. */
function cooldownLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return hours === 1 ? 'once an hour' : `every ${hours} hours`
  }
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`
}

const SECTION_TITLE = 'text-sm font-medium text-card-foreground'

function AlertForm({
  alert,
  targets,
  groupOrders,
  saving,
  onSubmit,
  onCancel,
}: {
  /** The alert being edited; absent for a new one. */
  alert: AlertResponse | null
  targets: Target[]
  groupOrders: GroupOrder[]
  saving: boolean
  onSubmit: (payload: AlertPayload) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(alert?.name ?? '')
  const [metric, setMetric] = useState<AlertMetric>(alert?.metric ?? 'unreachable')
  const [threshold, setThreshold] = useState(alert ? alert.threshold : Number(DEFAULT_THRESHOLD.unreachable))
  const [consecutiveProbes, setConsecutiveProbes] = useState(alert?.consecutiveProbes ?? 3)
  const [notifyUrls, setNotifyUrls] = useState((alert?.notifyUrls ?? []).join('\n'))
  const [traceOnFire, setTraceOnFire] = useState(alert?.traceOnFire ?? tracesByDefault('unreachable'))
  const [traceCooldownMinutes, setTraceCooldownMinutes] = useState(alert?.traceCooldownMinutes ?? DEFAULT_TRACE_COOLDOWN_MINUTES)
  // A new alert traces or not by what it watches, until someone says which.
  const [traceChosen, setTraceChosen] = useState(alert !== null)
  const [selected, setSelected] = useState(() => new Set(alert?.targets.map(entry => entry.targetId) ?? []))
  const [attempted, setAttempted] = useState(false)

  const urls = parseNotifyUrls(notifyUrls)
  const traceable = TRACEABLE_ALERT_METRICS.includes(metric)

  const problems = [
    metric !== 'unreachable' && (!Number.isFinite(threshold) || threshold < 0) && 'The threshold must be a number, zero or more.',
    (!Number.isInteger(consecutiveProbes) || consecutiveProbes < 1 || consecutiveProbes > 100) &&
      'The number of probes must be between 1 and 100.',
    traceable && traceOnFire &&
      (!Number.isInteger(traceCooldownMinutes) || traceCooldownMinutes < 1 || traceCooldownMinutes > MAX_TRACE_COOLDOWN_MINUTES) &&
      `The wait between traces must be from 1 to ${MAX_TRACE_COOLDOWN_MINUTES} minutes.`,
    !urls && 'Each notification URL must be an Apprise URL, such as discord://… or mailto://…, on a line of its own.',
    selected.size === 0 && 'Tick at least one target for the alert to watch.',
  ].filter((problem): problem is string => !!problem)

  const watch = (next: AlertMetric) => {
    setMetric(next)
    if (!traceChosen) setTraceOnFire(tracesByDefault(next))
  }

  const applyPreset = (preset: Preset) => {
    watch(preset.metric)
    setThreshold(preset.threshold)
    setConsecutiveProbes(preset.consecutiveProbes)
  }

  const handleSubmit = () => {
    if (problems.length > 0) {
      setAttempted(true)
      return
    }
    onSubmit({
      name: name.trim(),
      metric,
      threshold: metric === 'unreachable' ? 0 : threshold,
      consecutiveProbes,
      notifyUrls: urls ?? [],
      traceOnFire: traceable && traceOnFire,
      traceCooldownMinutes,
      targetIds: [...selected],
    })
  }

  const condition = describeCondition({ metric, threshold: Number.isFinite(threshold) ? threshold : 0 })
  const labels = ALERT_METRIC_LABELS[metric]

  return (
    <form className="space-y-8" noValidate onSubmit={event => { event.preventDefault(); handleSubmit() }}>
      {/* Condition */}
      <fieldset className="space-y-4">
        <legend className={`${SECTION_TITLE} pb-2`}>Alert when</legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Common alerts">
          {PRESETS.map(preset => {
            const active = metric === preset.metric && (preset.metric === 'unreachable' || threshold === preset.threshold)
            return (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant={active ? 'primary' : 'secondary'}
                aria-pressed={active}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </Button>
            )
          })}
        </div>

        <Select
          id="alert-metric"
          label="Watching"
          value={metric}
          onValueChange={value => {
            const next = value as AlertMetric
            watch(next)
            setThreshold(Number(DEFAULT_THRESHOLD[next]))
            if (next === 'certExpiry') setConsecutiveProbes(1)
          }}
          options={(Object.keys(ALERT_METRIC_LABELS) as AlertMetric[]).map(option => ({ value: option, label: ALERT_METRIC_LABELS[option].label }))}
        />

        <div className="grid items-start gap-4 sm:grid-cols-2">
          {metric !== 'unreachable' && (
            <NumberField
              id="alert-threshold"
              label={labels.comparison === 'below' ? 'Under' : 'Above'}
              suffix={labels.unit}
              min={0}
              max={100000}
              step={1}
              formatOptions={{ maximumFractionDigits: 1 }}
              value={threshold}
              onValueChange={setThreshold}
            />
          )}
          <NumberField
            id="alert-consecutive"
            label="For this many probes in a row"
            min={1}
            max={100}
            value={consecutiveProbes}
            onValueChange={setConsecutiveProbes}
          />
        </div>
        {metric === 'certExpiry' && (
          <p className="text-xs text-muted-foreground">
            Only HTTPS targets have a certificate to watch. On anything else this alert never fires.
          </p>
        )}
      </fieldset>

      {/* Tracing. Not offered for a certificate, which is not on the path. */}
      {traceable && (
        <fieldset className="space-y-4">
          <legend className={`${SECTION_TITLE} pb-2`}>When it fires</legend>
          <Checkbox
            id="alert-trace"
            label="Trace the route"
            description="Records the path to the target hop by hop at the moment it goes wrong, which is usually the only time the broken route can be seen. It appears under Route on the target, ready to copy or share."
            checked={traceOnFire}
            onCheckedChange={checked => {
              setTraceOnFire(checked === true)
              setTraceChosen(true)
            }}
          />
          {traceOnFire && (
            <div className="space-y-2">
              <NumberField
                id="alert-trace-cooldown"
                label="Then wait at least"
                suffix=" minutes"
                min={1}
                max={MAX_TRACE_COOLDOWN_MINUTES}
                step={5}
                value={traceCooldownMinutes}
                onValueChange={setTraceCooldownMinutes}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Before tracing the same target again on an alert. A link that keeps dropping out fires again and again, and
                one trace each spell of trouble is what shows where; more only adds load to a path that is already struggling.
              </p>
            </div>
          )}
        </fieldset>
      )}

      {/* Delivery */}
      <fieldset className="space-y-3">
        <legend className={`${SECTION_TITLE} pb-2`}>Send it to</legend>
        {/* A box of lines rather than one field: an alert can go to several
            places at once, and each is one URL. */}
        <Textarea
          id="alert-notify-urls"
          label="Notification URLs (optional)"
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={'discord://webhook_id/webhook_token\nmailto://user:password@gmail.com'}
          value={notifyUrls}
          onChange={e => setNotifyUrls(e.target.value)}
          error={urls ? undefined : 'Each line must be one Apprise URL, such as discord://… or mailto://….'}
          style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {urls?.length === 0 ? (
            <>Left empty, nothing is sent: a firing alert is shown on this screen and counted beside the Alerts button. </>
          ) : (
            <>Each one is sent a message when the alert fires and when it clears. </>
          )}
          One{' '}
          <a href={APPRISE_SERVICES} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
            Apprise URL
          </a>{' '}
          to a line, for any service Apprise supports: Discord, Slack, Telegram, email, ntfy, Teams and the rest. A plain
          webhook is <code className="font-mono">json://</code> or <code className="font-mono">jsons://</code> in place
          of http:// or https://.
        </p>
      </fieldset>

      {/* Targets */}
      <fieldset className="space-y-3">
        <legend className={`${SECTION_TITLE} pb-2`}>On these targets</legend>
        {targets.length === 0 ? (
          <p className="text-xs text-muted-foreground">There are no targets yet. Add one from the sidebar first.</p>
        ) : (
          <TargetChecklist targets={targets} groupOrders={groupOrders} selected={selected} onChange={setSelected} />
        )}
      </fieldset>

      {/* Name */}
      <Input id="alert-name" label="Name (optional)" placeholder={condition} value={name} onChange={e => setName(e.target.value)} maxLength={80} />

      <div className="space-y-3">
        {attempted && problems.length > 0 && <Notice tone="danger" title="Not saved yet">{problems[0]}</Notice>}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving} aria-disabled={problems.length > 0}>
            {alert ? 'Save changes' : 'Create alert'}
          </Button>
        </div>
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
  /** The account signed in may look but not change anything: the alerts are shown, not offered for editing. */
  readOnly?: boolean
  /**
   * The alert whose form is open in place of the list: `'new'`, or an
   * alert's id. Null for the list. Part of the address (/alerts/new,
   * /alerts/<id>/edit), so a form can be reloaded and left with Back.
   */
  editor: 'new' | string | null
  onOpenEditor: (which: 'new' | string) => void
  onCloseEditor: () => void
}

/** `'new'` for an alert that does not exist yet. */
type Editing = AlertResponse | 'new' | null

/**
 * The list of alerts, or the form for one in its place. The form used to be
 * a panel sliding in over the right edge of the page: narrow, cut off from
 * the list behind it, and gone at a reload. It is a page of the pane now,
 * like adding a target.
 */
export function AlertsView({
  alerts,
  loaded,
  targets,
  groupOrders,
  onChanged,
  onSelectTarget,
  readOnly = false,
  editor,
  onOpenEditor,
  onCloseEditor,
}: AlertsViewProps) {
  const { notify, reportError } = useToast()
  const editing: Editing = editor === null ? null : editor === 'new' ? 'new' : alerts.find(alert => alert.id === editor) ?? null
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

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
      onCloseEditor()
      notify({ tone: 'success', title: existing ? 'Alert saved' : 'Alert created', detail: alertTitle(payload) })
    }
  }

  const toggle = async (alert: AlertResponse) => {
    setBusyId(alert.id)
    await request(`/api/alerts/${alert.id}`, 'PATCH', 'Could not update the alert', { enabled: !alert.enabled })
    setBusyId(null)
  }

  // Deleting asks first, in place: an alert ticked for twenty targets is a
  // lot to rebuild after a slip of the hand.
  const remove = async (alert: AlertResponse) => {
    setBusyId(alert.id)
    const deleted = await request(`/api/alerts/${alert.id}`, 'DELETE', 'Could not delete the alert')
    setBusyId(null)
    if (!deleted) throw new Error('Not deleted')
  }

  const sendTest = async (alert: AlertResponse) => {
    setBusyId(alert.id)
    try {
      const response = await fetch(`/api/alerts/${alert.id}/test`, { method: 'POST' })
      const result = await response.json().catch(() => ({}))
      if (response.ok && result.ok) {
        notify({ tone: 'success', title: 'Test sent', detail: 'Check wherever its notification URLs deliver to.' })
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

  if (editor !== null) {
    if (readOnly) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState
            title="This account can look but not change"
            description="Ask an admin or editor to make or change alerts."
            action={<Button type="button" onClick={onCloseEditor}>Back to the alerts</Button>}
          />
        </div>
      )
    }
    if (!loaded) {
      return (
        <div className={PANE}>
          <Skeleton label="Loading the alert" lines={4} />
        </div>
      )
    }
    if (editing === null) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState
            title="That alert is not here"
            description="It may have been deleted."
            action={<Button type="button" onClick={onCloseEditor}>Back to the alerts</Button>}
          />
        </div>
      )
    }

    return (
      <PageFrame
        title={editing === 'new' ? 'New alert' : `Edit ${alertTitle(editing)}`}
        description="One condition, watched on every target you tick. Each target fires and clears on its own."
        onBack={onCloseEditor}
      >
        <AlertForm
          key={editing === 'new' ? 'new' : editing.id}
          alert={editing === 'new' ? null : editing}
          targets={targets}
          groupOrders={groupOrders}
          saving={saving}
          onSubmit={save}
          onCancel={onCloseEditor}
        />
      </PageFrame>
    )
  }

  return (
    <div className={PANE}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className={PANE_TITLE}>Alerts</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>Get told when a path breaks, instead of finding out here.</span>
            {firingCount > 0 && <Badge tone="danger" size="sm">{firingCount} firing</Badge>}
          </p>
        </div>
        {!readOnly && (
          <Button size="sm" onClick={() => onOpenEditor('new')}>
            <Plus {...ICON} />
            New alert
          </Button>
        )}
      </header>

      {!loaded ? (
        <Skeleton label="Loading the alerts" lines={3} />
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={<Bell size={24} strokeWidth={1.75} />}
          title="No alerts yet"
          description="An alert is a condition, such as a target not responding, and the targets to watch for it on. Make one, tick the targets it applies to, and choose where it is sent."
          action={
            readOnly ? undefined : (
              <Button onClick={() => onOpenEditor('new')}>
                <Plus {...ICON} />
                New alert
              </Button>
            )
          }
        />
      ) : (
        <ul className="grid gap-4 @4xl/main:grid-cols-2">
          {alerts.map(alert => {
            const firing = alert.enabled ? alert.targets.filter(entry => entry.state === 'firing') : []
            const isFiring = firing.length > 0
            const busy = busyId === alert.id
            const title = alertTitle(alert)
            const condition = describeCondition(alert)

            return (
              // Muted is set back, so what is on stands out from what is not;
              // pointing at it brings it forward to be worked on.
              <li key={alert.id} className={cn('transition-opacity', !alert.enabled && 'opacity-60 focus-within:opacity-100 hover:opacity-100')}>
                <Card
                  // Arc's card draws its edge in --border: red while firing,
                  // a touch of green while on and quiet, the usual grey muted.
                  style={(isFiring ? FIRING_EDGE : alert.enabled ? ON_EDGE : undefined) as CSSProperties | undefined}
                  title={title}
                  description={[
                    title !== condition ? condition : null,
                    alert.consecutiveProbes === 1 ? 'on a single probe' : `for ${alert.consecutiveProbes} probes in a row`,
                    `${alert.targets.length} target${alert.targets.length === 1 ? '' : 's'}`,
                    deliveryLabel(alert),
                    alert.traceOnFire && TRACEABLE_ALERT_METRICS.includes(alert.metric)
                      ? `Traces the route, at most ${cooldownLabel(alert.traceCooldownMinutes)}`
                      : null,
                  ].filter(Boolean).join(' · ')}
                  action={
                    readOnly ? undefined : (
                      <span className="flex flex-wrap items-center gap-1">
                        {alert.notifyUrls.length > 0 && (
                          <Button variant="secondary" size="sm" loading={busy} onClick={() => sendTest(alert)}>
                            <Send {...ICON} />
                            Send test
                          </Button>
                        )}
                        <Tooltip content={alert.enabled ? 'Mute: stop judging and sending this alert' : 'Unmute'}>
                          <Switch
                            checked={alert.enabled}
                            disabled={busy}
                            onCheckedChange={() => toggle(alert)}
                            aria-label={alert.enabled ? `Mute ${title}` : `Unmute ${title}`}
                          />
                        </Tooltip>
                        <Tooltip content="Edit">
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenEditor(alert.id)} aria-label={`Edit ${title}`}>
                            <Pencil {...ICON} />
                          </Button>
                        </Tooltip>
                        <ConfirmMorph
                          label="Delete"
                          icon={<Trash2 {...ICON} />}
                          prompt={`Delete ${title}?`}
                          confirmLabel="Delete"
                          doneLabel="Deleted"
                          disabled={busy}
                          onConfirm={() => remove(alert)}
                        />
                      </span>
                    )
                  }
                >
                  <div className="flex flex-wrap items-center gap-2" role="status">
                    <AlertState enabled={alert.enabled} firing={firing.length} watching={alert.targets.length} />
                    {isFiring && firing.map(entry => {
                        const target = targetsById.get(entry.targetId)
                        if (!target) return null
                        return (
                          <Tooltip key={entry.targetId} content={`Open ${target.name}`}>
                            <Button variant="danger" size="sm" onClick={() => onSelectTarget(entry.targetId)}>
                              {target.name}
                            </Button>
                          </Tooltip>
                        )
                      })}
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
