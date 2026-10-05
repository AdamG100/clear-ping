import type { AlertEvent, AlertMetric, AlertSettings } from '@/types/probe';
import { ALERT_METRIC_LABELS } from '@/types/probe';
import { groupLabel } from './group-path';

/**
 * What an alert says and how it is worded for wherever it is sent.
 *
 * Nothing here touches the database or the network, so the browser can use the
 * same wording as the webhook and the payloads can be tested as plain values.
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

// ─── Discord ────────────────────────────────────────────────────────────────

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

/**
 * Whether a URL is a Discord webhook that wants Discord's own payload.
 *
 * Used to suggest a destination and to question one that looks wrong, never to
 * decide the format: that is the alert's `destination`. Discord also serves
 * each webhook at `…/slack` and `…/github`, which expect those services'
 * formats instead, so those do not count.
 */
export function isDiscordWebhook(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return DISCORD_HOSTS.has(parsed.hostname.toLowerCase()) && /^\/api(\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const SNOWFLAKE = /^\d{15,22}$/;

/**
 * Read role or user ids from whatever was typed or sent.
 *
 * Takes a list, or text with the ids separated by commas or spaces, and takes
 * each id bare or as the mention Discord copies (`<@&123…>`, `<@123…>`).
 * Returns null if anything in it is not an id: a typo must be reported, not
 * dropped, or the alert would quietly mention fewer people than intended.
 */
export function parseMentionIds(input: unknown): string[] | null {
  const tokens = Array.isArray(input)
    ? input.map(String)
    : typeof input === 'string'
      ? input.split(/[\s,]+/)
      : input === undefined || input === null
        ? []
        : null;
  if (!tokens) return null;

  const ids: string[] = [];
  for (const token of tokens) {
    const id = token.trim().replace(/^<@[&!]?/, '').replace(/>$/, '');
    if (id === '') continue;
    if (!SNOWFLAKE.test(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Discord's own limits; a field past its limit makes it reject the whole post.
const EMBED_TITLE_MAX = 256;
const EMBED_FIELD_MAX = 1024;
const MENTIONS_MAX = 100;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const COLOR_FIRING = 0xe5484d;
const COLOR_RESOLVED = 0x30a46c;

interface PayloadOptions {
  /** A message sent from the "Send test" button rather than by a real probe. */
  test?: boolean;
}

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
  const condition = describeCondition(event.rule);
  const probes = event.rule.consecutiveProbes;

  if (event.transition === 'firing') {
    return probes === 1 ? `**${condition}** on the latest probe.` : `**${condition}** for ${probes} probes in a row.`;
  }
  return probes === 1
    ? `**${condition}** no longer holds.`
    : `**${condition}** has been clear for ${probes} probes in a row.`;
}

/**
 * The body Discord is sent: one embed, coloured by whether the alert fired or
 * resolved.
 *
 * The roles and users to mention go in `content`, because Discord does not
 * notify anyone for a mention inside an embed. `allowed_mentions` names
 * exactly those ids, so nothing else in the message can ping anybody: a target
 * called `@everyone` stays text. Only a firing alert mentions; hearing that it
 * recovered is not worth a second notification.
 */
export function discordPayload(event: AlertEvent, options: PayloadOptions = {}) {
  const firing = event.transition === 'firing';
  const roles = firing ? (event.rule.mentionRoleIds ?? []).slice(0, MENTIONS_MAX) : [];
  const users = firing ? (event.rule.mentionUserIds ?? []).slice(0, MENTIONS_MAX) : [];
  const mentions = [...roles.map(id => `<@&${id}>`), ...users.map(id => `<@${id}>`)].join(' ');

  const fields = [
    { name: 'Address', value: event.targetHost, inline: true },
    { name: 'Now', value: formatObserved(event.metric, event.observed), inline: true },
    { name: 'Alert', value: alertTitle(event.rule), inline: true },
  ];
  if (event.targetGroup) fields.push({ name: 'Group', value: groupLabel(event.targetGroup), inline: true });

  return {
    username: 'ClearPing',
    ...(mentions ? { content: mentions } : {}),
    allowed_mentions: { parse: [] as string[], roles, users },
    embeds: [
      {
        title: clip(`${options.test ? 'Test: ' : ''}${headline(event)}`, EMBED_TITLE_MAX),
        description: explanation(event),
        color: firing ? COLOR_FIRING : COLOR_RESOLVED,
        fields: fields.map(field => ({ ...field, value: clip(field.value, EMBED_FIELD_MAX) })),
        footer: { text: firing ? 'ClearPing · firing' : 'ClearPing · resolved' },
        timestamp: event.at.toISOString(),
      },
    ],
  };
}

// ─── Everything else ────────────────────────────────────────────────────────

/** The body any other webhook is sent. `text` is a ready-made one-line summary. */
export function webhookPayload(event: AlertEvent, options: PayloadOptions = {}) {
  const summary =
    event.transition === 'firing'
      ? `${event.targetName} (${event.targetHost}): ${event.metric} is ${event.observed ?? 'unknown'}, past threshold ${event.threshold}`
      : `${event.targetName} (${event.targetHost}): ${event.metric} recovered`;

  return {
    status: event.transition,
    alert: { id: event.rule.id, name: alertTitle(event.rule) },
    target: { name: event.targetName, host: event.targetHost, group: event.targetGroup ?? null },
    metric: event.metric,
    observed: event.observed,
    threshold: event.threshold,
    at: event.at.toISOString(),
    text: options.test ? `Test: ${summary}` : summary,
    ...(options.test ? { test: true } : {}),
  };
}

/** The body to send for an alert, in the format its destination takes. */
export function payloadFor(event: AlertEvent, options: PayloadOptions = {}) {
  return event.rule.destination === 'discord' ? discordPayload(event, options) : webhookPayload(event, options);
}
