import { describe, expect, it } from 'vitest'
import type { BgpBaseline } from '@/types/bgp'
import { FORGET_AFTER_MS, LEARN_AFTER_MS, learn, type Carried } from './learn'

const HOUR = 60 * 60 * 1000

const baseline: BgpBaseline = {
  at: 0,
  origins: [64500],
  upstreams: [0, 64501],
  peers: ['rrc19|192.0.2.1', 'rrc19|192.0.2.2'],
  prefixes: ['198.51.100.0/24'],
  directPeers: ['rrc19|192.0.2.1'],
  exchanges: ['JINX'],
}

const carried: Carried = {
  upstreams: [0, 64501],
  peers: ['rrc19|192.0.2.1', 'rrc19|192.0.2.2'],
  prefixes: ['198.51.100.0/24'],
  directPeers: ['rrc19|192.0.2.1'],
  exchanges: ['JINX'],
}

/** Normal learned at each time in turn, from what is carried at each. */
function over(steps: [number, Carried][], from = baseline) {
  let normal = from
  const reasons: string[] = []
  for (const [at, now] of steps) {
    const next = learn(normal, now, at)
    normal = next.baseline
    reasons.push(...next.reasons)
  }
  return { normal, reasons }
}

describe('learn', () => {
  it('changes nothing while it is carried as it was', () => {
    const { changed, reasons } = learn(baseline, carried, HOUR)
    expect(changed).toBe(false)
    expect(reasons).toEqual([])
  })

  it('learns a new upstream once it has carried it for a day without a break', () => {
    const diverted = { ...carried, upstreams: [64510, 0, 64501] }
    const { normal, reasons } = over([
      [HOUR, diverted],
      [HOUR + LEARN_AFTER_MS - 1, diverted],
    ])
    expect(normal.upstreams).toEqual([0, 64501])
    expect(reasons).toEqual([])

    const learned = over([[HOUR + LEARN_AFTER_MS, diverted]], normal)
    expect(learned.normal.upstreams).toEqual([0, 64501, 64510])
    expect(learned.normal.pending).toEqual({})
    expect(learned.reasons).toEqual(['AS64510 is one of its usual upstreams now: it has carried it for a day'])
  })

  it('starts the wait again after a break', () => {
    const diverted = { ...carried, upstreams: [64510, 0, 64501] }
    const { normal } = over([
      [HOUR, diverted],
      [2 * HOUR, carried],
      [3 * HOUR, diverted],
      [HOUR + LEARN_AFTER_MS, diverted],
    ])
    expect(normal.upstreams).toEqual([0, 64501])
    expect(normal.pending).toEqual({ 'upstreams:64510': 3 * HOUR })
  })

  it('forgets what has been gone for a week, and keeps what comes back', () => {
    const dropped = { ...carried, upstreams: [0], peers: ['rrc19|192.0.2.1'] }
    const back = over([
      [HOUR, dropped],
      [2 * HOUR, carried],
      [HOUR + FORGET_AFTER_MS, carried],
    ])
    expect(back.normal.upstreams).toEqual([0, 64501])
    expect(back.normal.missing).toEqual({})

    const gone = over([
      [HOUR, dropped],
      [HOUR + FORGET_AFTER_MS, dropped],
    ])
    expect(gone.normal.upstreams).toEqual([0])
    expect(gone.normal.peers).toEqual(['rrc19|192.0.2.1'])
    expect(gone.reasons).toEqual([
      'AS64501 is no longer usual: it has not carried it for a week',
      '1 collector peer that stopped seeing it a week ago no longer counts',
    ])
  })

  it('takes a peer that went over to transit for good as no longer direct', () => {
    const moved = { ...carried, directPeers: [] }
    const { normal, reasons } = over([
      [HOUR, moved],
      [HOUR + FORGET_AFTER_MS, moved],
    ])
    expect(normal.directPeers).toEqual([])
    expect(reasons).toEqual(['1 peer that went over to an upstream a week ago no longer counts as direct'])
  })

  it('leaves the exchanges alone when they were not read well, or never recorded', () => {
    const unread = { ...carried, exchanges: undefined }
    expect(over([[HOUR, unread], [HOUR + FORGET_AFTER_MS, unread]]).normal.exchanges).toEqual(['JINX'])
    const old = { ...baseline, exchanges: undefined }
    expect(over([[HOUR, carried], [HOUR + LEARN_AFTER_MS, carried]], old).normal.exchanges).toBeUndefined()
  })

  it('never learns the networks announcing it', () => {
    const { normal } = over([
      [HOUR, carried],
      [HOUR + LEARN_AFTER_MS, carried],
    ])
    expect(normal.origins).toEqual([64500])
  })
})
