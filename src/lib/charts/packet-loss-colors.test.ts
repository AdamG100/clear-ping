import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getPacketLossLabel,
  isMeaningfulLoss,
  LOSS_NOISE_FLOOR,
  NO_REPLY_COLOR,
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

/** The `--signal-*` tokens one block of `globals.css` sets, by name. */
function signalTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const block = css.slice(start, css.indexOf('\n}', start))
  return Object.fromEntries([...block.matchAll(/--signal-(\w+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
}

/** An `oklch(L C h)` colour as sRGB hex, clipped to the gamut. */
function oklchToHex(colour: string): string {
  const [L, C, h] = colour.match(/[\d.]+/g)!.map(Number)
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return '#' + linear
    .map(c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))
    .map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0'))
    .join('')
}

describe('packet loss colours', () => {
  const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8')
  const bandName = (cssVar: string) => cssVar.match(/--signal-(\w+)/)![1]

  // The app draws with the tokens; the bands are what everything else reads.
  // They drifted apart once, unnoticed, so they are checked against each other.
  it('are the colours globals.css draws with, in both themes', () => {
    const light = signalTokens(css, ':root')
    const dark = signalTokens(css, ':root[data-theme="dark"]')
    for (const band of PACKET_LOSS_BANDS) {
      expect(light[bandName(band.cssVar)], band.label).toBe(band.light)
      expect(dark[bandName(band.cssVar)], band.label).toBe(band.oklch)
    }
  })

  it('give the same colour as hex as they do as oklch', () => {
    for (const band of PACKET_LOSS_BANDS) expect(band.hex, band.label).toBe(oklchToHex(band.oklch))
  })

  it('give a probe with no reply the worst band', () => {
    expect(NO_REPLY_COLOR).toBe(PACKET_LOSS_BANDS.at(-1)!.cssVar)
  })
})
