'use client'

import { useMemo, useState } from 'react'
import { Bell, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { Alert as Notice } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Card } from '@/components/arc/card/card'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Drawer, DrawerContent } from '@/components/arc/drawer/drawer'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { NumberField } from '@/components/arc/number-field/number-field'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Switch } from '@/components/arc/switch/switch'
import { Textarea } from '@/components/arc/textarea/textarea'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { useToast } from '@/components/notifications'
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

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

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

const SECTION_TITLE = 'text-sm font-medium text-card-foreground'

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
  const [threshold, setThreshold] = useState(alert ? alert.threshold : Number(DEFAULT_THRESHOLD.unreachable))
  const [consecutiveProbes, setConsecutiveProbes] = useState(alert?.consecutiveProbes ?? 3)
  const [notifyUrls, setNotifyUrls] = useState((alert?.notifyUrls ?? []).join('\n'))
  const [selected, setSelected] = useState(() => new Set(alert?.targets.map(entry => entry.targetId) ?? []))
  const [attempted, setAttempted] = useState(false)

  const urls = parseNotifyUrls(notifyUrls)

  const problems = [
    metric !== 'unreachable' && (!Number.isFinite(threshold) || threshold < 0) && 'The threshold must be a number, zero or more.',
    (!Number.isInteger(consecutiveProbes) || consecutiveProbes < 1 || consecutiveProbes > 100) &&
      'The number of probes must be between 1 and 100.',
    !urls && 'Each notification URL must be an Apprise URL, such as discord://… or mailto://…, on a line of its own.',
    selected.size === 0 && 'Tick at least one target for the alert to watch.',
  ].filter((problem): problem is string => !!problem)

  const applyPreset = (preset: Preset) => {
    setMetric(preset.metric)
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
            setMetric(next)
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
        <Button type="submit" className="w-full" loading={saving} aria-disabled={problems.length > 0}>
          {alert ? 'Save changes' : 'Create alert'}
        </Button>
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
          <Button size="sm" onClick={() => setEditing('new')}>
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
              <Button onClick={() => setEditing('new')}>
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
              <li key={alert.id}>
                <Card
                  title={title}
                  description={[
                    title !== condition ? condition : null,
                    alert.consecutiveProbes === 1 ? 'on a single probe' : `for ${alert.consecutiveProbes} probes in a row`,
                    `${alert.targets.length} target${alert.targets.length === 1 ? '' : 's'}`,
                    deliveryLabel(alert),
                  ].filter(Boolean).join(' · ')}
                  status={isFiring ? `Firing on ${firing.length}` : alert.enabled ? 'Watching' : 'Muted'}
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
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(alert)} aria-label={`Edit ${title}`}>
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
                  {isFiring && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="danger" size="sm">Firing on</Badge>
                      {firing.map(entry => {
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
                  )}
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      <Drawer open={editing !== null} onOpenChange={open => { if (!open) setEditing(null) }}>
        <DrawerContent
          title={editing === 'new' ? 'New alert' : 'Edit alert'}
          description="One condition, watched on every target you tick. Each target fires and clears on its own."
        >
          {editing !== null && (
            <AlertForm
              key={editing === 'new' ? 'new' : editing.id}
              alert={editing === 'new' ? null : editing}
              targets={targets}
              groupOrders={groupOrders}
              saving={saving}
              onSubmit={save}
            />
          )}
        </DrawerContent>
      </Drawer>
    </div>
  )
}
