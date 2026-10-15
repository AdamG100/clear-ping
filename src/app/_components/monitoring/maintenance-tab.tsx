'use client'

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Switch } from '@/components/arc/switch/switch'
import { SegmentedField } from '@/components/segmented-field'
import { useToast } from '@/components/notifications'
import type { MaintenanceFrequency, MaintenanceNotify, MaintenanceReport, MaintenanceSettings, MaintenanceStep } from '@/lib/maintenance'

/**
 * Settings → Maintenance: what the clean-up does, a button to run it now, how
 * the last runs went, and the schedule it runs on.
 */

interface Overview {
  settings: MaintenanceSettings
  history: MaintenanceReport[]
  nextRunAt: number | null
  running: { step: string; done: number; total: number } | null
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

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, '0')}:00` }))
const NO_ALERT = 'none'

const STATUS: Record<MaintenanceStep['status'], { label: string; tone?: 'success' | 'warning' | 'danger' }> = {
  ok: { label: 'Fine', tone: 'success' },
  fixed: { label: 'Cleaned up', tone: 'warning' },
  problem: { label: 'Problem', tone: 'danger' },
  skipped: { label: 'Skipped' },
}

/** What the run looks at, shown before it has ever run. */
const WHAT_IT_DOES = [
  'Checks the database file for damage.',
  'Removes history, saved routes and alert ticks that belong to targets or alerts that no longer exist.',
  'Puts groups and their saved order right, so every target has a place in the sidebar.',
  'Frees targets that were marked as probed in the future, which a wrong clock leaves unprobed.',
  'Removes measurements and routes older than the retention window.',
  'Folds the write-ahead log back in, refreshes the query statistics, and reloads the probe scheduler.',
]

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'
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

function Report({ report }: { report: MaintenanceReport }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-card-foreground">
        {report.trigger === 'schedule' ? 'Scheduled run' : 'Run by hand'} on {when(report.startedAt)}:{' '}
        {report.ok ? 'no problems' : 'a problem was found'}
        {report.removed > 0 ? `, ${report.removed.toLocaleString()} row${report.removed === 1 ? '' : 's'} removed` : ''}.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {report.steps.map(step => (
          <li key={step.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-card-foreground">{step.label}</p>
              <p className={HINT}>{step.detail}</p>
            </div>
            <span className="shrink-0 pt-0.5">
              <Badge tone={STATUS[step.status].tone} size="sm">{STATUS[step.status].label}</Badge>
            </span>
          </li>
        ))}
      </ul>
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

  // While a run is under way, how far it has got; when it ends, how it went.
  const running = !!data?.running
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void load(), 1500)
    return () => clearInterval(timer)
  }, [running, load])

  const runNow = async () => {
    setStarting(true)
    const { ok, body } = await call('POST')
    setStarting(false)
    if (!ok) return reportError('Could not start maintenance', body.error)
    await load()
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

  const { settings, history, running: progress, alerts } = data
  const last = history[0]
  const chosenAlert = alerts.find(alert => alert.id === settings.alertId)

  return (
    <div className="space-y-8 text-foreground">
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className={SECTION_TITLE}>Clean up and check ClearPing</h2>
            <p className={HINT}>
              Removes what no longer belongs, and checks that what ClearPing keeps itself on is in order. Safe to run at any time: it only
              takes away rows that point at nothing, or are past their retention, and probing carries on while it runs.
            </p>
          </div>
          <Button type="button" onClick={runNow} disabled={running || starting}>
            <Play size={16} strokeWidth={1.75} aria-hidden="true" />
            {running ? 'Running' : 'Run now'}
          </Button>
        </div>

        {progress && (
          <div className="space-y-1.5" role="status">
            <div className="flex justify-between gap-3 text-xs text-muted-foreground">
              <span>{progress.step}</span>
              <span className="tabular-nums">{progress.done} of {progress.total}</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Maintenance progress"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {last ? (
          <Report report={last} />
        ) : (
          <ul className={`${HINT} list-disc space-y-1 pl-5`}>
            {WHAT_IT_DOES.map(item => <li key={item}>{item}</li>)}
          </ul>
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
              ? `Next run: ${when(data.nextRunAt)}.`
              : 'Off: maintenance runs only when you run it.'
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

            <div className="max-w-xs space-y-1">
              <Select
                label="Starts at"
                value={String(settings.hour)}
                onValueChange={value => change({ hour: Number(value) })}
                options={HOURS}
              />
              <p className={HINT}>By the clock of the machine ClearPing runs on ({data.serverTimeZone}). Pick a quiet hour.</p>
            </div>
          </>
        )}

        <div className="max-w-md space-y-1">
          <Select
            label="Send the report through the alert"
            value={settings.alertId ?? NO_ALERT}
            onValueChange={value => change({ alertId: value === NO_ALERT ? null : value })}
            options={[
              { value: NO_ALERT, label: 'None: show it here only' },
              ...alerts.map(alert => ({
                value: alert.id,
                label: `${alert.name}${alert.destinations === 0 ? ' (nowhere to send to)' : ''}`,
              })),
            ]}
          />
          <p className={HINT}>
            The report goes where that alert sends its own notifications, so a scheduled run that finds something is not only
            visible if someone opens this page.
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
          detail="Rewrites the database file to give back the room that deleted rows leave in it, when a fifth of it is empty. Nothing can write to the database while it runs, so probes wait, and it needs free disk about the size of the database. Best left for a quiet hour."
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
