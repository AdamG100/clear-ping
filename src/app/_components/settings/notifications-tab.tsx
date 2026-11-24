'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { useToast } from '@/components/notifications'
import type { NotificationSender } from '@/lib/alerts/sender'

/**
 * Settings → Notifications: the name and picture alerts are posted with. A
 * chat that takes them from each message (Discord, Guilded) shows them; any
 * other service keeps its own.
 */

const HINT = 'text-xs leading-relaxed text-muted-foreground'

export function NotificationsTab() {
  const { notify, reportError } = useToast()
  const [saved, setSaved] = useState<NotificationSender | null>(null)
  const [name, setName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/notifications', { cache: 'no-store' }).catch(() => null)
    const body = await response?.json().catch(() => null)
    if (!response?.ok) return setError(body?.error ?? 'Could not load the notification settings')
    const sender = body.sender as NotificationSender
    setSaved(sender)
    setName(sender.name ?? '')
    setAvatarUrl(sender.avatarUrl ?? '')
  }, [])

  useEffect(() => {
    // Loaded when the tab opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setProblem(null)
    try {
      const response = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { name, avatarUrl } }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 400 && body?.error) return setProblem(body.error)
        return reportError('Could not save the notification settings', body?.error)
      }
      const sender = body.sender as NotificationSender
      setSaved(sender)
      setName(sender.name ?? '')
      setAvatarUrl(sender.avatarUrl ?? '')
      notify({ tone: 'success', title: 'Saved', detail: 'Notifications are posted this way from now on. Send a test from an alert to see one.' })
    } catch (failure) {
      reportError('Could not save the notification settings', failure)
    } finally {
      setSaving(false)
    }
  }

  if (error) return <Alert tone="danger" title="Could not load Notifications">{error}</Alert>
  if (!saved) return <Skeleton label="Loading Notifications" lines={3} />

  const changed = name !== (saved.name ?? '') || avatarUrl !== (saved.avatarUrl ?? '')

  return (
    <form className="max-w-xl space-y-5" onSubmit={save} noValidate>
      <div className="space-y-1">
        <p className="text-sm font-medium text-card-foreground">Posted as</p>
        <p className={HINT}>
          The name and picture shown beside each alert in Discord and Guilded. Leave either empty to keep the
          webhook&apos;s own name, and Apprise&apos;s red and green icons. Other services, such as email, Slack or
          Telegram, show what they are set up with.
        </p>
      </div>

      <Input
        label="Name"
        placeholder="The webhook's own name"
        value={name}
        maxLength={80}
        onChange={event => setName(event.target.value)}
      />
      <Input
        label="Picture"
        type="url"
        placeholder="https://example.com/logo.png"
        description="The web address of a square PNG or JPEG that Discord can fetch from the internet."
        value={avatarUrl}
        onChange={event => setAvatarUrl(event.target.value)}
      />

      {problem && <Alert tone="danger" title="Not saved">{problem}</Alert>}

      <div>
        <Button type="submit" loading={saving} disabled={!changed}>
          Save
        </Button>
      </div>
    </form>
  )
}
