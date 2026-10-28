import { describe, expect, it } from 'vitest'
import { BGP_DIRECT, type BgpUpdate } from '@/types/bgp'
import { FLAP_WINDOW_MS, flapCount, wayChanges } from './flapping'

const HOUR = 60 * 60 * 1000
const SESSION = 'rrc19|192.0.2.1'
let id = 0

function update(at: number, path: number[] | null, previousPath: number[] | null | undefined, peer = '192.0.2.1'): BgpUpdate {
  return {
    id: ++id,
    at,
    collector: 'rrc19',
    location: 'Johannesburg',
    peer,
    peerAsn: 64496,
    prefix: '198.51.100.0/24',
    kind: path ? 'announce' : 'withdraw',
    path,
    previousPath,
  }
}

const direct = [64496, 64500]
const transit = [64496, 64510, 64500]

describe('wayChanges', () => {
  it('keeps the updates that changed the way in, newest first', () => {
    const changes = wayChanges(
      [update(1 * HOUR, transit, direct), update(2 * HOUR, transit, transit), update(3 * HOUR, direct, transit), update(4 * HOUR, null, direct)],
      new Set([SESSION])
    )
    expect(changes.get(SESSION)?.map(change => [change.update.at, change.now, change.was])).toEqual([
      [4 * HOUR, null, BGP_DIRECT],
      [3 * HOUR, BGP_DIRECT, 64510],
      [1 * HOUR, 64510, BGP_DIRECT],
    ])
  })

  it('leaves out other sessions, and updates whose path before is not known', () => {
    const changes = wayChanges([update(1, transit, direct, '192.0.2.9'), update(2, transit, undefined)], new Set([SESSION]))
    expect(changes.size).toBe(0)
  })
})

describe('flapCount', () => {
  const flaps = (ats: number[]) => wayChanges(ats.map((at, index) => update(at, index % 2 ? direct : transit, index % 2 ? transit : direct)), new Set([SESSION])).get(SESSION) ?? []

  it('is flapping with three changes in a day', () => {
    expect(flapCount(flaps([1 * HOUR, 2 * HOUR, 3 * HOUR]), 3 * HOUR)).toBe(3)
  })

  it('is not with two', () => {
    expect(flapCount(flaps([1 * HOUR, 2 * HOUR]), 2 * HOUR)).toBe(0)
  })

  it('counts only the last day', () => {
    expect(flapCount(flaps([0, 1 * HOUR, FLAP_WINDOW_MS + 2 * HOUR, FLAP_WINDOW_MS + 3 * HOUR]), FLAP_WINDOW_MS + 3 * HOUR)).toBe(0)
  })
})
