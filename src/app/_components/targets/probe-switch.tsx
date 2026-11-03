'use client'

import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Select } from '@/components/arc/select/select'
import type { ProbeId, ProbeSummary } from '@/types/probe-agent'

/** The value that stands for every probe at once, drawn against each other. */
export const COMPARE_PROBES = 'compare'

/** Past this many probes the switch is a list to pick from rather than buttons. */
const BUTTONS_UP_TO = 4

/**
 * Which probe's readings a monitor's page shows: each of its probes in full,
 * or all of them against each other. Only for a monitor measured from more
 * than one.
 */
export function ProbeSwitch({
  probes,
  value,
  onChange,
}: {
  probes: ProbeSummary[]
  /** A probe's id, or COMPARE_PROBES. */
  value: ProbeId
  onChange: (value: ProbeId) => void
}) {
  const options = [
    { value: COMPARE_PROBES, label: 'Compare' },
    ...probes.map(probe => ({ value: probe.id, label: probe.name })),
  ]
  if (probes.length > BUTTONS_UP_TO) {
    return <Select label="Measured from" value={value} onValueChange={onChange} options={options} />
  }
  return <SegmentedControl label="Measured from" value={value} onValueChange={onChange} options={options} />
}
