'use client'

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { LoaderCircle, Play } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Switch } from '@/components/arc/switch/switch'
import { SegmentedField } from '@/components/segmented-field'
import { useToast } from '@/components/notifications'
import type { MaintenanceFrequency, MaintenanceNotify, MaintenanceProgress, MaintenanceReport, MaintenanceSettings, MaintenanceStep } from '@/lib/db/maintenance'
import { followMaintenance, onMaintenanceEnd, useMaintenanceRun, type MaintenanceRun, type PlannedStep } from './maintenance-run'
import { inDisplayZone } from '@/lib/time-zone'

/**
 * Settings → Maintenance: a button to run it now, each step ticking over as it
 * runs, how the last runs went, and the schedule it runs on.
 */

interface Overview {
  settings: MaintenanceSettings
  history: MaintenanceReport[]
  nextRunAt: number | null
  running: MaintenanceProgress | null
  steps: PlannedStep[]
  alerts: { id: string; name: string; destinations: number }[]
  serverTimeZone: string
}

const HINT = 'text-xs leading-relaxed text-muted-foreground'
const SECTION_TITLE = 'text-sm font-medium text-card-foreground'

const FREQUENCIES: { value: MaintenanceFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

const NOTIFY: { value: MaintenanceNotify; label: string }[] = [
  { value: 'problems', label: 'Only if there is a problem' },
  { value: 'always', label: 'After every run' },
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, day) => ({ value: String(day), label }))
const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, '0')}:00` }))
const NO_ALERT = 'none'

const STATUS: Record<MaintenanceStep['status'], { label: string; tone?: 'success' | 'warning' | 'danger' }> = {
  ok: { label: 'Fine', tone: 'success' },
  fixed: { label: 'Cleaned up', tone: 'warning' },
  problem: { label: 'Problem', tone: 'danger' },
  skipped: { label: 'Skipped' },
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' })) : 'never'
}

async function call(method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch('/api/maintenance', {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: response.ok, body: await response.json().catch(() => ({})) }
}

function SwitchRow({ checked, onChange, label, detail }: { checked: boolean; onChange: (on: boolean) => void; label: string; detail: ReactNode }) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5 pt-2.5">
        <p id={`${id}-title`} className={SECTION_TITLE}>{label}</p>
        <div id={`${id}-detail`} className={HINT}>{detail}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} />
    </div>
  )
}

/**
 * Every step, one row each: how it went once done, a spinner on the one under
 * way, and the rest waiting their turn.
 */
function StepList({ planned, done, current }: { planned: PlannedStep[]; done: MaintenanceStep[]; current: string | null }) {
  const byId = new Map(done.map(step => [step.id, step]))
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {planned.map(({ id, label }) => {
        const step = byId.get(id)
        const running = !step && id === current
        return (
          <li key={id} className="flex min-h-[52px] items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className={`text-sm ${step || running ? 'text-card-foreground' : 'text-muted-foreground'}`}>{label}</p>
              {step && <p className={HINT}>{step.detail}</p>}
            </div>
            <span className="shrink-0">
              {step ? (
                <Badge tone={STATUS[step.status].tone} size="sm">{STATUS[step.status].label}</Badge>
              ) : running ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                  Working
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Waiting</span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Live({ run }: { run: MaintenanceRun }) {
  const label = run.steps.find(step => step.id === run.current)?.label
  return (
    <div className="space-y-3">
      <div className="space-y-1.5" role="status">
        <div className="flex justify-between gap-3 text-xs text-muted-foreground">
          <span>{label ? `${label}…` : 'Finishing…'}</span>
          <span className="tabular-nums">{run.shown.length} of {run.steps.length}</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Maintenance progress"
          aria-valuemin={0}
          aria-valuemax={run.steps.length}
          aria-valuenow={run.shown.length}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${(run.shown.length / run.steps.length) * 100}%` }}
          />
        </div>
      </div>
      <StepList planned={run.steps} done={run.shown} current={run.current} />
    </div>
  )
}

function Report({ report, planned }: { report: MaintenanceReport; planned: PlannedStep[] }) {
  // A report from before a step was added has no row for it; one from before a
  // step was dropped keeps its own.
  const steps = [...planned, ...report.steps.filter(step => !planned.some(item => item.id === step.id))]
  return (
    <div className="space-y-3">
      <p className="text-sm text-card-foreground">
        Last run {when(report.startedAt)}, {report.trigger === 'schedule' ? 'on schedule' : 'started by hand'}:{' '}
        {report.ok ? 'passed' : 'found a problem'}
        {report.removed > 0 ? `, ${report.removed.toLocaleString()} row${report.removed === 1 ? '' : 's'} cleaned up` : ''}.
      </p>
      <StepList planned={steps.filter(step => report.steps.some(item => item.id === step.id))} done={report.steps} current={null} />
      {report.notified && (
        <p className={HINT}>
          {report.notified.ok ? 'The report was sent through the alert chosen.' : `The report could not be sent: ${report.notified.detail ?? 'unknown reason'}.`}
        </p>
      )}
    </div>
  )
}

export function MaintenanceTab() {
  const { notify, reportError } = useToast()
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const run = useMaintenanceRun()

  const load = useCallback(async () => {
    const { ok, body } = await call('GET')
    if (!ok) return setError(String(body.error ?? 'Could not load maintenance'))
    setData(body as unknown as Overview)
  }, [])

  useEffect(() => {
    // Loaded when the tab opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  // A run already under way (the schedule's, or one started in another tab)
  // is followed like one started here.
  const underWay = data?.running?.startedAt
  const planned = data?.steps
  useEffect(() => {
    if (underWay && planned) followMaintenance(underWay, planned)
  }, [underWay, planned])

  // Once a run ends, its report is the newest in the history.
  useEffect(() => onMaintenanceEnd(() => void load()), [load])

  const runNow = async () => {
    if (!data) return
    setStarting(true)
    const { ok, body } = await call('POST')
    setStarting(false)
    if (!ok) return reportError('Could not start maintenance', body.error)
    followMaintenance(Number(body.startedAt), data.steps)
  }

  const change = async (changes: Partial<Omit<MaintenanceSettings, 'updatedAt'>>) => {
    if (!data) return
    const { updatedAt: _updatedAt, ...current } = data.settings
    void _updatedAt
    const { ok, body } = await call('PUT', { ...current, ...changes })
    if (!ok) return reportError('Could not save the schedule', body.error)
    setData(body as unknown as Overview)
    notify({ tone: 'success', title: 'Saved' })
  }

  if (error) return <Alert tone="danger" title="Could not load maintenance">{error}</Alert>
  if (!data) return <Skeleton label="Loading maintenance" lines={5} />

  const { settings, history, alerts } = data
  const last = history[0]
  const running = !!run || !!data.running
  const chosenAlert = alerts.find(alert => alert.id === settings.alertId)

  return (
    <div className="space-y-8 text-foreground">
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className={SECTION_TITLE}>Run it now</h3>
            <p className={HINT}>Safe at any time: probing carries on while it runs, and you can leave this page.</p>
          </div>
          <Button type="button" onClick={runNow} disabled={running || starting}>
            <Play size={16} strokeWidth={1.75} aria-hidden="true" />
            {running ? 'Running…' : 'Run now'}
          </Button>
        </div>

        {run ? (
          <Live run={run} />
        ) : last ? (
          <Report report={last} planned={data.steps} />
        ) : (
          <StepList planned={data.steps} done={[]} current={null} />
        )}
      </section>

      <section className="space-y-5">
        <h2 className={SECTION_TITLE}>Schedule</h2>

        <SwitchRow
          checked={settings.enabled}
          onChange={enabled => change({ enabled })}
          label="Run on a schedule"
          detail={
            settings.enabled && data.nextRunAt
              ? `Next run ${when(data.nextRunAt)}.`
              : 'Off. Maintenance only runs when you press Run now.'
          }
        />

        {settings.enabled && (
          <>
            <SegmentedField
              label="How often"
              value={settings.frequency}
              onValueChange={value => change({ frequency: value as MaintenanceFrequency })}
              options={FREQUENCIES}
            />

            {settings.frequency !== 'daily' && (
              <div className="max-w-xs space-y-1">
                <Select
                  label={settings.frequency === 'weekly' ? 'Day' : 'Day of the month'}
                  value={String(settings.weekday)}
                  onValueChange={value => change({ weekday: Number(value) })}
                  options={
                    settings.frequency === 'weekly'
                      ? WEEKDAYS
                      : WEEKDAYS.map(day => ({ value: day.value, label: `First ${day.label} of the month` }))
                  }
                />
              </div>
            )}

            <div className="max-w-xs space-y-1">
              <Select
                label="Starts at"
                value={String(settings.hour)}
                onValueChange={value => change({ hour: Number(value) })}
                options={HOURS}
              />
              <p className={HINT}>In the server&apos;s time zone ({data.serverTimeZone}). Pick an hour when nobody is looking.</p>
            </div>
          </>
        )}

        <div className="max-w-md space-y-1">
          <Select
            label="Send the report through"
            value={settings.alertId ?? NO_ALERT}
            onValueChange={value => change({ alertId: value === NO_ALERT ? null : value })}
            options={[
              { value: NO_ALERT, label: 'Nothing, show it here only' },
              ...alerts.map(alert => ({
                value: alert.id,
                label: `${alert.name}${alert.destinations === 0 ? ' (nowhere to send to)' : ''}`,
              })),
            ]}
          />
          <p className={HINT}>
            The report goes to the same places as that alert&apos;s notifications, so a scheduled run that finds a problem tells
            someone.
          </p>
          {chosenAlert && chosenAlert.destinations === 0 && (
            <p className="text-xs text-destructive">That alert has no notification URLs, so nothing can be sent. Add one on the Alerts page.</p>
          )}
        </div>

        {chosenAlert && (
          <SegmentedField
            label="Send the report"
            value={settings.notify}
            onValueChange={value => change({ notify: value as MaintenanceNotify })}
            options={NOTIFY}
          />
        )}

        <SwitchRow
          checked={settings.reclaimSpace}
          onChange={reclaimSpace => change({ reclaimSpace })}
          label="Reclaim disk space"
          detail="Deleted rows leave empty space in the database file. With this on, a run rewrites the file to give it back once a fifth of it is empty. Probes wait while it does, and it needs free disk about the size of the database."
        />
      </section>

      {history.length > 1 && (
        <section className="space-y-2">
          <h2 className={SECTION_TITLE}>Earlier runs</h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {history.slice(1).map(report => (
              <li key={report.startedAt} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="text-card-foreground">
                  {when(report.startedAt)} · {report.trigger === 'schedule' ? 'scheduled' : 'by hand'}
                </span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {report.removed > 0 && <span>{report.removed.toLocaleString()} removed</span>}
                  <Badge tone={report.ok ? 'success' : 'danger'} size="sm">{report.ok ? 'No problems' : 'Problem'}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
