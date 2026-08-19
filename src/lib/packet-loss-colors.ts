/**
 * Packet Loss & Latency Colour Utilities
 *
 * One place defines the severity bands, their thresholds and their colours, so
 * a chart legend, a line segment and a status dot can never disagree about
 * what "moderate loss" looks like or where it starts.
 */

export interface PacketLossColorScheme {
  hex: string
  oklch: string
  /** Theme-aware CSS variable; preferred over hex wherever CSS is in play. */
  cssVar: string
  label: string
  /** Human-readable threshold, e.g. "≤10%". Rendered in legends. */
  range: string
  description: string
}

/** Colour for a bucket with no measurements — distinct from every severity band. */
export const NO_DATA_COLOR = 'var(--signal-none)'

/**
 * CSS custom properties, so a chart stroke and a status dot resolve to the same
 * value and both follow the theme. Hex equivalents remain below for the rare
 * context that cannot take a var().
 */
export const SIGNAL_VARS = {
  perfect: 'var(--signal-perfect)',
  minor: 'var(--signal-minor)',
  moderate: 'var(--signal-moderate)',
  high: 'var(--signal-high)',
  none: 'var(--signal-none)',
} as const

/**
 * How much loss counts as none.
 *
 * ICMP is the first traffic a busy router deprioritises or rate-limits, so an
 * isolated unanswered echo is ordinary background noise rather than evidence of
 * a problem. It is also below the resolution of a single probe: at 20 packets,
 * the smallest loss one probe can report is 5%, so any window average under 1%
 * necessarily means "one stray packet somewhere in the window".
 */
export const LOSS_NOISE_FLOOR = 1

/** Whether a loss figure is worth drawing attention to. */
export function isMeaningfulLoss(lossPercent: number | null | undefined): boolean {
  return typeof lossPercent === 'number' && Number.isFinite(lossPercent) && lossPercent > LOSS_NOISE_FLOOR
}

/**
 * Severity bands, ordered from best to worst. `maxLoss` is the inclusive upper
 * bound of the band; the last band catches everything above the previous one.
 *
 * Thresholds are set against what the loss does to traffic, not against round
 * numbers:
 *
 *   ≤1%    TCP recovers invisibly and nothing notices. See LOSS_NOISE_FLOOR.
 *   1-5%   Real but small. One dropped packet in a 20-packet probe is exactly
 *          5%, so a single-packet blip lands at the top of this band and no
 *          higher — which is the whole point of putting the boundary there.
 *   5-20%  VoIP degrades audibly and TCP throughput collapses.
 *   >20%   The path is effectively broken.
 *
 * The previous thresholds were 0 / 10 / 50 / 100, which was wrong at both ends:
 * a single stray packet in an hour reported as "Minor Loss", while a path
 * dropping 40% of its traffic was still only "Moderate".
 */
export const PACKET_LOSS_BANDS: readonly (PacketLossColorScheme & { maxLoss: number })[] = [
  {
    maxLoss: LOSS_NOISE_FLOOR,
    oklch: 'oklch(0.76 0.10 175)',
    hex: '#43bfae',
    cssVar: 'var(--signal-perfect)',
    label: 'Clear',
    range: '≤1%',
    description: 'No loss worth acting on',
  },
  {
    maxLoss: 5,
    oklch: 'oklch(0.84 0.15 95)',
    hex: '#e3c04a',
    cssVar: 'var(--signal-minor)',
    label: 'Minor',
    range: '1-5%',
    description: 'Small, recoverable packet loss',
  },
  {
    maxLoss: 20,
    oklch: 'oklch(0.73 0.19 50)',
    hex: '#ef8b3c',
    cssVar: 'var(--signal-moderate)',
    label: 'Degraded',
    range: '5-20%',
    description: 'Calls and streams suffer; throughput drops sharply',
  },
  {
    maxLoss: 100,
    oklch: 'oklch(0.63 0.23 25)',
    hex: '#e2453c',
    cssVar: 'var(--signal-high)',
    label: 'Severe',
    range: '>20%',
    description: 'Path is effectively unusable',
  },
] as const

/** The severity band a loss figure falls into, e.g. "Clear" or "Degraded". */
export function getPacketLossLabel(lossPercent: number | string): string {
  return getPacketLossColorInfo(lossPercent).label
}

// Latency reuses the severity ramp, so "amber" means the same degree of
// trouble whether it is describing loss or round-trip time.
const LATENCY_PALETTE = {
  excellent: { oklch: 'var(--signal-perfect)', hex: '#43bfae' }, // <=50ms
  good: { oklch: 'var(--signal-perfect)', hex: '#43bfae' }, // 51-100ms
  fair: { oklch: 'var(--signal-minor)', hex: '#e3c04a' }, // 101-200ms
  poor: { oklch: 'var(--signal-high)', hex: '#e2453c' }, // >200ms
} as const

/**
 * Detailed band information for a packet-loss percentage.
 *
 * Out-of-range and non-numeric inputs are clamped rather than mapped to the
 * worst band: a negative value used to fall through to "minor loss", and a
 * NaN to "critical", which turned a data-handling slip into a false alarm.
 */
export function getPacketLossColorInfo(lossPercent: number | string): PacketLossColorScheme {
  const raw = Number(lossPercent)
  const loss = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0
  const band = PACKET_LOSS_BANDS.find(b => loss <= b.maxLoss) ?? PACKET_LOSS_BANDS[PACKET_LOSS_BANDS.length - 1]
  const { maxLoss, ...scheme } = band
  void maxLoss
  return scheme
}

/** Hex colour for a packet-loss percentage — reliable in SVG strokes and fills. */
export function getPacketLossColor(lossPercent: number | string): string {
  return getPacketLossColorInfo(lossPercent).hex
}

/** Theme-aware CSS variable for a packet-loss percentage. */
export function getPacketLossVar(lossPercent: number | string): string {
  return getPacketLossColorInfo(lossPercent).cssVar
}

/** OKLCH colour for a packet-loss percentage, for CSS that supports it. */
export function getPacketLossColorOKLCH(lossPercent: number | string): string {
  return getPacketLossColorInfo(lossPercent).oklch
}

/**
 * Latency band colour. Non-numeric input is treated as 0 rather than silently
 * comparing NaN (which fails every check and returns "poor").
 */
export function getLatencyColor(latencyMs: number): string {
  const value = Number.isFinite(latencyMs) ? latencyMs : 0
  if (value <= 50) return LATENCY_PALETTE.excellent.oklch
  if (value <= 100) return LATENCY_PALETTE.good.oklch
  if (value <= 200) return LATENCY_PALETTE.fair.oklch
  return LATENCY_PALETTE.poor.oklch
}

export function getLatencyColorHex(latencyMs: number): string {
  const value = Number.isFinite(latencyMs) ? latencyMs : 0
  if (value <= 50) return LATENCY_PALETTE.excellent.hex
  if (value <= 100) return LATENCY_PALETTE.good.hex
  if (value <= 200) return LATENCY_PALETTE.fair.hex
  return LATENCY_PALETTE.poor.hex
}
