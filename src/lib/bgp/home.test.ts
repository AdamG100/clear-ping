import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/database', () => ({ getAllTargets: async () => [] }))
vi.mock('../probe-agents/client', () => ({ runTrace: async () => null }))
vi.mock('../probe-agents/store', () => ({ listProbeAgents: async () => [] }))
vi.mock('./store', () => ({ getExcludedAgents: async () => [], listBgpTraces: async () => [], recordBgpTrace: async () => {} }))

const { crossingRuns } = await import('./home')

const jinx = { crossing: 'JINX', likely: null }
const napafrica = { crossing: 'NAPAfrica IX Johannesburg', likely: null }
const none = { crossing: null, likely: null }

describe('crossingRuns', () => {
  it('gathers traces that crossed the same way, newest first', () => {
    const runs = crossingRuns([
      { at: 50, crossed: jinx },
      { at: 40, crossed: jinx },
      { at: 30, crossed: napafrica },
      { at: 20, crossed: none },
      { at: 10, crossed: none },
    ])
    expect(runs).toEqual([
      { from: 40, to: 50, traces: 2, crossing: 'JINX', likely: null },
      { from: 30, to: 30, traces: 1, crossing: 'NAPAfrica IX Johannesburg', likely: null },
      { from: 10, to: 20, traces: 2, crossing: null, likely: null },
    ])
  })

  it('tells apart different likely exchanges', () => {
    const runs = crossingRuns([
      { at: 20, crossed: { crossing: null, likely: ['JINX'] } },
      { at: 10, crossed: { crossing: null, likely: ['JINX', 'NAPAfrica IX Johannesburg'] } },
    ])
    expect(runs).toHaveLength(2)
  })

  it('has nothing to gather with no traces', () => {
    expect(crossingRuns([])).toEqual([])
  })
})
