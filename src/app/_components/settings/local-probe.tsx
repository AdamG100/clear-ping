'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { useToast } from '@/components/notifications'
import { DEFAULT_LOCAL_PROBE_NAME } from '@/types/probe-agent'
import { HINT, send } from './probe-agent-details'

/**
 * The local probe, which is where this dashboard runs: always there, always
 * online, and called "Local probe" until it is named for the place it is.
 */
export function LocalProbe({ onRenamed }: { onRenamed?: (name: string) => void }) {
  const { notify, reportError } = useToast()
  const [saved, setSaved] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    fetch('/api/probe-agents')
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (!current || typeof data?.localProbe?.name !== 'string') return
        setSaved(data.localProbe.name)
        setName(data.localProbe.name)
      })
      .catch(() => {})
    return () => { current = false }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/probes/local', 'PATCH', { name: name.trim() })
    setBusy(false)
    if (!ok) return reportError('Could not rename the local probe', String(body.error ?? 'Try again'))
    const next = String(body.name ?? DEFAULT_LOCAL_PROBE_NAME)
    setSaved(next)
    setName(next)
    onRenamed?.(next)
    notify({ tone: 'success', title: 'Local probe renamed' })
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Local probe</h3>
        <p className={`${HINT} mt-1 max-w-xl`}>
          Where this dashboard runs. It measures every monitor that has it ticked, and is called this wherever readings say
          where they were taken. Name it for the place it is, such as the office.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <Input label="Name" value={name} onChange={event => setName(event.target.value)} maxLength={40} placeholder={DEFAULT_LOCAL_PROBE_NAME} />
        </div>
        <Button type="submit" size="sm" loading={busy} disabled={saved === null || name.trim() === saved}>Save</Button>
      </div>
    </form>
  )
}
