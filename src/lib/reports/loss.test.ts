import { describe, expect, it } from 'vitest'
import { analyzeLoss, type Neighbour } from './loss'
import type { ProbeReading } from './outages'

const MINUTE = 60_000
// Midnight UTC, so the hour of each reading is plain to read.
const START = Date.UTC(2026, 9, 20, 0, 0)

/** A day of readings a minute apart, with the given minutes losing `loss`%. */
function day(lossy: Record<number, number> = {}, failed: number[] = []): ProbeReading[] {
  return Array.from({ length: 1440 }, (_, minute) => ({
    timestamp: START + minute * MINUTE,
    packetLoss: lossy[minute] ?? 0,
    latency: failed.includes(minute) ? null : 10,
    success: !failed.includes(minute),
  }))
}

const options = (neighbours: Neighbour[] = []) => ({
  intervalMs: MINUTE,
  timeZone: 'UTC',
  packetsPerProbe: 20,
  neighbours,
})

function neighbour(name: string, affectedMinutes: number[], local = false): Neighbour {
  return {
    targetId: name,
    name,
    host: local ? '192.168.1.1' : '1.1.1.1',
    local,
    intervalMs: MINUTE,
    probes: 1440,
    affected: affectedMinutes.map(minute => START + minute * MINUTE),
  }
}

/** Minutes spread through the day, far enough apart never to make a spell. */
const scattered = [30, 200, 410, 655, 900, 1100, 1300]

describe('analyzeLoss', () => {
  it('says nothing of a period without loss', () => {
    const analysis = analyzeLoss(day(), options())
    expect(analysis.pattern).toBe('none')
    expect(analysis.affectedProbes).toBe(0)
    expect(analysis.worst).toBeNull()
  })

  it('calls single packets far apart scattered, and counts the packets', () => {
    const analysis = analyzeLoss(day(Object.fromEntries(scattered.map(minute => [minute, 5]))), options())
    expect(analysis.pattern).toBe('scattered')
    expect(analysis.spells).toBe(0)
    expect(analysis.packets).toEqual({ sent: 1440 * 20, lost: 7, singlePacketProbes: 7 })
  })

  it('calls probes in a row a spell, and finds the longest', () => {
    const analysis = analyzeLoss(day({ 600: 10, 601: 15, 602: 5, 603: 20, 1000: 5 }), options())
    expect(analysis.pattern).toBe('spells')
    expect(analysis.spells).toBe(1)
    expect(analysis.longest).toMatchObject({ start: START + 600 * MINUTE, affectedProbes: 4 })
    expect(analysis.worst).toEqual({ loss: 20, at: START + 603 * MINUTE })
  })

  it('calls loss on most probes constant, and counts a probe with no reply as all lost', () => {
    const lossy = Object.fromEntries(Array.from({ length: 1000 }, (_, minute) => [minute, 5]))
    const analysis = analyzeLoss(day(lossy, [1200]), options())
    expect(analysis.pattern).toBe('constant')
    expect(analysis.failedProbes).toBe(1)
    expect(analysis.worst).toEqual({ loss: 100, at: START + 1200 * MINUTE })
  })

  it('finds the hour the loss comes in', () => {
    // Every few minutes from 20:00 to 21:00, and once in the morning.
    const evening = Array.from({ length: 10 }, (_, i) => 20 * 60 + i * 6)
    const analysis = analyzeLoss(day(Object.fromEntries([...evening, 9 * 60].map(minute => [minute, 5]))), options())
    expect(analysis.busiestHour).toBe(20)
    expect(analysis.hours[20]).toEqual({ hour: 20, probes: 60, affected: 10 })
    expect(analysis.hours).toHaveLength(24)
  })

  it('says no hour stands out when the loss is spread through the day', () => {
    const analysis = analyzeLoss(day(Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [hour * 60 + 5, 5]))), options())
    expect(analysis.busiestHour).toBeNull()
  })

  it('does not call an hour a peak that only has a few more by chance', () => {
    // One or two an hour, and four at 19:00: twice the average, but a small share of the whole.
    const minutes = Array.from({ length: 24 }, (_, hour) => hour * 60 + 7)
    minutes.push(19 * 60 + 20, 19 * 60 + 40, 19 * 60 + 50)
    const analysis = analyzeLoss(day(Object.fromEntries(minutes.map(minute => [minute, 5]))), options())
    expect(analysis.hours[19].affected).toBe(4)
    expect(analysis.busiestHour).toBeNull()
  })

  describe('where it starts', () => {
    const lossy = Object.fromEntries(scattered.map(minute => [minute, 5]))

    it('on the local network, when the router lost packets at the same moments', () => {
      const analysis = analyzeLoss(day(lossy), options([neighbour('Router', scattered, true), neighbour('Cloudflare', scattered)]))
      expect(analysis.source).toBe('local')
      expect(analysis.comparedWithLocal).toBe(true)
    })

    it('beyond it, when targets out on the internet did and the router did not', () => {
      const analysis = analyzeLoss(day(lossy), options([neighbour('Router', []), neighbour('Cloudflare', scattered)].map((each, i) => ({ ...each, local: i === 0 }))))
      expect(analysis.source).toBe('shared')
      expect(analysis.sameMoments[0]).toMatchObject({ name: 'Cloudflare', shared: 7 })
    })

    it('a probe a minute either side still counts as the same moment', () => {
      const analysis = analyzeLoss(day(lossy), options([neighbour('Cloudflare', scattered.map(minute => minute + 1))]))
      expect(analysis.sameMoments[0].shared).toBe(7)
    })

    it('on its own path, when the others were probed all along and lost nothing then', () => {
      const analysis = analyzeLoss(day(lossy), options([neighbour('Cloudflare', [500, 501])]))
      expect(analysis.source).toBe('own-path')
    })

    it('unknown, with nothing to compare with or too little loss', () => {
      expect(analyzeLoss(day(lossy), options()).source).toBe('unknown')
      expect(analyzeLoss(day({ 30: 5 }), options([neighbour('Cloudflare', [30])])).source).toBe('unknown')
    })

    it('counts a target that shared some of it, well beyond chance', () => {
      // Four of the seven, from a target that lost nothing else all day.
      const analysis = analyzeLoss(day(lossy), options([neighbour('ISP gateway', scattered.slice(0, 4))]))
      expect(analysis.sameMoments[0]).toMatchObject({ shared: 4, significant: true })
      expect(analysis.source).toBe('shared')
    })

    it('does not count a target that loses packets all the time, which lands beside anything', () => {
      const always = Array.from({ length: 1440 }, (_, minute) => minute).filter(minute => minute % 2 === 0)
      const analysis = analyzeLoss(day(lossy), options([neighbour('Flaky', always)]))
      expect(analysis.sameMoments[0]).toMatchObject({ shared: 7, significant: false })
      expect(analysis.source).toBe('own-path')
    })

    it('leaves out a target that was not probed in the period', () => {
      const idle = { ...neighbour('Paused', []), probes: 0 }
      expect(analyzeLoss(day(lossy), options([idle])).sameMoments).toEqual([])
    })
  })
})
