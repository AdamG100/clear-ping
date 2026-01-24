/**
 * Packet Loss Color Mapping Utility
 * 
 * Maps packet loss percentage to color codes following a gradient from
 * green (excellent) through cyan, blue, magenta, orange to red (critical).
 */

export interface PacketLossColorScheme {
  hex: string;
  oklch: string;
  label: string;
  description: string;
}

/**
 * Get color for packet loss percentage
 * @param lossPercent - The packet loss percentage (0-100)
 * @returns Color in hex format
 */
export function getPacketLossColor(lossPercent: number): string {
  if (lossPercent === 0) return '#22c55e'; // Muted green - perfect connection (matches bg-green-500)
  if (lossPercent <= 10) return '#06b6d4'; // Muted cyan - minor loss (matches bg-cyan-400)
  if (lossPercent <= 50) return '#d946ef'; // Muted magenta - moderate to severe loss (matches bg-fuchsia-500)
  return '#dc2626'; // Muted red - high packet loss or total unreachability (matches bg-red-600)
}

/**
 * Get color in OKLCH format for packet loss percentage
 * OKLCH provides better perceptual uniformity than hex
 * @param lossPercent - The packet loss percentage (0-100)
 * @returns Color in OKLCH format
 */
export function getPacketLossColorOKLCH(lossPercent: number): string {
  if (lossPercent === 0) return 'oklch(0.65 0.15 145)'; // Muted green
  if (lossPercent <= 10) return 'oklch(0.65 0.15 195)'; // Muted cyan
  if (lossPercent <= 50) return 'oklch(0.65 0.20 320)'; // Muted magenta
  return 'oklch(0.60 0.20 25)'; // Muted red
}

/**
 * Get detailed color information for packet loss percentage
 * @param lossPercent - The packet loss percentage (0-100)
 * @returns Object with color details
 */
export function getPacketLossColorInfo(lossPercent: number): PacketLossColorScheme {
  if (lossPercent === 0) {
    return {
      hex: '#22c55e',
      oklch: 'oklch(0.65 0.15 145)',
      label: 'Perfect',
      description: 'No packet loss',
    };
  }
  if (lossPercent <= 10) {
    return {
      hex: '#06b6d4',
      oklch: 'oklch(0.65 0.15 195)',
      label: 'Minor Loss',
      description: '1-2 packets dropped',
    };
  }
  if (lossPercent <= 50) {
    return {
      hex: '#d946ef',
      oklch: 'oklch(0.65 0.20 320)',
      label: 'Moderate-Severe',
      description: 'Significant packet loss',
    };
  }
  return {
    hex: '#dc2626',
    oklch: 'oklch(0.60 0.20 25)',
    label: 'High Loss/Failure',
    description: 'Path failure or high packet loss',
  };
}

/**
 * Get text color (for contrast) based on packet loss
 * @param lossPercent - The packet loss percentage (0-100)
 * @returns Text color class for optimal contrast
 */
export function getPacketLossTextColor(lossPercent: number): string {
  // For lighter colors (cyan), use dark text
  if (lossPercent > 0 && lossPercent <= 10) return 'text-gray-900';
  // For darker colors (green, magenta, red), use light text
  return 'text-white';
}

/**
 * Get background color class for packet loss badge/indicator
 * @param lossPercent - The packet loss percentage (0-100)
 * @returns Tailwind background color class
 */
export function getPacketLossBgClass(lossPercent: number): string {
  if (lossPercent === 0) return 'bg-green-500';
  if (lossPercent <= 10) return 'bg-cyan-400';
  if (lossPercent <= 50) return 'bg-fuchsia-500';
  return 'bg-red-600';
}

/**
 * Get color for latency/RTT values
 * @param latencyMs - The latency in milliseconds
 * @returns Color in hex format
 */
export function getLatencyColor(latencyMs: number): string {
  if (latencyMs <= 10) return '#22c55e'; // Muted green - excellent (matches packet loss perfect)
  if (latencyMs <= 30) return '#4ade80'; // Light green - very good
  if (latencyMs <= 50) return '#06b6d4'; // Muted cyan - good (matches packet loss minor)
  if (latencyMs <= 75) return '#60a5fa'; // Light blue - acceptable
  if (latencyMs <= 100) return '#3b82f6'; // Blue - fair
  if (latencyMs <= 150) return '#d946ef'; // Muted magenta - degraded (matches packet loss moderate)
  if (latencyMs <= 200) return '#f97316'; // Orange - poor
  return '#dc2626'; // Muted red - critical (matches packet loss high)
}
