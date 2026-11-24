import type { ProbeVerdict } from '@/types/alert-rules';
import { ALERT_METRIC_LABELS, type AlertEvent, type AlertMetric } from '@/types/probe';
import { groupLabel } from '@/lib/targets/group-path';
import { displayTimeZone, formatMoment } from '@/lib/time-zone';
import { alertTitle, describeCondition } from './delivery';
import { describePolicy, policyOf } from './rules';

/**
 * What a notification says, worded once for every service there is.
 *
 * The body is HTML because that is the one format Apprise can turn into each
 * of the others: it goes to an email or to Telegram as it stands, becomes
 * Markdown for Slack, and plain text for an SMS or a JSON webhook. Markdown
 * would not do: Apprise has no way of turning that into plain text, so the
 * asterisks would be read out to everything that takes none.
 *
 * Discord is told the same thing as a card (an embed with fields and a time
 * of its own), which Apprise is handed whole: see apprise.ts.
 *
 * The title is plain text. Apprise escapes it for whichever service it is
 * going to, and folds it into the body of one that has no titles.
 */
export interface AlertNotification {
  title: string;
  body: string;
  /** Apprise's notification type, which is what colours it: red or green. */
  type: 'failure' | 'success';
  /** The same message laid out as a card, for a service that shows one. */
  card?: NotificationCard;
}

/** A message as Discord lays one out: a title, a few lines, then labelled fields. */
export interface NotificationCard {
  title: string;
  /** Discord's Markdown. */
  description: string;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  /** When it happened: a chat shows it in each reader's own time. */
  at?: Date;
}

export interface NotificationOptions {
  /** A message sent from the "Send test" button rather than by a real probe. */
  test?: boolean;
  /** The zone to say when it happened in; the one ClearPing shows times in if left out. */
  zone?: string;
}

// Apprise's own limit for a title, on a service that sets none of its own.
const TITLE_MAX = 250;
// Discord's limits for an embed.
const CARD_TITLE_MAX = 256;
const CARD_TEXT_MAX = 4000;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
/** Monitors listed one by one in a message about several; the rest are counted. */
const MONITORS_SHOWN = 15;
/** Probes listed one by one under a monitor; the rest are counted. */
const PROBES_SHOWN = 12;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * `@everyone` and `@here`, broken so that they are only text.
 *
 * Discord and others notify a whole channel for those wherever they appear in
 * a message, and a monitor is named by whoever added it. A zero-width space
 * after the `@` reads the same and pings nobody.
 */
const defuse = (text: string) => text.replace(/@(?=everyone|here)/gi, '@​');

/** Text from a monitor or an alert, made safe to put in the HTML body. */
const html = (text: string) =>
  defuse(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text from a monitor or an alert, made safe to put in a card: nothing in it is read as formatting. */
const md = (text: string) => defuse(text).replace(/([\\`*_~|>[\]])/g, '\\$1');

/** An address in a card, set as code. */
const code = (text: string) => `\`${defuse(text).replace(/`/g, "'")}\``;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function card(title: string, description: string, fields: NotificationCard['fields'], at?: Date): NotificationCard {
  return {
    title: clip(defuse(title), CARD_TITLE_MAX),
    description: clip(description, CARD_TEXT_MAX),
    fields: fields
      .filter(field => field.value.trim() !== '')
      .slice(0, 25)
      .map(field => ({ ...field, name: clip(field.name, FIELD_NAME_MAX), value: clip(field.value, FIELD_VALUE_MAX) })),
    ...(at ? { at } : {}),
  };
}

// ─── The probes ─────────────────────────────────────────────────────────────

type Standing = 'failing' | 'not reporting' | 'fine';
const STANDINGS: Standing[] = ['failing', 'not reporting', 'fine'];
const MARK: Record<Standing, string> = { failing: '🔴', 'not reporting': '⚪', fine: '🟢' };

const standingOf = (probe: ProbeVerdict): Standing => (probe.silent ? 'not reporting' : probe.breaching ? 'failing' : 'fine');

/** The probes of a monitor measured from more than one, the failing ones first; none for a monitor with one. */
function probesOf(event: AlertEvent): ProbeVerdict[] {
  const probes = event.probeVerdicts ?? [];
  if (probes.length < 2) return [];
  return [...probes].sort((a, b) => STANDINGS.indexOf(standingOf(a)) - STANDINGS.indexOf(standingOf(b)));
}

/** "1 of 2 failing", with how many are not reporting and what the alert needs when that is not just one. */
function probeSummary(event: AlertEvent): string {
  const probes = probesOf(event);
  const failing = probes.filter(probe => standingOf(probe) === 'failing').length;
  const silent = probes.filter(probe => standingOf(probe) === 'not reporting').length;
  const policy = policyOf(event.rule);
  return [
    `${failing} of ${probes.length} failing`,
    silent > 0 ? `${silent} not reporting` : '',
    policy.kind !== 'any' ? `the alert needs ${describePolicy(policy, probes.length)}` : '',
  ].filter(Boolean).join(', ');
}

/** Each probe on a line of its own: "🔴 Home: failing". */
function probeLines(event: AlertEvent, escape: (text: string) => string): string[] {
  const probes = probesOf(event);
  const lines = probes.slice(0, PROBES_SHOWN).map(probe => `${MARK[standingOf(probe)]} ${escape(probe.name)}: ${standingOf(probe)}`);
  if (probes.length > PROBES_SHOWN) lines.push(`and ${probes.length - PROBES_SHOWN} more`);
  return lines;
}

/** The probes on one line, for a monitor among several: "🔴 Home · 🟢 Office". */
function probeRow(event: AlertEvent, escape: (text: string) => string): string {
  const probes = probesOf(event);
  const shown = probes.slice(0, PROBES_SHOWN).map(probe => `${MARK[standingOf(probe)]} ${escape(probe.name)}`);
  if (probes.length > PROBES_SHOWN) shown.push(`and ${probes.length - PROBES_SHOWN} more`);
  return shown.join(' · ');
}

// ─── An alert ───────────────────────────────────────────────────────────────

function formatObserved(metric: AlertMetric, observed: number | null): string {
  if (metric === 'unreachable') return observed === 1 ? 'No reply' : 'Replying';
  if (observed === null) return 'No reading';
  const rounded = Math.round(observed * 10) / 10;
  return `${rounded}${ALERT_METRIC_LABELS[metric].unit}`;
}

/** What the reading says now, where that is worth a line: a number, or a monitor answering again. */
function now(event: AlertEvent): string | null {
  // "No reply" says less than the likely cause, which a monitor that is down always has a line for.
  if (event.metric === 'unreachable' && event.transition === 'firing') return null;
  return formatObserved(event.metric, event.observed);
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

function headlineForMany(event: AlertEvent, count: number): string {
  const monitors = plural(count, 'monitor');
  if (event.transition === 'resolved') return `${monitors} have recovered`;
  switch (event.metric) {
    case 'unreachable':
      return `${monitors} are not responding`;
    case 'certExpiry':
      return `Certificates are about to expire on ${monitors}`;
    default:
      return `${ALERT_METRIC_LABELS[event.metric].label} is too high on ${monitors}`;
  }
}

/** The condition, and for how long it has held or been clear, as its two parts. */
function explanation(event: AlertEvent): { condition: string; rest: string } {
  const condition = describeCondition(event.rule);
  const readings = event.rule.consecutiveProbes;
  if (event.transition === 'firing') {
    return { condition, rest: readings === 1 ? ' on the latest reading.' : ` for ${readings} readings in a row.` };
  }
  return { condition, rest: readings === 1 ? ' no longer holds.' : ` has been clear for ${readings} readings in a row.` };
}

/** Each condition as it stood, for an alert with more than one. */
function conditionLines(event: AlertEvent): string[] {
  if (!event.conditions || event.conditions.length < 2) return [];
  return event.conditions.map(each => `${each.label}: ${each.observed ?? 'no reading'}, ${each.held ? 'held' : 'not held'}`);
}

/** Where a monitor measured from one probe was measured from, when that is not the local probe. */
function measuredBy(event: AlertEvent): string | null {
  return probesOf(event).length === 0 && event.probedFrom ? event.probedFrom : null;
}

const listItems = (items: Array<[string, string | null | undefined]>) =>
  items
    .filter((item): item is [string, string] => !!item[1])
    .map(([name, value]) => `<li><b>${name}:</b> ${html(value)}</li>`)
    .join('');

function single(event: AlertEvent, options: NotificationOptions): AlertNotification {
  const { condition, rest } = explanation(event);
  const title = `${options.test ? 'Test: ' : ''}${headline(event)}`;
  const zone = options.zone ?? displayTimeZone();
  const probes = probesOf(event);
  const conditions = conditionLines(event);

  const body =
    `<p><b>${html(condition)}</b>${rest}</p>` +
    (probes.length > 0 ? `<p><b>Probes:</b> ${probeSummary(event)}<br>${probeLines(event, html).join('<br>')}</p>` : '') +
    `<ul>${listItems([
      ['Address', event.targetHost],
      ['Now', now(event)],
      ['Likely cause', event.cause],
      ['Measured by', measuredBy(event)],
      ['Group', event.targetGroup ? groupLabel(event.targetGroup) : null],
      ['Alert', alertTitle(event.rule)],
      ['Conditions', conditions.join('; ')],
      // A chat shows when a message arrived, not when the probe saw the
      // trouble; with its offset, as a message is read in whatever zone its
      // reader is in.
      ['When', formatMoment(event.at, zone)],
    ])}</ul>`;

  const description = `**${md(condition)}**${rest}` + (event.cause ? `\nLikely cause: ${md(event.cause)}` : '');
  const fields: NotificationCard['fields'] = [
    { name: 'Address', value: code(event.targetHost), inline: true },
    { name: 'Now', value: now(event) ?? '', inline: true },
    { name: 'Measured by', value: md(measuredBy(event) ?? ''), inline: true },
    { name: 'Group', value: event.targetGroup ? md(groupLabel(event.targetGroup)) : '', inline: true },
    { name: 'Alert', value: md(alertTitle(event.rule)), inline: true },
    { name: 'Conditions', value: conditions.map(md).join('\n') },
    { name: `Probes: ${probeSummary(event)}`, value: probes.length > 0 ? probeLines(event, md).join('\n') : '' },
  ];

  return {
    title: clip(defuse(title), TITLE_MAX),
    body,
    type: event.transition === 'firing' ? 'failure' : 'success',
    card: card(title, description, fields, event.at),
  };
}

function many(events: AlertEvent[], options: NotificationOptions): AlertNotification {
  const [first] = events;
  const { condition, rest } = explanation(first);
  const title = `${options.test ? 'Test: ' : ''}${headlineForMany(first, events.length)}`;
  const at = new Date(Math.min(...events.map(event => event.at.getTime())));
  const shown = events.slice(0, MONITORS_SHOWN);
  const more = events.length - shown.length;

  // Each monitor: where it is, how it reads, and which of its probes see it.
  const lines = (event: AlertEvent, escape: (text: string) => string, address: (text: string) => string) =>
    [
      [address(event.targetHost), event.targetGroup ? escape(groupLabel(event.targetGroup)) : ''].filter(Boolean).join(' · '),
      now(event) ? `Now: ${now(event)}` : '',
      event.cause ? `Likely cause: ${escape(event.cause)}` : '',
      measuredBy(event) ? `Measured by ${escape(measuredBy(event)!)}` : '',
      probesOf(event).length > 0 ? probeRow(event, escape) : '',
    ].filter(Boolean);

  const body =
    `<p><b>${html(condition)}</b>${rest}</p>` +
    shown.map(event => `<p><b>${html(event.targetName)}</b><br>${lines(event, html, html).join('<br>')}</p>`).join('') +
    (more > 0 ? `<p>And ${plural(more, 'more monitor')}.</p>` : '') +
    `<ul>${listItems([['Alert', alertTitle(first.rule)], ['When', formatMoment(at, options.zone ?? displayTimeZone())]])}</ul>`;

  const fields: NotificationCard['fields'] = [
    ...shown.map(event => ({ name: defuse(event.targetName), value: lines(event, md, code).join('\n') })),
    ...(more > 0 ? [{ name: 'And more', value: `${plural(more, 'more monitor')}` }] : []),
    { name: 'Alert', value: md(alertTitle(first.rule)), inline: true },
  ];

  return {
    title: clip(defuse(title), TITLE_MAX),
    body,
    type: first.transition === 'firing' ? 'failure' : 'success',
    card: card(title, `**${md(condition)}**${rest}`, fields, at),
  };
}

/**
 * One message for an alert that fired, or cleared, on one monitor or on
 * several at once. Every event is the same alert and the same transition:
 * the outbox groups them so (outbox.ts).
 */
export function alertNotification(events: AlertEvent[], options: NotificationOptions = {}): AlertNotification {
  if (events.length === 0) throw new Error('A notification needs at least one event');
  const sorted = [...events].sort((a, b) => a.targetName.localeCompare(b.targetName));
  return sorted.length === 1 ? single(sorted[0], options) : many(sorted, options);
}

/** What to send for an alert firing or clearing on one monitor. */
export function notificationFor(event: AlertEvent, options: NotificationOptions = {}): AlertNotification {
  return alertNotification([event], options);
}

// ─── A probe agent ──────────────────────────────────────────────────────────

/** What to send when a probe agent stops answering, or answers again. */
export function probeAgentNotification(
  name: string,
  change: { kind: 'offline'; reason: string } | { kind: 'online' },
  options: NotificationOptions = {}
): AlertNotification {
  const offline = change.kind === 'offline';
  const at = new Date();
  const title = `${options.test ? 'Test: ' : ''}${offline ? `Probe agent ${name} is offline` : `Probe agent ${name} is back`}`;
  const text = offline
    ? 'The dashboard has had no answer from this probe agent for longer than the time set under Settings, Probes. Monitors that use it have no readings from it until it is back.'
    : 'This probe agent is answering again, and readings from it have started again.';
  const details: Array<[string, string | null]> = [
    ['Probe agent', name],
    ['Why', offline ? change.reason : null],
    ['When', formatMoment(at, options.zone ?? displayTimeZone())],
  ];

  return {
    title: clip(defuse(title), TITLE_MAX),
    body: `<p>${text}</p><ul>${listItems(details)}</ul>`,
    type: offline ? 'failure' : 'success',
    card: card(
      title,
      text,
      [
        { name: 'Probe agent', value: md(name), inline: true },
        { name: 'Why', value: offline ? md(change.reason) : '' },
      ],
      at
    ),
  };
}

// ─── Anything else ──────────────────────────────────────────────────────────

/**
 * A message of ClearPing's own, such as the maintenance report: a line or
 * two, then a few labelled details.
 */
export function plainNotification(
  title: string,
  text: string,
  details: Array<[string, string]>,
  type: AlertNotification['type']
): AlertNotification {
  return {
    title: clip(defuse(title), TITLE_MAX),
    body: `<p>${html(text)}</p>` + (details.length > 0 ? `<ul>${listItems(details)}</ul>` : ''),
    type,
    card: card(title, md(text), details.map(([name, value]) => ({ name: defuse(name), value: md(value) })), new Date()),
  };
}
