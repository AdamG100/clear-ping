'use client'

import { useState } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { SearchField } from '@/components/arc/search-field/search-field'
import { Masked } from '../privacy/masked'
import { PROBE_AGENT_STATE } from '../settings/probe-agent-labels'
import { LOCAL_PROBE, DEFAULT_LOCAL_PROBE_NAME } from '@/types/probe-agent'
import type { ProbeAgentSummary, ProbeId, ProbeSummary } from '@/types/probe-agent'
import { cn } from '@/lib/utils'

/** The local probe, then each probe agent, as the pickers list them. */
export function probeSummaries(agents: ProbeAgentSummary[], localName: string = DEFAULT_LOCAL_PROBE_NAME): ProbeSummary[] {
  return [
    { id: LOCAL_PROBE, name: localName, local: true, state: 'online' },
    ...agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      local: false,
      state: agent.state,
      exposure: agent.exposure,
      address: agent.address,
      hostname: agent.hostname,
      lastSeenAt: agent.lastSeenAt,
    })),
  ]
}

/** Past this many probes, a search narrows the list and it scrolls. */
const SEARCH_AFTER = 5

/**
 * Which probes measure a monitor: a checklist of the local probe and each
 * probe agent, with at least one ticked. The first ticked is the primary
 * probe, the one the page opens on. Shared by the monitor form, the group
 * dialog and comparisons.
 */
export function ProbeChecklist({
  idPrefix,
  probes,
  value,
  onChange,
  /** Probes some, but not all, of what is being set have: shown part-ticked. */
  partial = [],
}: {
  idPrefix: string
  probes: ProbeSummary[]
  value: ProbeId[]
  onChange: (probes: ProbeId[]) => void
  partial?: ProbeId[]
}) {
  const [search, setSearch] = useState('')
  const many = probes.length > SEARCH_AFTER
  const query = search.trim().toLowerCase()
  const shown = probes.filter(
    probe =>
      !query ||
      value.includes(probe.id) ||
      [probe.name, probe.address ?? '', probe.hostname ?? ''].some(text => text.toLowerCase().includes(query))
  )

  const toggle = (id: ProbeId, on: boolean) => {
    if (on) onChange([...value.filter(probe => probe !== id), id])
    // At least one stays: a monitor measured from nowhere takes no readings.
    else if (value.length > 1 || partial.length > 0) onChange(value.filter(probe => probe !== id))
  }

  return (
    <div className="space-y-3">
      {many && (
        <SearchField
          label="Find a probe"
          placeholder={`Search ${probes.length} probes`}
          value={search}
          onValueChange={setSearch}
        />
      )}
      <ul className={cn('space-y-2', many && 'max-h-80 overflow-y-auto p-0.5')}>
        {shown.map(probe => {
          const checked = value.includes(probe.id)
          const state = PROBE_AGENT_STATE[probe.state]
          return (
            <li key={probe.id} className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-background px-3 py-2.5">
              <Checkbox
                id={`${idPrefix}-probe-${probe.id}`}
                checked={checked ? true : partial.includes(probe.id) ? 'indeterminate' : false}
                onCheckedChange={next => toggle(probe.id, next === true)}
                label={probe.name}
                description={probe.local ? 'Where this dashboard runs' : probe.hostname ?? probe.address}
              />
              <span className="flex shrink-0 items-center gap-1.5">
                {checked && value.length > 1 && value[0] === probe.id && <Badge size="sm" tone="info">Primary</Badge>}
                {probe.state !== 'online' && <Badge size="sm" tone={state.tone}>{state.label}</Badge>}
              </span>
            </li>
          )
        })}
      </ul>
      {query && shown.length === 0 && <p className="text-xs text-muted-foreground">No probe matches &ldquo;{search.trim()}&rdquo;.</p>}
    </div>
  )
}

/** Where a probe's address is shown, masked when addresses are hidden. */
export function ProbeAddress({ probe }: { probe: ProbeSummary }) {
  return probe.local ? <>Where this dashboard runs</> : <Masked value={probe.hostname ?? probe.address ?? ''} />
}
