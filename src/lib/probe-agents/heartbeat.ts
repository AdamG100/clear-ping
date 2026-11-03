import { getJsonSetting, setJsonSetting } from '../security/settings-store';

/**
 * How long a probe agent may go without answering before it counts as offline.
 *
 * The dashboard asks every probe agent how it is once a minute (the heartbeat),
 * and a probe agent that does not answer is only called offline once it has
 * been silent for this long, so one dropped check does not set off a
 * notification. Server-side only: it reads settings, so nothing the probe
 * agent bundles may import it.
 */

const KEY = 'probes.offlineAfterMinutes';

export const DEFAULT_OFFLINE_AFTER_MINUTES = 3;
export const MAX_OFFLINE_AFTER_MINUTES = 60;

export function isOfflineAfterMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_OFFLINE_AFTER_MINUTES;
}

export async function offlineAfterMinutes(): Promise<number> {
  const stored = await getJsonSetting<number>(KEY);
  return isOfflineAfterMinutes(stored) ? stored : DEFAULT_OFFLINE_AFTER_MINUTES;
}

export async function setOfflineAfterMinutes(minutes: number): Promise<void> {
  await setJsonSetting(KEY, minutes === DEFAULT_OFFLINE_AFTER_MINUTES ? null : minutes);
}
