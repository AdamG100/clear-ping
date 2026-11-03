'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { CircleCheck, Pencil } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { useToast } from '@/components/notifications'
import { DEFAULT_LOCAL_PROBE_NAME } from '@/types/probe-agent'
import { HINT, ICON, send } from './probe-agent-details'

/**
 * The local probe, which is where this dashboard runs: always there, always
 * online, and called "Local probe" until it is named for the place it is.
 * The name is what every monitor, chart, alert and report calls it.
 */
export function LocalProbe({ version, oldestCheck, onRenamed }: {
  /** The dashboard's version, which is the local probe's too. */
  version?: string
  /** Said at the end of the row: how long ago the probe agents were last heard from. */
  oldestCheck?: ReactNode
  onRenamed?: (name: string) => void
}) {
  const { notify, reportError } = useToast()
  const [saved, setSaved] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState(false)
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

  const cancel = () => {
    setName(saved ?? '')
    setEditing(false)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/probes/local', 'PATCH', { name: name.trim() })
    setBusy(false)
    if (!ok) return reportError('Could not rename the local probe', String(body.error ?? 'Try again'))
    const next = String(body.name ?? DEFAULT_LOCAL_PROBE_NAME)
    setSaved(next)
    setName(next)
    setEditing(false)
    onRenamed?.(next)
    notify({ tone: 'success', title: `The local probe is now called ${next}` })
  }

  const shown = saved ?? DEFAULT_LOCAL_PROBE_NAME
  return (
    <div className="space-y-3 rounded-2xl border border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="min-w-0 truncate text-sm font-medium">{shown}</span>
        <span className="text-sm text-muted-foreground">
          {shown === DEFAULT_LOCAL_PROBE_NAME ? 'Where this dashboard runs' : 'The local probe, where this dashboard runs'}
        </span>
        <Badge size="sm" tone="success" icon={<CircleCheck size={11} strokeWidth={2} aria-hidden />}>
          Always probes
        </Badge>
        {version && (
          <span className="text-xs text-muted-foreground">
            Version <span className="font-mono">{version}</span>
          </span>
        )}
        {!editing && (
          <Button type="button" size="sm" variant="ghost" disabled={saved === null} onClick={() => setEditing(true)}>
            <Pencil {...ICON} />
            Rename
          </Button>
        )}
        {oldestCheck && <span className="ml-auto">{oldestCheck}</span>}
      </div>
      {editing && (
        <form onSubmit={submit} noValidate className="space-y-2">
          <p className={`${HINT} max-w-xl`}>
            Name it for the place it is, such as Home or Office. Every monitor, chart, alert and report uses
            the name. Leave it empty to go back to {DEFAULT_LOCAL_PROBE_NAME}.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-56">
              <Input
                label="Name"
                value={name}
                onChange={event => setName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Escape') cancel() }}
                maxLength={40}
                placeholder={DEFAULT_LOCAL_PROBE_NAME}
                autoFocus
              />
            </div>
            <Button type="submit" size="sm" loading={busy} disabled={name.trim() === saved}>Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  )
}
