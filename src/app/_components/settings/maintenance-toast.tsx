'use client'

import { useEffect } from 'react'
import { useToast } from '@/components/notifications'
import { onMaintenanceEnd, useMaintenanceRun, type MaintenanceOutcome } from './maintenance-run'

/**
 * A toast for a maintenance run started from this page: how far it has got
 * while it runs, then whether it passed. Mounted with the dashboard, not with
 * Settings, so it still says how it went after the person has moved on.
 */

const plural = (count: number, one: string) => `${count.toLocaleString()} ${one}${count === 1 ? '' : 's'}`

function ending({ report }: MaintenanceOutcome) {
  if (!report) {
    return { tone: 'error' as const, title: 'Maintenance stopped part way', detail: 'The server log says why. Nothing it had already done is undone.' }
  }
  const problems = report.steps.filter(step => step.status === 'problem')
  if (problems.length > 0) {
    return {
      tone: 'error' as const,
      title: problems.length === 1 ? 'Maintenance found a problem' : `Maintenance found ${problems.length} problems`,
      detail: `${problems[0].label}: ${problems[0].detail}`,
    }
  }
  if (report.notified && !report.notified.ok) {
    return { tone: 'warning' as const, title: 'Maintenance passed, but the report was not sent', detail: report.notified.detail }
  }
  return {
    tone: 'success' as const,
    title: 'Maintenance passed',
    detail: report.removed > 0 ? `Cleaned up ${plural(report.removed, 'row')}.` : 'Everything was already in order.',
  }
}

export function MaintenanceToast() {
  const { notify } = useToast()
  const run = useMaintenanceRun()

  const id = run ? `maintenance-${run.startedAt}` : null
  const done = run?.shown.length ?? 0
  const total = run?.steps.length ?? 0
  useEffect(() => {
    if (!id) return
    notify({ id, tone: 'loading', title: 'Running maintenance', detail: `${done} of ${total} steps done` })
  }, [id, done, total, notify])

  useEffect(
    () => onMaintenanceEnd(outcome => notify({ id: `maintenance-${outcome.run.startedAt}`, ...ending(outcome) })),
    [notify]
  )

  return null
}
