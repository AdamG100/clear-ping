import type { ProbeResult } from '@/types/probe';

/**
 * The log line of a reading. A reading that came back clean says nothing unless
 * CLEARPING_LOG_READINGS=1 asks: a line a second, all day, is work for this
 * program and for whatever keeps the log, and on a small machine it is a log
 * file that never stops growing. One that lost anything is always said.
 */
export function readingWorthLogging(result: Pick<ProbeResult, 'success' | 'packetLoss'>): boolean {
  return !result.success || (result.packetLoss ?? 0) > 0 || process.env.CLEARPING_LOG_READINGS === '1';
}

export function logReading(result: Pick<ProbeResult, 'success' | 'packetLoss'>, line: string): void {
  if (readingWorthLogging(result)) console.log(line);
}
