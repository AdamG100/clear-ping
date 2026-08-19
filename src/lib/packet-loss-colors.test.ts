import { describe, expect, it } from 'vitest'
import {
  getPacketLossLabel,
  isMeaningfulLoss,
  LOSS_NOISE_FLOOR,
  PACKET_LOSS_BANDS,
} from './packet-loss-colors'

describe('packet loss severity bands', () => {
  it('treats a single stray packet as clear, not as loss', () => {
    // One unanswered echo out of 3560 in an hour reads as 0.028%. Classifying
    // that as "Minor Loss" turned ordinary ICMP noise into an amber warning.
    expect(getPacketLossLabel(0.028)).toBe('Clear')
    expect(getPacketLossLabel(0.21)).toBe('Clear')
    expect(isMeaningfulLoss(0.21)).toBe(false)
  })

  it('puts one dropped packet in a 20-packet probe at the top of Minor', () => {
    expect(getPacketLossLabel(5)).toBe('Minor')
    expect(getPacketLossLabel(5.1)).toBe('Degraded')
  })

  it('calls a badly broken path severe rather than moderate', () => {
    // The old top band began at 50%, so a path dropping 40% of its traffic was
    // still only "Moderate".
    expect(getPacketLossLabel(25)).toBe('Severe')
    expect(getPacketLossLabel(40)).toBe('Severe')
    expect(getPacketLossLabel(100)).toBe('Severe')
  })

  it('escalates monotonically and never skips a band', () => {
    const seen = [0, 1, 3, 5, 12, 20, 60, 100].map(getPacketLossLabel)
    const order = PACKET_LOSS_BANDS.map(b => b.label)
    let previous = -1
    for (const label of seen) {
      const rank = order.indexOf(label)
      expect(rank).toBeGreaterThanOrEqual(previous)
      previous = rank
    }
  })

  it('clamps nonsense instead of raising a false alarm', () => {
    expect(getPacketLossLabel(-5)).toBe('Clear')
    expect(getPacketLossLabel(NaN)).toBe('Clear')
    expect(getPacketLossLabel(150)).toBe('Severe')
    expect(isMeaningfulLoss(null)).toBe(false)
    expect(isMeaningfulLoss(undefined)).toBe(false)
  })

  it('keeps the noise floor and the first band boundary in step', () => {
    expect(PACKET_LOSS_BANDS[0].maxLoss).toBe(LOSS_NOISE_FLOOR)
  })
})
