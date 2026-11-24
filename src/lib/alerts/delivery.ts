import type { AlertSettings } from '@/types/probe';
import { ALERT_METRIC_LABELS } from '@/types/probe';

/**
 * What an alert says, and the URLs it is sent to.
 *
 * Nothing here touches the database or the network, so the browser can use the
 * same wording and the same checks as the server, and a notification can be
 * tested as a plain value. What a notification says is message.ts, and sending one apprise.ts.
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

/** Services Apprise takes as a plain request to whatever host the URL names. */
const WEB_REQUEST_SCHEMES = new Set(['http', 'https', 'json', 'jsons', 'xml', 'xmls', 'form', 'forms']);

/**
 * Whether a URL would have ClearPing call an address only its own machine can
 * reach: a link-local one, or a cloud provider's metadata service, which hands
 * out the machine's credentials. No notification service lives at one. A URL's
 * host is read as a browser reads it, so `2852039166` is `169.254.169.254`.
 */
export function reachesMachineOnly(url: string): boolean {
  const at = url.indexOf('://');
  if (at < 0 || !WEB_REQUEST_SCHEMES.has(url.slice(0, at).toLowerCase())) return false;
  let host: string;
  try {
    host = new URL(`http://${url.slice(at + 3)}`).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return false;
  }
  return (
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host.startsWith('169.254.') ||
    /^fe[89ab][0-9a-f]:/.test(host) ||
    host.startsWith('::ffff:a9fe:') ||
    host === 'fd00:ec2::254'
  );
}

/** An alert as it may be shown: its URLs whole only when `whole`, to whoever may change alerts. */
export function alertAsShown<T extends { notifyUrls: string[] }>(alert: T, whole: boolean): T {
  return whole ? alert : { ...alert, notifyUrls: alert.notifyUrls.map(redactNotifyUrl) };
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

/** Discord's own addresses for a webhook, which Apprise takes as they are. */
const DISCORD_WEBHOOK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\//i;

/**
 * Services Apprise posts as a card (an embed) only when the URL asks for
 * Markdown, and as a line of plain text otherwise. Guilded is Discord's
 * plugin under another name.
 */
const EMBED_SCHEMES = new Set(['discord', 'guilded']);

/** A URL that Apprise sends with its Discord plugin: Discord's own, or Guilded's. */
export function isDiscordUrl(url: string): boolean {
  const scheme = url.slice(0, Math.max(0, url.indexOf('://'))).toLowerCase();
  return EMBED_SCHEMES.has(scheme) || DISCORD_WEBHOOK.test(url);
}

/**
 * A notification URL as it is handed to Apprise: one for a service that can
 * show an alert as an embed asks for one. The embed is coloured red or green
 * by whether the alert is firing or has cleared, and carries the title and
 * the details on their own lines, where plain text runs them together.
 *
 * Only where the URL says nothing of its own about the format: one that
 * asks for plain text (`format=text`) keeps it. What is stored is never
 * changed; this is applied on the way out.
 *
 * Slack and Teams need nothing: Apprise sends them a coloured attachment or
 * card whatever the format.
 */
export function withEmbeds(url: string): string {
  if (!isDiscordUrl(url)) return url;

  const query = url.indexOf('?');
  if (query !== -1 && /(?:^|&)format=/i.test(url.slice(query + 1))) return url;
  return `${url}${query === -1 ? '?' : url.endsWith('?') || url.endsWith('&') ? '' : '&'}format=markdown`;
}
