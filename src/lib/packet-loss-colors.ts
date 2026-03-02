/**
 * Packet Loss & Latency Color Utilities (OKLCH-first)
 *
 * This module centralizes color definitions using OKLCH color strings
 * for perceptual uniformity. For compatibility we keep a hex fallback
 * alongside each OKLCH value so callers can use whichever format they
 * prefer.
 */

export interface PacketLossColorScheme {
  hex: string
  oklch: string
  label: string
  description: string
}

const PACKET_LOSS_PALETTE = {
  perfect: {
    oklch: 'oklch(0.65 0.15 145)',
    hex: '#22c55e',
    label: 'Perfect',
    description: 'No packet loss',
  },
  minor: {
    oklch: 'oklch(0.65 0.10 195)',
    hex: '#06b6d4',
    label: 'Minor Loss',
    description: 'Small, recoverable packet loss',
  },
  moderate: {
    oklch: 'oklch(0.62 0.18 320)',
    hex: '#d946ef',
    label: 'Moderate-Severe',
    description: 'Significant packet loss',
  },
  critical: {
    oklch: 'oklch(0.60 0.20 25)',
    hex: '#dc2626',
    label: 'High Loss/Failure',
    description: 'Path failure or high packet loss',
  },
} as const

const LATENCY_PALETTE = {
  excellent: { oklch: 'oklch(0.65 0.15 145)', hex: '#22c55e' }, // <=50ms
  good: { oklch: 'oklch(0.77 0.10 145)', hex: '#4ade80' }, // 51-100ms
  fair: { oklch: 'oklch(0.65 0.10 200)', hex: '#06b6d4' }, // 101-200ms
  poor: { oklch: 'oklch(0.60 0.20 25)', hex: '#dc2626' }, // >200ms
} as const

/**
 * Return OKLCH string for packet loss percentage.
 */
export function getPacketLossColorOKLCH(lossPercent: number | string): string {
  const n = Number(lossPercent ?? 0)
  if (Number.isNaN(n)) return PACKET_LOSS_PALETTE.critical.oklch
  if (n === 0) return PACKET_LOSS_PALETTE.perfect.oklch
  if (n <= 10) return PACKET_LOSS_PALETTE.minor.oklch
  if (n <= 50) return PACKET_LOSS_PALETTE.moderate.oklch
  return PACKET_LOSS_PALETTE.critical.oklch
}

/**
 * Return primary color for packet loss as OKLCH (default) — kept for
 * backwards compatibility with existing callers that expect a single
 * color string.
 */
export function getPacketLossColor(lossPercent: number | string): string {
  // Return hex fallback for reliable SVG/stroke rendering in charts and
  // other places that may not yet support OKLCH color strings.
  return getPacketLossColorInfo(lossPercent).hex
}

/**
 * Detailed color information for packet loss, includes hex fallback and
 * an OKLCH value.
 */
export function getPacketLossColorInfo(lossPercent: number | string): PacketLossColorScheme {
  const n = Number(lossPercent ?? 0)
  if (Number.isNaN(n)) return { ...PACKET_LOSS_PALETTE.critical }
  if (n === 0) return { ...PACKET_LOSS_PALETTE.perfect }
  if (n <= 10) return { ...PACKET_LOSS_PALETTE.minor }
  if (n <= 50) return { ...PACKET_LOSS_PALETTE.moderate }
  return { ...PACKET_LOSS_PALETTE.critical }
}

export function getPacketLossTextColor(lossPercent: number): string {
  // For the lighter `minor` cyan we prefer dark text for contrast
  if (lossPercent > 0 && lossPercent <= 10) return 'text-gray-900'
  return 'text-white'
}

export function getPacketLossBgClass(lossPercent: number): string {
  if (lossPercent === 0) return 'bg-green-500'
  if (lossPercent <= 10) return 'bg-cyan-400'
  if (lossPercent <= 50) return 'bg-fuchsia-500'
  return 'bg-red-600'
}

/**
 * Return OKLCH color string for latency buckets. Uses the new rule where
 * anything over 200ms is treated as poor/critical (red).
 */
export function getLatencyColor(latencyMs: number): string {
  if (latencyMs <= 50) return LATENCY_PALETTE.excellent.oklch
  if (latencyMs <= 100) return LATENCY_PALETTE.good.oklch
  if (latencyMs <= 200) return LATENCY_PALETTE.fair.oklch
  return LATENCY_PALETTE.poor.oklch
}

// Also export hex fallbacks when needed
export function getLatencyColorHex(latencyMs: number): string {
  if (latencyMs <= 50) return LATENCY_PALETTE.excellent.hex
  if (latencyMs <= 100) return LATENCY_PALETTE.good.hex
  if (latencyMs <= 200) return LATENCY_PALETTE.fair.hex
  return LATENCY_PALETTE.poor.hex
}
