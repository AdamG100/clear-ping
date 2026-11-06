import { describe, expect, it } from 'vitest'
import type { GameRegion, RegionReading } from './catalogue'
import { cellKey, fastestByProbe, fastestFirst, progressOf, silentRegions, type Cell } from './results'

const region = (id: string): GameRegion => ({ id, label: id, continent: 'Europe', host: `${id}.example.net`, method: { kind: 'icmp' } })
const REGIONS = [region('fra'), region('ams'), region('lon')]
const PROBES = ['local', 'agent-1']

const reading = (latency: number | null): Cell => ({ state: 'done', reading: { latency, loss: latency === null ? 100 : 0, jitter: null } satisfies RegionReading })

function cells(entries: [string, string, Cell][]): Map<string, Cell> {
  return new Map(entries.map(([r, p, cell]) => [cellKey(r, p), cell]))
}

describe('progressOf', () => {
  it('counts what has finished and names what is running', () => {
    const progress = progressOf(
      cells([
        ['fra', 'local', reading(12)],
        ['fra', 'agent-1', { state: 'failed', error: 'x' }],
        ['ams', 'local', { state: 'running' }],
        ['ams', 'agent-1', { state: 'queued' }],
      ])
    )
    expect(progress).toEqual({ total: 4, finished: 2, running: [{ region: 'ams', probe: 'local' }] })
  })
})

describe('fastestByProbe', () => {
  it('picks the quickest region each probe heard back from', () => {
    const fastest = fastestByProbe(
      REGIONS,
      PROBES,
      cells([
        ['fra', 'local', reading(20)],
        ['ams', 'local', reading(12)],
        ['lon', 'local', reading(null)],
        ['fra', 'agent-1', reading(40)],
      ])
    )
    expect(fastest.get('local')).toEqual({ region: REGIONS[1], latency: 12 })
    expect(fastest.get('agent-1')).toEqual({ region: REGIONS[0], latency: 40 })
  })

  it('leaves out a probe nothing answered', () => {
    expect(fastestByProbe(REGIONS, PROBES, cells([['fra', 'local', reading(null)]])).has('local')).toBe(false)
  })
})

describe('silentRegions', () => {
  it('lists the regions no probe heard back from', () => {
    const found = silentRegions(
      REGIONS,
      PROBES,
      cells([
        ['fra', 'local', reading(null)],
        ['fra', 'agent-1', reading(null)],
        ['ams', 'local', reading(null)],
        ['ams', 'agent-1', reading(30)],
      ])
    )
    expect(found.map(r => r.id)).toEqual(['fra'])
  })

  it('does not count a region still being asked, or one that could not be asked', () => {
    const found = silentRegions(
      REGIONS,
      PROBES,
      cells([
        ['fra', 'local', reading(null)],
        ['fra', 'agent-1', { state: 'running' }],
        ['ams', 'local', reading(null)],
        ['ams', 'agent-1', { state: 'failed', error: 'busy' }],
      ])
    )
    expect(found).toEqual([])
  })
})

describe('fastestFirst', () => {
  it('orders by the best time from any probe, unanswered last, otherwise as listed', () => {
    const ordered = fastestFirst(
      REGIONS,
      PROBES,
      cells([
        ['fra', 'local', reading(50)],
        ['fra', 'agent-1', reading(9)],
        ['ams', 'local', reading(20)],
      ])
    )
    expect(ordered.map(r => r.id)).toEqual(['fra', 'ams', 'lon'])
  })
})
