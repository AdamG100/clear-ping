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
    expect(getPacketLossLabel(5.1)).toBe('Moderate')
  })

  it('steps a band every five points between 5% and 20%', () => {
    expect(getPacketLossLabel(10)).toBe('Moderate')
    expect(getPacketLossLabel(10.1)).toBe('High')
    expect(getPacketLossLabel(15)).toBe('High')
    expect(getPacketLossLabel(15.1)).toBe('Severe')
    expect(getPacketLossLabel(20)).toBe('Severe')
    expect(getPacketLossLabel(20.1)).toBe('Critical')
  })

  it('calls a badly broken path critical rather than moderate', () => {
    // The old top band began at 50%, so a path dropping 40% of its traffic was
    // still only "Moderate".
    expect(getPacketLossLabel(25)).toBe('Critical')
    expect(getPacketLossLabel(40)).toBe('Critical')
    expect(getPacketLossLabel(100)).toBe('Critical')
  })

  it('gives every band its own colour', () => {
    expect(new Set(PACKET_LOSS_BANDS.map(b => b.cssVar)).size).toBe(PACKET_LOSS_BANDS.length)
    expect(new Set(PACKET_LOSS_BANDS.map(b => b.hex)).size).toBe(PACKET_LOSS_BANDS.length)
  })

  it('escalates monotonically and never skips a band', () => {
    const seen = [0, 1, 3, 5, 8, 12, 17, 20, 60, 100].map(getPacketLossLabel)
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
    expect(getPacketLossLabel(150)).toBe('Critical')
    expect(isMeaningfulLoss(null)).toBe(false)
    expect(isMeaningfulLoss(undefined)).toBe(false)
  })

  it('keeps the noise floor and the first band boundary in step', () => {
    expect(PACKET_LOSS_BANDS[0].maxLoss).toBe(LOSS_NOISE_FLOOR)
  })
})
