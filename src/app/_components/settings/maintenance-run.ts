'use client'

import { useSyncExternalStore } from 'react'
import type { MaintenanceProgress, MaintenanceReport, MaintenanceStep } from '@/lib/db/maintenance'

/**
 * A maintenance run being followed from this page: how far it has got, and
 * how it ended.
 *
 * Kept outside any one component so it carries on while the person moves to
 * another page: Settings shows the steps ticking over, and the toast (mounted
 * with the dashboard) says how it went wherever they are by then.
 *
 * A small database gets through every step in well under a second, which read
 * as nothing happening at all. So the steps finished are shown one at a time,
 * each for long enough to be seen, however fast the server was.
 */

const ASK_EVERY_MS = 800
const SHOW_EACH_MS = 320

export interface PlannedStep {
  id: string
  label: string
}

export interface MaintenanceRun {
  startedAt: number
  steps: PlannedStep[]
  /** The steps finished, as far as they have been shown. */
  shown: MaintenanceStep[]
  /** The id of the step shown as under way; null once every one is shown. */
  current: string | null
}

/** How a run ended: its report, or null where it stopped without one. */
export type MaintenanceOutcome = { run: MaintenanceRun; report: MaintenanceReport | null }

let run: MaintenanceRun | null = null
let finished: MaintenanceStep[] = []
let ended: { report: MaintenanceReport | null } | null = null
let asking: ReturnType<typeof setInterval> | undefined
let showing: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()
const endListeners = new Set<(outcome: MaintenanceOutcome) => void>()

function emit(next: MaintenanceRun | null) {
  run = next
  for (const listener of listeners) listener()
}

function stop() {
  clearInterval(asking)
  clearInterval(showing)
  asking = showing = undefined
}

async function ask(startedAt: number) {
  const response = await fetch('/api/maintenance', { cache: 'no-store' }).catch(() => null)
  if (!response?.ok || run?.startedAt !== startedAt) return
  const body = (await response.json().catch(() => null)) as { running: MaintenanceProgress | null; history: MaintenanceReport[] } | null
  if (!body || run?.startedAt !== startedAt) return

  if (body.running?.startedAt === startedAt) {
    finished = body.running.finished
    return
  }
  const report = body.history.find(item => item.startedAt === startedAt) ?? null
  finished = report?.steps ?? finished
  ended = { report }
  clearInterval(asking)
  asking = undefined
}

function showNext() {
  if (!run) return
  if (run.shown.length < finished.length) {
    const shown = finished.slice(0, run.shown.length + 1)
    emit({ ...run, shown, current: run.steps[shown.length]?.id ?? null })
    return
  }
  if (!ended) return

  const outcome = { run: { ...run, current: null }, report: ended.report }
  stop()
  ended = null
  finished = []
  emit(null)
  for (const listener of endListeners) listener(outcome)
}

/** Follow the run that started at `startedAt`. Following it already, this does nothing. */
export function followMaintenance(startedAt: number, steps: PlannedStep[]) {
  if (run?.startedAt === startedAt) return
  stop()
  finished = []
  ended = null
  emit({ startedAt, steps, shown: [], current: steps[0]?.id ?? null })
  void ask(startedAt)
  asking = setInterval(() => void ask(startedAt), ASK_EVERY_MS)
  showing = setInterval(showNext, SHOW_EACH_MS)
}

/** Called with how each followed run ended, once all its steps have been shown. */
export function onMaintenanceEnd(listener: (outcome: MaintenanceOutcome) => void): () => void {
  endListeners.add(listener)
  return () => endListeners.delete(listener)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The run being followed, or null. */
export function useMaintenanceRun(): MaintenanceRun | null {
  return useSyncExternalStore(subscribe, () => run, () => null)
}
