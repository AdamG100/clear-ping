'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { inDisplayZone } from '@/lib/time-zone'
import type { AlertHistoryEvent } from '@/types/alert-rules'
import { Masked } from '../privacy/masked'

/**
 * An alert's history: each time a monitor started or stopped firing, with the
 * conditions as they stood and which probes agreed, so what made it fire is
 * read here rather than guessed at.
 */
export function AlertHistory({ alertId, title, onClose }: { alertId: string | null; title: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ id: string; events: AlertHistoryEvent[] | null } | null>(null)

  useEffect(() => {
    if (!alertId) return
    let current = true
    fetch(`/api/alerts/${alertId}/events`)
      .then(response => (response.ok ? response.json() : null))
      .catch(() => null)
      .then(data => { if (current) setLoaded({ id: alertId, events: data?.events ?? null }) })
    return () => { current = false }
  }, [alertId])

  const events = loaded?.id === alertId ? loaded.events : undefined

  return (
    <Dialog open={alertId !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent title={`History of ${title}`} description="Each time a monitor started or stopped firing, and why.">
        {events === undefined ? (
          <Skeleton label="Loading the history" lines={3} />
        ) : events === null ? (
          <p className="text-sm text-muted-foreground">The history could not be read.</p>
        ) : events.length === 0 ? (
          <EmptyState title="Nothing yet" description="It fires and clears are listed here as they happen." />
        ) : (
          <ul className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {events.map(event => (
              <li key={event.id} className="space-y-1.5 rounded-2xl border border-border bg-background p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Badge size="sm" tone={event.transition === 'firing' ? 'danger' : 'success'}>{event.transition === 'firing' ? 'Fired' : 'Cleared'}</Badge>
                    <span className="font-medium text-foreground"><Masked text value={event.targetName} /></span>
                  </span>
                  <time className="text-xs text-muted-foreground" dateTime={new Date(event.at).toISOString()}>
                    {new Date(event.at).toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' }))}
                  </time>
                </div>
                <p className="text-xs text-muted-foreground">{event.reason}</p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {event.conditions.map(condition => (
                    <li key={condition.label}>
                      {condition.label}: {condition.observed ?? 'no reading'}, {condition.held ? 'held' : 'not held'}
                    </li>
                  ))}
                </ul>
                {event.probes.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    {event.probes.map(probe => `${probe.name} ${probe.silent ? 'not reporting' : probe.breaching ? 'in breach' : 'fine'}`).join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
