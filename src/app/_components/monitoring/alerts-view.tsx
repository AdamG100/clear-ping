'use client'

import { useMemo, useState } from 'react'
import { Bell, BellOff, Pencil, Plus, Send, Trash2 } from 'lucide-react'
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
import { alertTitle, describeCondition, notifyUrlLabel, parseNotifyUrls } from '@/lib/alert-delivery'
import { PANE, PANE_TITLE } from './pane-layout'
import { TargetChecklist } from './target-checklist'
import type { Alert, AlertMetric, AlertTargetState, GroupOrder, Target } from '@/types/probe'
import { ALERT_METRIC_LABELS } from '@/types/probe'

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
  const [notifyUrls, setNotifyUrls] = useState((alert?.notifyUrls ?? []).join('\n'))
  const [selected, setSelected] = useState(() => new Set(alert?.targets.map(entry => entry.targetId) ?? []))
  const [attempted, setAttempted] = useState(false)

  const urls = parseNotifyUrls(notifyUrls)
  const probes = Number(consecutiveProbes)
  const limit = Number(threshold)

  const problems = [
    metric !== 'unreachable' && (threshold.trim() === '' || !Number.isFinite(limit) || limit < 0) &&
      'The threshold must be a number, zero or more.',
    (!Number.isInteger(probes) || probes < 1 || probes > 100) && 'The number of probes must be between 1 and 100.',
    !urls && 'Each notification URL must be an Apprise URL, such as discord://… or mailto://…, on a line of its own.',
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
      notifyUrls: urls ?? [],
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
                  'cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors touch:py-2.5',
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
        <div className="space-y-1.5">
          <Label htmlFor="alert-notify-urls" className={FIELD_LABEL}>Notification URLs (optional)</Label>
          {/* A box of lines rather than one field: an alert can go to several
              places at once, and each is one URL. */}
          <textarea
            id="alert-notify-urls"
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={'discord://webhook_id/webhook_token\nmailto://user:password@gmail.com'}
            value={notifyUrls}
            onChange={e => setNotifyUrls(e.target.value)}
            aria-invalid={!urls}
            aria-describedby="alert-notify-urls-hint"
            className={cn(
              'w-full min-w-0 resize-y rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground',
              'placeholder:text-muted-foreground outline-none transition-[color,box-shadow]',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
              'aria-invalid:border-destructive'
            )}
          />
          <p id="alert-notify-urls-hint" className="text-[11px] text-muted-foreground">
            {urls?.length === 0 ? (
              <>Left empty, nothing is sent: a firing alert is shown on this screen and counted beside the Alerts button. </>
            ) : (
              <>Each one is sent a message when the alert fires and when it clears. </>
            )}
            One{' '}
            <a
              href={APPRISE_SERVICES}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              Apprise URL
            </a>{' '}
            to a line, for any service Apprise supports: Discord, Slack, Telegram, email, ntfy, Teams and the rest.
            A plain webhook is <code className="font-mono">json://</code> or{' '}
            <code className="font-mono">jsons://</code> in place of http:// or https://.
          </p>
        </div>
      </div>

      {/* Targets */}
      <div className="space-y-3">
        <p className={SECTION_LABEL}>On these targets</p>
        {targets.length === 0 ? (
          <p className="text-xs text-muted-foreground">There are no targets yet. Add one from the sidebar first.</p>
        ) : (
          <TargetChecklist targets={targets} groupOrders={groupOrders} selected={selected} onChange={setSelected} />
        )}
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
  /** The account signed in may look but not change anything: the alerts are shown, not offered for editing. */
  readOnly?: boolean
}

/** `'new'` for an alert that does not exist yet. */
type Editing = AlertResponse | 'new' | null

export function AlertsView({ alerts, loaded, targets, groupOrders, onChanged, onSelectTarget, readOnly = false }: AlertsViewProps) {
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

  return (
    <div className={PANE}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className={PANE_TITLE}>Alerts</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>Get told when a path breaks, instead of finding out here.</span>
            {firingCount > 0 && (
              <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
                {firingCount} firing
              </span>
            )}
          </p>
        </div>
        {!readOnly && (
          <Button size="sm" onClick={() => setEditing('new')} className="shrink-0">
            <Plus className="mr-2 h-4 w-4" />
            New alert
          </Button>
        )}
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
          {!readOnly && (
            <Button size="sm" className="mt-4" onClick={() => setEditing('new')}>
              <Plus className="mr-2 h-4 w-4" />
              New alert
            </Button>
          )}
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
                  'rounded-xl border bg-card px-4 py-4 @2xl/main:px-5',
                  isFiring ? 'border-destructive/50' : 'border-border',
                  !alert.enabled && 'opacity-60'
                )}
              >
                <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                  {/* A width to start from, so that where there is not room
                      for it beside the buttons they go underneath. Without
                      one the text gave way instead, down to a column a few
                      words wide. */}
                  <div className="min-w-0 flex-1 basis-64">
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

                  {!readOnly && <div className="flex shrink-0 items-center gap-1">
                    {alert.notifyUrls.length > 0 && (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs touch:h-9 touch:px-3" disabled={busy} onClick={() => sendTest(alert)}>
                        <Send className="mr-1.5 h-3 w-3" />
                        Send test
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggle(alert)}
                      disabled={busy}
                      className="cursor-pointer rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 touch:p-2.5"
                      aria-label={alert.enabled ? `Mute ${title}` : `Unmute ${title}`}
                      data-tip={alert.enabled ? 'Mute: stop judging and sending this alert' : 'Unmute'}
                    >
                      {alert.enabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(alert)}
                      disabled={busy}
                      className="cursor-pointer rounded p-1.5 transition-colors hover:bg-blue-500/20 disabled:opacity-40 touch:p-2.5"
                      aria-label={`Edit ${title}`}
                    >
                      <Pencil className="h-3.5 w-3.5 text-blue-500" />
                    </button>
                    {confirmingId === alert.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2 text-xs touch:h-9 touch:px-3"
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
                        className="cursor-pointer rounded p-1.5 transition-colors hover:bg-destructive/20 disabled:opacity-40 touch:p-2.5"
                        aria-label={`Delete ${title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </div>}
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
                          data-tip={`Open ${target.name}`}
                          className="cursor-pointer rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-destructive/20 touch:px-3 touch:py-1.5"
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
        <DialogContent className="bg-card border-border sm:max-w-xl" suppressHydrationWarning>
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
