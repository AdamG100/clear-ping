'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { useToast } from '@/components/notifications'
import { HINT, send } from './probe-agent-details'

/**
 * How long a probe agent may go without answering before it is offline. The
 * dashboard asks each one how it is every minute; this is the silence it puts
 * up with, so one dropped check does not send a notification.
 */
export function ProbeHeartbeat() {
  const { notify, reportError } = useToast()
  const [saved, setSaved] = useState<number | null>(null)
  const [minutes, setMinutes] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    fetch('/api/probe-agents')
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (!current || typeof data?.offlineAfterMinutes !== 'number') return
        setSaved(data.offlineAfterMinutes)
        setMinutes(String(data.offlineAfterMinutes))
      })
      .catch(() => {})
    return () => { current = false }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/probes/heartbeat', 'PATCH', { offlineAfterMinutes: Number(minutes) })
    setBusy(false)
    if (!ok) return reportError('Could not save the time', String(body.error ?? 'Try again'))
    const next = Number(body.offlineAfterMinutes)
    setSaved(next)
    setMinutes(String(next))
    notify({ tone: 'success', title: 'Saved' })
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Offline after</h3>
        <p className={`${HINT} mt-1 max-w-xl`}>
          The dashboard asks every probe agent how it is once a minute. One that has not answered for this many minutes is marked
          offline. To be told when that happens, tick &ldquo;Also tell these URLs when a probe agent goes offline&rdquo; under More
          options on an alert.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Input label="Minutes" type="number" min={1} max={60} value={minutes} onChange={event => setMinutes(event.target.value)} />
        </div>
        <Button type="submit" size="sm" loading={busy} disabled={saved === null || minutes === String(saved)}>Save</Button>
      </div>
    </form>
  )
}
