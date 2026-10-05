import { describe, expect, it } from 'vitest'
import type { ProbeResult } from '@/types/probe'
import { measurementFrom, worstOf } from './probe-result'

const at = new Date('2026-08-19T12:00:00.000Z')

function result(fields: Partial<ProbeResult>): ProbeResult {
  return { targetId: 't', timestamp: at, latency: 10, packetLoss: 0, jitter: 1, success: true, ...fields }
}

describe('worstOf', () => {
  it('returns a single result untouched', () => {
    const only = result({ family: 4 })
    expect(worstOf([only])).toBe(only)
  })

  it('takes the worse of each figure across the two families', () => {
    const round = worstOf([
      result({ family: 4, latency: 12, packetLoss: 0, jitter: 0.5 }),
      result({ family: 6, latency: 48, packetLoss: 20, jitter: 3 }),
    ])

    expect(round).toMatchObject({ latency: 48, packetLoss: 20, jitter: 3, success: true })
    expect(round.errorMessage).toBeUndefined()
  })

  it('is a failed round when either family fails, and says which', () => {
    const round = worstOf([
      result({ family: 4, latency: 12 }),
      result({ family: 6, latency: null, packetLoss: 100, jitter: null, success: false, errorMessage: 'All packets lost' }),
    ])

    expect(round.success).toBe(false)
    expect(round.packetLoss).toBe(100)
    // The family that answered still has a latency to judge a latency rule on.
    expect(round.latency).toBe(12)
    expect(round.errorMessage).toBe('IPv6: All packets lost')
  })

  it('has no latency when neither family answered', () => {
    const down = { latency: null, packetLoss: 100, jitter: null, success: false, errorMessage: 'timed out' }
    const round = worstOf([result({ family: 4, ...down }), result({ family: 6, ...down })])

    expect(round.latency).toBeNull()
    expect(round.jitter).toBeNull()
    expect(round.errorMessage).toBe('IPv4: timed out; IPv6: timed out')
  })

  it('warns about whichever certificate runs out first', () => {
    const round = worstOf([
      result({ family: 4, details: { certExpiresAt: 2_000, statusCode: 200 } }),
      result({ family: 6, details: { certExpiresAt: 1_000, statusCode: 200 } }),
    ])
    expect(round.details).toEqual({ certExpiresAt: 1_000 })
  })

  it('lists both addresses the round measured', () => {
    const round = worstOf([
      result({ family: 4, resolvedAddress: '203.0.113.7' }),
      result({ family: 6, resolvedAddress: '2001:db8::7' }),
    ])
    expect(round.resolvedAddress).toBe('203.0.113.7, 2001:db8::7')
  })
})

describe('measurementFrom', () => {
  it('keeps a zero as a reading rather than treating it as missing', () => {
    const stored = measurementFrom('id-1', result({ packetLoss: 0, jitter: 0, family: 6 }))

    expect(stored).toMatchObject({ id: 'id-1', targetId: 't', packetLoss: 0, jitter: 0, family: 6 })
  })

  it('stores percentiles a probe did not report as absent', () => {
    const stored = measurementFrom('id-2', result({}))
    expect(stored.p50Latency).toBeNull()
    expect(stored.minLatency).toBeNull()
  })
})
