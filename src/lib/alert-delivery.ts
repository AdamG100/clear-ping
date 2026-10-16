import type { AlertEvent, AlertMetric, AlertSettings } from '@/types/probe';
import { ALERT_METRIC_LABELS } from '@/types/probe';
import { groupLabel } from './group-path';

/**
 * What an alert says, and the URLs it is sent to.
 *
 * Nothing here touches the database or the network, so the browser can use the
 * same wording and the same checks as the server, and a notification can be
 * tested as a plain value. Sending one is apprise.ts.
 */

/** A condition in a few words: what the list of alerts calls one with no name. */
export function describeCondition(alert: Pick<AlertSettings, 'metric' | 'threshold'>): string {
  const { label, unit, comparison } = ALERT_METRIC_LABELS[alert.metric];
  if (alert.metric === 'unreachable') return 'Stops responding';
  if (alert.metric === 'certExpiry') return `Certificate expires within ${alert.threshold} days`;
  return `${label} ${comparison} ${alert.threshold}${unit}`;
}

/** What an alert is called: its own name if it was given one. */
export function alertTitle(alert: Pick<AlertSettings, 'name' | 'metric' | 'threshold'>): string {
  return alert.name?.trim() || describeCondition(alert);
}

function formatObserved(metric: AlertMetric, observed: number | null): string {
  if (metric === 'unreachable') return observed === 1 ? 'No reply' : 'Replying';
  if (observed === null) return 'No reading';
  const rounded = Math.round(observed * 10) / 10;
  return `${rounded}${ALERT_METRIC_LABELS[metric].unit}`;
}

// ─── Where it is sent ───────────────────────────────────────────────────────

const NOTIFY_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * Read notification URLs from whatever was typed or sent.
 *
 * Takes a list, or text with the URLs on separate lines. Only that each one is
 * a URL is checked here; whether Apprise has a service by that name, and
 * whether the rest of it makes sense to that service, is for Apprise to say.
 * Returns null if anything in it is not a URL: a typo must be reported, not
 * dropped, or the alert would quietly be sent to fewer places than intended.
 */
export function parseNotifyUrls(input: unknown): string[] | null {
  const tokens = Array.isArray(input)
    ? input.map(String)
    : typeof input === 'string'
      ? input.split(/\s+/)
      : input === undefined || input === null
        ? []
        : null;
  if (!tokens) return null;

  const urls: string[] = [];
  for (const token of tokens) {
    const url = token.trim();
    if (url === '') continue;
    if (!NOTIFY_URL.test(url)) return null;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * A notification URL in a word, for the list of alerts: the service as Apprise
 * spells it (`discord`, `mailto`), or the host of a web address Apprise knows
 * a service by. Never more of the URL than that: the rest of it is what lets
 * anyone holding it post to the channel.
 */
export function notifyUrlLabel(url: string): string {
  const scheme = url.slice(0, Math.max(0, url.indexOf('://'))).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return scheme;
  try {
    return new URL(url).hostname;
  } catch {
    return scheme;
  }
}

/**
 * A notification URL with its secrets taken out: what service it is, and no
 * more. These URLs carry tokens and passwords (a Discord webhook's token, a
 * mail account's password), so they are shown whole only to those who may
 * change the alert; anyone else sees `discord://…` or `https://hooks.example/…`.
 */
export function redactNotifyUrl(url: string): string {
  const scheme = url.slice(0, Math.max(0, url.indexOf('://'))).toLowerCase();
  if (!scheme) return '…';
  const label = notifyUrlLabel(url);
  return scheme === 'http' || scheme === 'https' ? `${scheme}://${label}/…` : `${scheme}://…`;
}

/**
 * A redacted URL sent back in place of the one it hides: the edit form is
 * filled with what the page was shown, so saving an alert without touching its
 * URLs sends them back redacted. Each such URL is swapped for the real one it
 * was made from; anything else is taken as typed.
 */
export function restoreRedacted(submitted: string[], existing: string[]): string[] {
  return submitted.map(url => existing.includes(url) ? url : (existing.find(real => redactNotifyUrl(real) === url) ?? url));
}

// ─── What it says ───────────────────────────────────────────────────────────

/**
 * One alert transition, worded once for every service there is.
 *
 * The body is HTML because that is the one format Apprise can turn into each
 * of the others: it goes to an email or to Telegram as it stands, becomes
 * Markdown for Discord or Slack, and plain text for an SMS or a JSON webhook.
 * Markdown would not do: Apprise has no way of turning that into plain text,
 * so the asterisks would be read out to everything that takes none.
 *
 * The title is plain text. Apprise escapes it for whichever service it is
 * going to, and folds it into the body of one that has no titles.
 */
export interface AlertNotification {
  title: string;
  body: string;
  /** Apprise's notification type, which is what colours it: red or green. */
  type: 'failure' | 'success';
}

interface NotificationOptions {
  /** A message sent from the "Send test" button rather than by a real probe. */
  test?: boolean;
}

// Apprise's own limit for a title, on a service that sets none of its own.
const TITLE_MAX = 250;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * `@everyone` and `@here`, broken so that they are only text.
 *
 * Discord and others notify a whole channel for those wherever they appear in
 * a message, and a target is named by whoever added it. A zero-width space
 * after the `@` reads the same and pings nobody.
 */
const defuse = (text: string) => text.replace(/@(?=everyone|here)/gi, '@​');

/** Text from a target or an alert, made safe to put in the body. */
const html = (text: string) =>
  defuse(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function headline(event: AlertEvent): string {
  if (event.transition === 'resolved') return `${event.targetName} has recovered`;

  switch (event.metric) {
    case 'unreachable':
      return `${event.targetName} is not responding`;
    case 'certExpiry':
      return `${event.targetName}: certificate is about to expire`;
    default:
      return `${event.targetName}: ${ALERT_METRIC_LABELS[event.metric].label.toLowerCase()} is too high`;
  }
}

function explanation(event: AlertEvent): string {
  const condition = `<b>${html(describeCondition(event.rule))}</b>`;
  const probes = event.rule.consecutiveProbes;

  if (event.transition === 'firing') {
    return probes === 1 ? `${condition} on the latest probe.` : `${condition} for ${probes} probes in a row.`;
  }
  return probes === 1
    ? `${condition} no longer holds.`
    : `${condition} has been clear for ${probes} probes in a row.`;
}

/** What to send for an alert firing or clearing on one target. */
export function notificationFor(event: AlertEvent, options: NotificationOptions = {}): AlertNotification {
  const details = [
    ['Address', event.targetHost],
    ['Now', formatObserved(event.metric, event.observed)],
    ['Alert', alertTitle(event.rule)],
  ];
  if (event.targetGroup) details.push(['Group', groupLabel(event.targetGroup)]);

  return {
    title: clip(defuse(`${options.test ? 'Test: ' : ''}${headline(event)}`), TITLE_MAX),
    body:
      `<p>${explanation(event)}</p>` +
      `<ul>${details.map(([name, value]) => `<li><b>${name}:</b> ${html(value)}</li>`).join('')}</ul>`,
    type: event.transition === 'firing' ? 'failure' : 'success',
  };
}
