'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Select } from '@/components/arc/select/select'
import { useToast } from '@/components/notifications'
import { groupLabel, groupWithAncestors, isWithinGroup } from '@/lib/targets/group-path'
import { probeIdsOf } from '@/lib/targets/probes'
import type { Target } from '@/types/probe'
import { HINT, send } from './probe-agent-details'

const EVERY = '__every__'

/**
 * Measure monitors that already exist from one more probe, such as a probe
 * agent just set up: every monitor, or a group and the groups inside it. Each
 * monitor keeps the probes it has, and its first probe stays its first.
 * With `group`, only that group (and those inside it) is offered.
 */
export function AddProbeToMonitors({ group, onAdded }: { group?: string; onAdded?: () => void }) {
  const { notify, reportError } = useToast()
  const [targets, setTargets] = useState<Target[]>([])
  const [probes, setProbes] = useState<Array<{ id: string; name: string }>>([])
  const [probe, setProbe] = useState('')
  const [scope, setScope] = useState(group ?? EVERY)

  const load = useCallback(async () => {
    const [listed, known] = await Promise.all([
      fetch('/api/targets').then(response => (response.ok ? response.json() : [])).catch(() => []),
      fetch('/api/probe-agents').then(response => (response.ok ? response.json() : null)).catch(() => null),
    ])
    setTargets(Array.isArray(listed) ? listed : [])
    if (known) {
      setProbes([
        { id: known.localProbe.id, name: known.localProbe.name },
        ...known.probeAgents.map((agent: { id: string; name: string }) => ({ id: agent.id, name: agent.name })),
      ])
    }
  }, [])

  useEffect(() => {
    // Loaded once shown, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const groups = useMemo(() => {
    const all = new Set<string>()
    for (const target of targets) if (target.group) groupWithAncestors(target.group).forEach(each => all.add(each))
    return [...all].filter(each => !group || isWithinGroup(each, group)).sort((a, b) => a.localeCompare(b))
  }, [targets, group])

  // The newest probe agent first: the one most likely just added.
  const chosen = probe || probes[probes.length - 1]?.id || ''
  const gaining = targets.filter(target =>
    (scope === EVERY || (target.group && isWithinGroup(target.group, scope))) && !probeIdsOf(target).includes(chosen)
  ).length

  if (probes.length < 2 || targets.length === 0) return null

  const add = async () => {
    const { ok, body } = await send('/api/groups/probe', 'POST', { probe: chosen, ...(scope === EVERY ? {} : { group: scope }) })
    if (!ok) {
      reportError('Could not add the probe', String(body.error ?? 'Try again'))
      throw new Error('Not added')
    }
    const name = probes.find(each => each.id === chosen)?.name ?? 'The probe'
    notify({ tone: 'success', title: `${name} added to ${body.updated} monitor${body.updated === 1 ? '' : 's'}` })
    await load()
    onAdded?.()
  }

  const name = probes.find(each => each.id === chosen)?.name ?? ''
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Add a probe to monitors</h3>
        <p className={`${HINT} mt-1 max-w-xl`}>
          Measure monitors you already have from one more probe, such as a probe agent you have just set up. Each keeps the
          probes it has. Choosing a group includes the groups inside it.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <Select label="Probe" value={chosen} onValueChange={setProbe} options={probes.map(each => ({ value: each.id, label: each.name }))} />
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <Select
            label="Monitors"
            value={scope}
            onValueChange={setScope}
            options={[
              ...(group ? [] : [{ value: EVERY, label: 'Every monitor' }]),
              ...groups.map(each => ({ value: each, label: groupLabel(each) })),
            ]}
          />
        </div>
        <ConfirmMorph
          label="Add"
          prompt={`Add ${name} to ${gaining} monitor${gaining === 1 ? '' : 's'}?`}
          confirmLabel="Add"
          doneLabel="Added"
          pendingLabel="Adding"
          tone="neutral"
          disabled={gaining === 0}
          onConfirm={add}
        />
      </div>
      {gaining === 0 && <p className={HINT}>Every monitor here is already measured from {name}.</p>}
    </section>
  )
}
