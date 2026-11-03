'use client'

import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { TextShimmer } from '@/components/arc/text-shimmer/text-shimmer'
import type { UpgradeProgress } from '@/lib/db/upgrade-progress'

/** Where to go back to once the database is open: the page that was asked for. */
function nextPage(): string {
  const next = new URLSearchParams(window.location.search).get('next') ?? '/'
  // Only somewhere on this site.
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/upgrading') ? next : '/'
}

const seconds = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)

/**
 * What the database is doing while it is opened: every change an upgrade
 * makes, with how far through the long ones are. Goes back to the page that
 * was asked for once it is done.
 */
export function UpgradeScreen() {
  const [progress, setProgress] = useState<UpgradeProgress | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await fetch('/api/upgrade', { cache: 'no-store' })
        const data = (await response.json()) as UpgradeProgress
        if (!current) return
        setUnreachable(false)
        setProgress(data)
        setNow(Date.now())
        if (data.phase === 'ready') {
          window.location.replace(nextPage())
          return
        }
      } catch {
        // Restarting, most likely: keep asking.
        if (current) setUnreachable(true)
      }
      if (current) timer = setTimeout(poll, 1000)
    }
    void poll()
    return () => { current = false; clearTimeout(timer) }
  }, [])

  const upgrading = !!progress && progress.steps.length > 0
  const from = progress?.from
  const to = progress?.to

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <div className="w-full max-w-lg space-y-5 rounded-2xl border border-border bg-card p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-medium">{upgrading ? 'Bringing the database up to date' : 'Starting ClearPing'}</h1>
          <p className="text-sm text-muted-foreground">
            {upgrading
              ? `This version of ClearPing needs some changes to the database${from !== undefined && to !== undefined && from < to ? ` (version ${from} to ${to})` : ''}, made once, before anything is shown. Nothing is lost. This page carries on by itself when it is done.`
              : 'Opening the database. This page carries on by itself in a moment.'}
          </p>
        </div>

        {progress?.phase === 'failed' && (
          <Alert tone="danger" title="The database could not be opened">
            {progress.error ?? 'The container log says why.'} Each change is all or nothing, so fix what it says and restart ClearPing.
          </Alert>
        )}
        {unreachable && <p className="text-sm text-muted-foreground">Waiting for the server to answer…</p>}

        {upgrading && (
          <ol className="space-y-2.5" aria-live="polite">
            {progress.steps.map(step => {
              const share = step.total ? Math.min(100, Math.round(((step.done ?? 0) / step.total) * 100)) : null
              return (
                <li key={step.id} className="space-y-1.5">
                  <div className="flex items-start gap-2 text-sm">
                    {step.status === 'done' ? (
                      <Check size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-success" aria-label="Done" />
                    ) : (
                      <Loader2 size={16} strokeWidth={2} className="mt-0.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="In progress" />
                    )}
                    <span className="min-w-0 flex-1">
                      {step.status === 'running' ? <TextShimmer>{step.label}</TextShimmer> : step.label}
                      {step.detail && <span className="text-muted-foreground">: {step.detail}</span>}
                    </span>
                    {share !== null && step.status === 'running' && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{share}%</span>
                    )}
                  </div>
                  {share !== null && step.status === 'running' && (
                    <div className="ml-6 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100} aria-label={step.label}>
                      <div className="h-full rounded-full bg-success transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${share}%` }} />
                    </div>
                  )}
                  {share !== null && step.status === 'running' && (
                    <p className="ml-6 font-mono text-xs text-muted-foreground">
                      {(step.done ?? 0).toLocaleString('en')} of {(step.total ?? 0).toLocaleString('en')}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
        )}

        {progress && <p className="font-mono text-xs text-muted-foreground">{seconds(now - progress.startedAt)} so far</p>}
      </div>
    </main>
  )
}
