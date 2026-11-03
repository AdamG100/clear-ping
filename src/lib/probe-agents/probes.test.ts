import { describe, expect, it } from 'vitest'
import type { ProbeSummary } from '@/types/probe-agent'
import { probesNamed } from './probes'

/** The probes an imported file names, matched to the ones here by name. */

const HERE: ProbeSummary[] = [
  { id: 'local', name: 'Office', local: true, state: 'online' },
  { id: 'agent-1', name: 'Home', local: false, state: 'online' },
  { id: 'agent-2', name: 'Frankfurt VPS', local: false, state: 'offline' },
]

describe('probes named in an imported file', () => {
  it('are matched by name, ignoring case and spaces, and "local" is the local probe', async () => {
    expect(await probesNamed(['office', ' HOME ', 'frankfurt vps'], HERE)).toEqual({ probes: ['local', 'agent-1', 'agent-2'], missing: [] })
    expect(await probesNamed(['local', 'Office'], HERE)).toEqual({ probes: ['local'], missing: [] })
  })

  it('say which names nothing here has', async () => {
    expect(await probesNamed(['Home', 'Local probe', 'London'], HERE)).toEqual({ probes: ['agent-1'], missing: ['Local probe', 'London'] })
  })
})
