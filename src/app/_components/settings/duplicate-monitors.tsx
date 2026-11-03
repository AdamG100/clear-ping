'use client'

import { useCallback, useEffect, useState } from 'react'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Select } from '@/components/arc/select/select'
import { useToast } from '@/components/notifications'
import { groupLabel } from '@/lib/targets/group-path'
import type { DuplicateSet } from '@/lib/targets/merge'
import { Masked } from '../privacy/masked'
import { HINT, send } from './probe-agent-details'

/**
 * Monitors made before a monitor could have several probes: the same host
 * watched from each place as a monitor of its own. Offered for merging, never
 * merged unasked: they may have been kept apart on purpose.
 */
export function DuplicateMonitors() {
  const { notify, reportError } = useToast()
  const [sets, setSets] = useState<DuplicateSet[]>([])
  // Which monitor of each set is kept, by the set's key; the first until chosen.
  const [kept, setKept] = useState<Record<string, string>>({})
  const [probeNames, setProbeNames] = useState<ReadonlyMap<string, string>>(new Map())

  const load = useCallback(async () => {
    const [merging, probes] = await Promise.all([fetch('/api/targets/merge').catch(() => null), fetch('/api/probe-agents').catch(() => null)])
    if (merging?.ok) setSets((await merging.json()).sets ?? [])
    if (probes?.ok) {
      const data = await probes.json()
      setProbeNames(new Map([[data.localProbe?.id ?? 'local', data.localProbe?.name ?? 'Local probe'], ...(data.probeAgents ?? []).map((agent: { id: string; name: string }) => [agent.id, agent.name] as [string, string])]))
    }
  }, [])

  useEffect(() => {
    // Loaded when the tab opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (sets.length === 0) return null

  const merge = async (set: DuplicateSet, quiet = false) => {
    const keep = kept[set.key] ?? set.monitors[0].id
    const { ok, body } = await send('/api/targets/merge', 'POST', { keep, merge: set.monitors.map(monitor => monitor.id).filter(id => id !== keep) })
    if (!ok) {
      reportError('Could not merge the monitors', String(body.error ?? 'Try again'))
      throw new Error('Not merged')
    }
    if (quiet) return
    notify({ tone: 'success', title: 'Monitors merged', detail: 'One monitor, measured from each probe.' })
    await load()
  }

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Monitors set up once for each probe</h3>
        <p className={`${HINT} mt-1 max-w-xl`}>
          These measure the same thing from different probes. Merging makes each one monitor measured from all of them, with
          each probe&apos;s readings kept apart, and takes up one row in the sidebar. Nothing is merged unless you ask.
        </p>
      </div>
      <ul className="space-y-3">
        {sets.length > 1 && (
          <li className="flex justify-end">
            <ConfirmMorph
              label={`Merge all ${sets.length}`}
              prompt={`Merge ${sets.length} sets, each keeping the monitor chosen?`}
              confirmLabel="Merge all"
              doneLabel="Merged"
              pendingLabel="Merging"
              tone="neutral"
              onConfirm={async () => {
                for (const set of sets) await merge(set, true)
                notify({ tone: 'success', title: `${sets.length} sets merged`, detail: 'Each is one monitor, measured from each probe.' })
                await load()
              }}
            />
          </li>
        )}
        {sets.map(set => {
          const keep = kept[set.key] ?? set.monitors[0].id
          return (
            <li key={set.key} className="space-y-2 rounded-2xl border border-border bg-background p-3">
              <p className="text-sm text-foreground">
                <Masked text value={set.monitors[0].host} />
              </p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {set.monitors.map(monitor => (
                  <li key={monitor.id}>
                    <Masked text value={monitor.name} />
                    {monitor.group ? ` in ${groupLabel(monitor.group)}` : ''}, every {monitor.interval} seconds, from{' '}
                    {monitor.probes.map(probe => probeNames.get(probe) ?? 'a removed probe agent').join(', ')}
                  </li>
                ))}
              </ul>
              {set.settingsDiffer && (
                <p className="text-xs text-muted-foreground">Their settings are not all the same: the merged monitor keeps those of the one below.</p>
              )}
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0 basis-64">
                  <Select
                    label="Keep the name, group, interval and settings of"
                    value={keep}
                    onValueChange={value => setKept(current => ({ ...current, [set.key]: value }))}
                    options={set.monitors.map(monitor => ({ value: monitor.id, label: monitor.name }))}
                  />
                </div>
                <ConfirmMorph
                  label="Merge"
                  prompt={`Merge ${set.monitors.length} monitors?`}
                  confirmLabel="Merge"
                  doneLabel="Merged"
                  pendingLabel="Merging"
                  tone="neutral"
                  onConfirm={() => merge(set)}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
