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
  if (lossPercent === 0) return '#00FF00'; // Bright green - perfect connection
  if (lossPercent <= 10) return '#00FFFF'; // Cyan - minor loss (1-2 packets)
  if (lossPercent <= 50) return '#FF00FF'; // Magenta - moderate to severe loss
  return '#FF0000'; // Red - high packet loss or total unreachability
}

/**
 * Get color in OKLCH format for packet loss percentage
 * OKLCH provides better perceptual uniformity than hex
 * @param lossPercent - The packet loss percentage (0-100)
 * @returns Color in OKLCH format
 */
export function getPacketLossColorOKLCH(lossPercent: number): string {
  if (lossPercent === 0) return 'oklch(0.85 0.25 145)'; // Bright green
  if (lossPercent <= 10) return 'oklch(0.85 0.20 195)'; // Cyan
  if (lossPercent <= 50) return 'oklch(0.65 0.28 320)'; // Magenta
  return 'oklch(0.60 0.25 25)'; // Red
}

/**
 * Get detailed color information for packet loss percentage
 * @param lossPercent - The packet loss percentage (0-100)
 * @returns Object with color details
 */
export function getPacketLossColorInfo(lossPercent: number): PacketLossColorScheme {
  if (lossPercent === 0) {
    return {
      hex: '#00FF00',
      oklch: 'oklch(0.85 0.25 145)',
      label: 'Perfect',
      description: 'No packet loss',
    };
  }
  if (lossPercent <= 10) {
    return {
      hex: '#00FFFF',
      oklch: 'oklch(0.85 0.20 195)',
      label: 'Minor Loss',
      description: '1-2 packets dropped',
    };
  }
  if (lossPercent <= 50) {
    return {
      hex: '#FF00FF',
      oklch: 'oklch(0.65 0.28 320)',
      label: 'Moderate-Severe',
      description: 'Significant packet loss',
    };
  }
  return {
    hex: '#FF0000',
    oklch: 'oklch(0.60 0.25 25)',
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
  if (latencyMs <= 10) return '#00FF00'; // Bright green - excellent
  if (latencyMs <= 30) return '#80FF80'; // Light green - very good
  if (latencyMs <= 50) return '#00FFFF'; // Cyan - good
  if (latencyMs <= 75) return '#4080FF'; // Light blue - acceptable
  if (latencyMs <= 100) return '#0040FF'; // Blue - fair
  if (latencyMs <= 150) return '#FF00FF'; // Magenta - degraded
  if (latencyMs <= 200) return '#FF8800'; // Orange - poor
  return '#FF0000'; // Red - critical
}
