import type { AlertEvent } from '@/types/probe';
import { deliverAlerts, withProbesNow } from './store';

/**
 * Notifications waiting a moment before they go, so that what happens at once
 * is told once.
 *
 * A monitor's probes take their readings together, and an outage seen by two
 * of them, or a switch that takes down five monitors, is one thing to be told
 * about. So an alert that fires waits here for the rest: every monitor the
 * same alert fires on in that time goes into the same message, and each
 * monitor's probes are read again as it goes, so the message says which of
 * them see it by then, not only the one whose reading fired it.
 */

/** How long a message waits for the rest of what happened at the same time. */
export const GROUP_WINDOW_MS = 20_000;

interface Batch {
  /** By monitor: a later event for one replaces its earlier one. */
  events: Map<string, AlertEvent>;
  timer: NodeJS.Timeout;
}

const waiting = new Map<string, Batch>();

/** Hold an alert's event for the message it goes out in. */
export function queueAlert(event: AlertEvent, windowMs = GROUP_WINDOW_MS): void {
  if (event.rule.notifyUrls.length === 0) return;
  // An alert firing and the same alert clearing are two messages, each in its colour.
  const key = `${event.rule.id}:${event.transition}`;
  const batch = waiting.get(key);
  if (batch) {
    batch.events.set(event.rule.targetId, event);
    return;
  }
  waiting.set(key, {
    events: new Map([[event.rule.targetId, event]]),
    timer: setTimeout(() => void send(key), windowMs),
  });
}

/**
 * Send it. Failures are logged and swallowed: a service that is down must
 * not take the prober with it.
 */
async function send(key: string): Promise<void> {
  const batch = waiting.get(key);
  if (!batch) return;
  waiting.delete(key);
  clearTimeout(batch.timer);

  const events = await Promise.all([...batch.events.values()].map(event => withProbesNow(event).catch(() => event)));
  try {
    const result = await deliverAlerts(events);
    if (!result.ok) console.error(`[Alerts] Delivery failed for ${events.map(event => event.targetName).join(', ')}: ${result.detail}`);
  } catch (error) {
    console.error('[Alerts] Delivery failed:', error);
  }
}

/** Send everything that is waiting, now: when the prober stops, and in tests. */
export async function flushAlerts(): Promise<void> {
  await Promise.all([...waiting.keys()].map(send));
}
