'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { useToast } from '@/components/notifications'
import { HINT, send } from './probe-agent-details'
import { Masked } from '../privacy/masked'

type Place = { region: string; network: string }
type Found = { address: string; from: 'address' | 'trace'; countryName: string | null; asn: number | null; network: string | null }

/**
 * Where each probe is: a region and a network. Found from the probe's public
 * address (its country, and the network it is on), and labelled by hand where
 * that is wrong or a broader word suits ("Europe"). An alert can ask that a
 * problem is seen from several regions and networks before it counts, and
 * says where it was seen.
 */
export function ProbePlaces() {
  const { notify, reportError } = useToast()
  const [saved, setSaved] = useState<Record<string, Place>>({})
  const [draft, setDraft] = useState<Record<string, Place>>({})
  const [found, setFound] = useState<Record<string, Found>>({})
  const [lookUp, setLookUp] = useState(true)
  const [loading, setLoading] = useState(true)
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
        setFound(data.found ?? {})
        setLookUp(data.lookUp !== false)
      })
      .catch(() => {})
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [])

  const placeOf = (id: string): Place => draft[id] ?? { region: '', network: '' }
  const savedOf = (id: string): Place => saved[id] ?? { region: '', network: '' }

  const save = async (id: string) => {
    setBusy(id)
    const place = placeOf(id)
    const { ok, body } = await send('/api/security/probes/places', 'PATCH', { probe: id, region: place.region, network: place.network })
    setBusy(null)
    if (!ok) return reportError('Could not save where the probe is', String(body.error ?? 'Try again'))
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
        <p className={`${HINT} mt-1 max-w-2xl`}>
          Each probe&apos;s country and network are found from its public address: a probe agent&apos;s own address when the
          dashboard reaches it at a public one, or else the first router on the internet in its newest route trace. An alert
          can then ask that a problem is seen from several regions and networks before it counts, so one provider&apos;s fault
          is told apart from the monitor going down, and says where it was seen. Type a region or network to replace what was
          found, for a probe behind a VPN, or to group places more broadly, such as Europe. Clear it to go back to what was found.
        </p>
        {!lookUp && (
          <p className={`${HINT} mt-1 max-w-2xl`}>
            Nothing is found while Settings → Privacy → &ldquo;Look up who runs each address&rdquo; is off. Type each one in instead.
          </p>
        )}
      </div>
      <ul className="space-y-4">
        {probes.map(probe => {
          const place = placeOf(probe.id)
          const seen = found[probe.id]
          const changed = place.region !== savedOf(probe.id).region || place.network !== savedOf(probe.id).network
          const network = seen?.network ? `${seen.network}${seen.asn ? ` (AS${seen.asn})` : ''}` : seen?.asn ? `AS${seen.asn}` : ''
          return (
            <li key={probe.id} className="space-y-1.5">
              <div className="flex flex-wrap items-end gap-2">
                <span className="w-32 shrink-0 truncate pb-2 text-sm text-foreground">{probe.name}</span>
                <div className="min-w-0 flex-1 basis-40">
                  <Input
                    label="Region"
                    value={place.region}
                    maxLength={40}
                    placeholder={seen?.countryName ?? (loading ? 'Looking it up' : 'Not found')}
                    onChange={event => setDraft(current => ({ ...current, [probe.id]: { ...placeOf(probe.id), region: event.target.value } }))}
                  />
                </div>
                <div className="min-w-0 flex-1 basis-40">
                  <Input
                    label="Network"
                    value={place.network}
                    maxLength={40}
                    placeholder={seen?.network ?? (loading ? 'Looking it up' : 'Not found')}
                    onChange={event => setDraft(current => ({ ...current, [probe.id]: { ...placeOf(probe.id), network: event.target.value } }))}
                  />
                </div>
                <Button size="sm" loading={busy === probe.id} disabled={!changed} onClick={() => save(probe.id)}>Save</Button>
              </div>
              {lookUp && !loading && (
                <p className="text-xs text-muted-foreground sm:pl-34">
                  {seen ? (
                    <>
                      Found {[seen.countryName, network].filter(Boolean).join(', ') || 'nothing'} from{' '}
                      <span className="font-mono"><Masked value={seen.address} /></span>
                      {seen.from === 'address' ? ', its own address' : ', the first router on the internet in its newest route trace'}.
                    </>
                  ) : (
                    'Not found yet: it has no public address, and no route has been traced from it. Trace a route from it on any monitor’s page.'
                  )}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
