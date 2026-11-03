'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { useToast } from '@/components/notifications'
import { HINT, send } from './probe-agent-details'

type Place = { region: string; network: string }

/**
 * Where each probe is: a region ("Europe") and a network ("Example Networks"),
 * in whatever words suit. An alert can ask that a problem is seen from several
 * regions and networks before it counts, and says where it was seen.
 */
export function ProbePlaces() {
  const { notify, reportError } = useToast()
  const [saved, setSaved] = useState<Record<string, Place>>({})
  const [draft, setDraft] = useState<Record<string, Place>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [probes, setProbes] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    let current = true
    fetch('/api/probe-agents')
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (!current || !data) return
        setProbes([
          { id: data.localProbe.id, name: data.localProbe.name },
          ...data.probeAgents.map((agent: { id: string; name: string }) => ({ id: agent.id, name: agent.name })),
        ])
      })
      .catch(() => {})
    fetch('/api/security/probes/places')
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (!current || !data?.places) return
        const next: Record<string, Place> = {}
        for (const [id, place] of Object.entries<{ region?: string; network?: string }>(data.places)) next[id] = { region: place.region ?? '', network: place.network ?? '' }
        setSaved(next)
        setDraft(next)
      })
      .catch(() => {})
    return () => { current = false }
  }, [])

  const placeOf = (id: string): Place => draft[id] ?? { region: '', network: '' }
  const savedOf = (id: string): Place => saved[id] ?? { region: '', network: '' }

  const save = async (id: string) => {
    setBusy(id)
    const place = placeOf(id)
    const { ok, body } = await send('/api/security/probes/places', 'PATCH', { probe: id, region: place.region, network: place.network })
    setBusy(null)
    if (!ok) return reportError('Could not save the labels', String(body.error ?? 'Try again'))
    const stored = (body.place ?? {}) as { region?: string; network?: string }
    const next = { region: stored.region ?? '', network: stored.network ?? '' }
    setSaved(current => ({ ...current, [id]: next }))
    setDraft(current => ({ ...current, [id]: next }))
    notify({ tone: 'success', title: 'Saved' })
  }

  if (probes.length < 2) return null

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Where each probe is</h3>
        <p className={`${HINT} mt-1 max-w-xl`}>
          Label a probe with its region and network, such as Europe and Example Networks. An alert can then ask that a problem is
          seen from at least three regions and three networks before it counts, and says where it was seen.
        </p>
      </div>
      <ul className="space-y-3">
        {probes.map(probe => {
          const place = placeOf(probe.id)
          const changed = place.region !== savedOf(probe.id).region || place.network !== savedOf(probe.id).network
          return (
            <li key={probe.id} className="flex flex-wrap items-end gap-2">
              <span className="w-32 shrink-0 truncate pb-2 text-sm text-foreground">{probe.name}</span>
              <div className="min-w-0 flex-1 basis-40">
                <Input label="Region" value={place.region} maxLength={40} onChange={event => setDraft(current => ({ ...current, [probe.id]: { ...placeOf(probe.id), region: event.target.value } }))} />
              </div>
              <div className="min-w-0 flex-1 basis-40">
                <Input label="Network" value={place.network} maxLength={40} onChange={event => setDraft(current => ({ ...current, [probe.id]: { ...placeOf(probe.id), network: event.target.value } }))} />
              </div>
              <Button size="sm" loading={busy === probe.id} disabled={!changed} onClick={() => save(probe.id)}>Save</Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
