import type { Traceroute, TracerouteHop } from '@/types/probe'
import { classifyHost, FAMILY_LABEL, type AddressFamily } from './host'
import { mean } from './metrics'
import { displayTimeZone, formatMoment, wallClock } from './time-zone'
import { firstDeadHop, hopLoss, pathLoss } from './traceroute-parse'

/**
 * A traceroute read the way the dashboard reads it, and written out for
 * somebody else: as text to paste into a chat or a ticket, and as a page of
 * its own to send to whoever runs the network it went wrong in. A route taken
 * while something was broken is evidence, and it is usually needed by someone
 * who has no way into this dashboard.
 */

/** What was traced, as the person sharing it knows it. */
export interface TraceSubject {
  name: string
  host: string
  /** The zone to give times in; the one ClearPing shows times in if left out. */
  zone?: string
}

/** Which family a trace went over, read from the address it was traced to. */
export function traceFamily(trace: Pick<Traceroute, 'address'>): AddressFamily | null {
  const kind = classifyHost(trace.address)
  return kind === 'ipv4' ? 4 : kind === 'ipv6' ? 6 : null
}

/** A line saying how the trace went, and whether that was good. */
export function traceSummary(trace: Traceroute): { text: string; tone: 'ok' | 'bad' } {
  if (trace.hops.length === 0) {
    return { text: trace.errorMessage ?? 'No hops recorded', tone: 'bad' }
  }
  if (trace.reached) {
    return { text: `Reached in ${trace.hops.length} hop${trace.hops.length === 1 ? '' : 's'}`, tone: 'ok' }
  }

  const dead = firstDeadHop(trace.hops, trace.reached)
  if (dead === null) return { text: `Did not reach ${trace.address}`, tone: 'bad' }
  return {
    text: dead <= 1 ? 'No replies from the first hop on' : `No replies beyond hop ${dead - 1}`,
    tone: 'bad',
  }
}

/** How long the whole path took: the average reply from the target itself. */
export function endToEnd(trace: Traceroute): number | null {
  return trace.reached ? mean(trace.hops.at(-1)?.rtts ?? []) : null
}

/** Milliseconds, to a tenth where that matters and whole where it does not. */
export function formatMs(value: number): string {
  return value.toFixed(value < 10 ? 1 : 0)
}

/**
 * How a hop stands, which is what its mark on the path is drawn from.
 *
 * `silent` is a router that did not answer while later ones did. It is
 * forwarding traffic and declining to reply, and calling it the fault is the
 * classic misreading of a traceroute, so it is drawn as a gap in what is
 * known and not as a failure. `dead` is where replies stop for good.
 */
export type HopState = 'answered' | 'lossy' | 'silent' | 'dead' | 'destination'

export interface HopReading {
  hop: TracerouteHop
  state: HopState
  /** Traffic lost at this hop; see pathLoss. */
  loss: number
  /** Replies missing from a router that passed every packet on regardless. */
  limited: boolean
}

/** Each hop of a trace with how it stands, and the hop replies stopped at, if they did. */
export function readHops(trace: Traceroute): { hops: HopReading[]; dead: number | null } {
  const dead = firstDeadHop(trace.hops, trace.reached)
  const losses = pathLoss(trace.hops)
  const last = trace.hops.at(-1)

  const hops = trace.hops.map((hop, index): HopReading => {
    const loss = losses[index]
    const state: HopState =
      dead !== null && hop.hop >= dead ? 'dead'
      : hop.rtts.length === 0 ? 'silent'
      : trace.reached && hop === last ? 'destination'
      : loss > 0 ? 'lossy'
      : 'answered'
    return { hop, state, loss, limited: hopLoss(hop) > loss }
  })

  return { hops, dead }
}

/** What to say about the hop replies stopped at. */
export function deadHopAdvice(trace: Traceroute, dead: number): string {
  // Seen on a network whose IPv6 ends at the provider's first routers: easily
  // read as the target's fault.
  return traceFamily(trace) === 6 && dead <= 4
    ? "IPv6 stops inside the provider's own network, so this machine has no working IPv6 path past it."
    : 'The fault is at that hop or just beyond the last one that replied.'
}

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * A moment on the clock times are shown in, with its offset from UTC. A
 * shared trace is read in other time zones, and a time with no zone on it
 * would be lined up against their logs wrongly.
 */
const when = (at: Date, subject: TraceSubject) => formatMoment(at, subject.zone ?? displayTimeZone())

/** "Route to web (example.com → 93.184.216.34) over IPv4", with whatever adds nothing left out. */
function heading(trace: Traceroute, subject: TraceSubject): string {
  const family = traceFamily(trace)
  const where = subject.host === trace.address ? trace.address : `${subject.host} → ${trace.address}`
  const to = subject.name && subject.name !== subject.host ? `${subject.name} (${where})` : where
  return `Route to ${to}${family ? ` over ${FAMILY_LABEL[family]}` : ''}`
}

function taken(trace: Traceroute, subject: TraceSubject): string {
  return `Taken ${when(trace.timestamp, subject)}${trace.trigger === 'alert' ? ', automatically when an alert fired' : ''}`
}

function routerText(hop: TracerouteHop): string {
  if (hop.address === null) return '*'
  return hop.hostname ? `${hop.hostname} (${hop.address})` : hop.address
}

function lossText(reading: HopReading): string {
  // A router that never answers while the ones after it do is passing the
  // traffic on: "100%" beside it, with no grey to soften it as the dashboard
  // has, would be read as the fault.
  if (reading.state === 'silent') return '-'
  return reading.limited ? '0%*' : `${reading.loss.toFixed(0)}%`
}

const LIMITED_NOTE =
  '* Some replies from this router did not come, but every router after it answered in full: ' +
  'it is slow to answer traceroute probes, not losing traffic.'

/**
 * The trace as plain text, in columns, for pasting where formatting is lost:
 * a chat, a ticket, an email to a provider's support desk.
 */
export function traceAsText(trace: Traceroute, subject: TraceSubject): string {
  const { hops, dead } = readHops(trace)
  const summary = traceSummary(trace)
  const took = endToEnd(trace)
  const lines = [
    heading(trace, subject),
    taken(trace, subject),
    `${summary.text}${took === null ? '' : `, ${formatMs(took)} ms end to end`}`,
  ]
  if (hops.length === 0) return lines.join('\n')

  const blank = '-'
  const rows = hops.map(reading => {
    const { hop } = reading
    const replied = hop.rtts.length > 0
    return [
      String(hop.hop),
      routerText(hop),
      lossText(reading),
      replied ? formatMs(mean(hop.rtts) ?? 0) : blank,
      replied ? formatMs(Math.min(...hop.rtts)) : blank,
      replied ? formatMs(Math.max(...hop.rtts)) : blank,
    ]
  })
  const header = ['Hop', 'Router', 'Loss', 'Avg ms', 'Min', 'Max']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)))
  // The router's name reads from the left; every figure lines up on the right.
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => (column === 1 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
      .join('  ')
      .trimEnd()

  lines.push('', line(header), ...rows.map(line))
  if (dead !== null) lines.push('', `Nothing answered from hop ${dead} onwards. ${deadHopAdvice(trace, dead)}`)
  if (hops.some(reading => reading.limited)) lines.push('', LIMITED_NOTE)
  return lines.join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A name for the downloaded page: which target, and when, so a folder of them sorts. */
export function traceFileName(trace: Traceroute, subject: TraceSubject): string {
  const slug = (subject.name || subject.host)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'target'
  const at = wallClock(trace.timestamp.getTime(), subject.zone ?? displayTimeZone())
  const stamp = `${at.year}-${pad(at.month)}-${pad(at.day)}-${pad(at.hour)}${pad(at.minute)}`
  const family = traceFamily(trace)
  return `route-${slug}${family ? `-ipv${family}` : ''}-${stamp}.html`
}

/** Styles for the page, which has to stand alone: nothing is loaded from anywhere. */
const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --page: #f4f5f6; --card: #ffffff; --text: #1b1f23; --muted: #646b73; --border: #e2e5e8;
  --track: #eceef0; --ok: oklch(0.58 0.15 150); --warn: oklch(0.60 0.18 50); --bad: oklch(0.53 0.22 25);
  --info: oklch(0.52 0.1 222); --bar: oklch(0.42 0.03 250);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #121212; --card: #1b2024; --text: oklch(0.96 0.004 240); --muted: oklch(0.70 0.014 240);
    --border: #2b3237; --track: #272e34; --ok: oklch(0.75 0.15 150); --warn: oklch(0.73 0.19 50);
    --bad: oklch(0.66 0.21 25); --info: oklch(0.80 0.09 215); --bar: oklch(0.85 0.02 250);
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px; background: var(--page); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 960px; margin: 0 auto; }
h1 { margin: 0; font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
.mono, td.num, .address { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.meta { margin: 6px 0 0; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; }
.chip.info { color: var(--info); border-color: color-mix(in oklab, var(--info) 45%, transparent); }
.chip.alert { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 45%, transparent); }
.card { margin-top: 20px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 16px 20px; }
.summary { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; font-size: 16px; font-weight: 600; }
.summary.ok { color: var(--ok); } .summary.bad { color: var(--bad); }
.summary .took { color: var(--muted); font-weight: 400; font-size: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 0 12px 8px 0; white-space: nowrap; }
th.num, td.num { text-align: right; }
td { padding: 6px 12px 6px 0; vertical-align: middle; }
tr.dead td { background: color-mix(in oklab, var(--bad) 6%, transparent); }
td.path { position: relative; width: 40px; padding: 0; }
td.path::before, td.path::after { content: ""; position: absolute; left: 50%; width: 0; border-left: 1px solid var(--border); }
td.path::before { top: 0; bottom: 50%; } td.path::after { top: 50%; bottom: 0; }
tr:first-child td.path::before, tr:last-child td.path::after { display: none; }
tr.dead td.path::before, tr.dead td.path::after, tr.before-dead td.path::after { border-left: 1px dashed color-mix(in oklab, var(--bad) 55%, transparent); }
.node { position: relative; z-index: 1; margin: 0 auto; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-size: 11px; border: 1px solid var(--border); background: var(--card); }
.node.answered { border-color: color-mix(in oklab, var(--ok) 55%, transparent); background: color-mix(in oklab, var(--ok) 12%, var(--card)); }
.node.lossy { border-color: var(--warn); background: color-mix(in oklab, var(--warn) 16%, var(--card)); }
.node.silent { border-style: dashed; color: var(--muted); }
.node.dead { border-color: var(--bad); color: var(--bad); background: color-mix(in oklab, var(--bad) 14%, var(--card)); }
.node.destination { border-color: var(--ok); background: var(--ok); color: var(--card); font-weight: 600; }
.router { overflow-wrap: anywhere; }
.router .address { display: block; color: var(--muted); font-size: 11px; }
.router .quiet { color: var(--muted); }
.router .note { display: block; color: var(--muted); font-size: 11px; }
.dead .router .quiet { color: var(--bad); }
.loss-warn { color: var(--warn); font-weight: 600; } .loss-bad { color: var(--bad); font-weight: 600; }
.faint { color: var(--muted); }
td.bar { width: 32%; min-width: 120px; padding-right: 0; }
.track { position: relative; height: 6px; border-radius: 999px; background: var(--track); }
.range { position: absolute; top: 0; bottom: 0; min-width: 4px; border-radius: 999px; opacity: .4; }
.avg { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; box-shadow: 0 0 0 2px var(--card); }
.scale { display: flex; justify-content: space-between; font-weight: 400; }
.notice { margin-top: 16px; padding: 12px 14px; border-radius: 12px; border: 1px solid color-mix(in oklab, var(--bad) 40%, transparent);
  background: color-mix(in oklab, var(--bad) 8%, transparent); }
.notice strong { color: var(--bad); display: block; }
.footnote { margin: 12px 0 0; color: var(--muted); font-size: 12px; }
footer { margin-top: 20px; color: var(--muted); font-size: 12px; }
@media (max-width: 640px) {
  body { padding: 20px 12px; } .card { padding: 14px 12px; }
  .wide { display: none; }
}
`

/**
 * The trace as a page of its own: one file, its styles inside it, readable in
 * any browser without ClearPing, and in light or dark as the reader prefers.
 */
export function traceAsHtml(trace: Traceroute, subject: TraceSubject, generatedAt = new Date()): string {
  const { hops, dead } = readHops(trace)
  const summary = traceSummary(trace)
  const took = endToEnd(trace)
  const family = traceFamily(trace)
  const scale = Math.max(1, ...trace.hops.flatMap(hop => hop.rtts))
  const at = (value: number) => `${Math.min(100, (value / scale) * 100).toFixed(2)}%`
  const title = heading(trace, subject)

  const rows = hops
    .map((reading, index) => {
      const { hop, state, loss, limited } = reading
      const replied = hop.rtts.length > 0
      const average = mean(hop.rtts)
      const nextDead = hops[index + 1]?.state === 'dead'

      const router =
        hop.address === null
          ? `<span class="quiet">No reply</span>${state === 'silent' ? '<span class="note">Does not answer probes. Still passing traffic on.</span>' : ''}`
          : hop.hostname
            ? `${escapeHtml(hop.hostname)}<span class="address">${escapeHtml(hop.address)}</span>`
            : `<span class="mono">${escapeHtml(hop.address)}</span>`

      const lossCell = limited
        ? '<span class="faint">0%*</span>'
        : loss === 0 || state === 'silent'
          ? `<span class="faint">${loss.toFixed(0)}%</span>`
          : `<span class="${state === 'dead' ? 'loss-bad' : 'loss-warn'}">${loss.toFixed(0)}%</span>`

      const colour = state === 'lossy' ? 'var(--warn)' : state === 'destination' ? 'var(--ok)' : 'var(--bar)'
      const bar = replied
        ? `<div class="track"><span class="range" style="left:${at(Math.min(...hop.rtts))};width:calc(${at(Math.max(...hop.rtts))} - ${at(Math.min(...hop.rtts))});background:${colour}"></span>` +
          `<span class="avg" style="left:${at(average ?? 0)};background:${colour}"></span></div>`
        : '<div class="track"></div>'

      const classes = [state === 'dead' && 'dead', nextDead && state !== 'dead' && 'before-dead'].filter(Boolean).join(' ')
      return (
        `<tr${classes ? ` class="${classes}"` : ''}>` +
        `<td class="path"><div class="node ${state} mono">${hop.hop}</div></td>` +
        `<td class="router">${router}</td>` +
        `<td class="num">${lossCell}</td>` +
        `<td class="num">${average === null ? '<span class="faint">-</span>' : formatMs(average)}</td>` +
        `<td class="num wide faint">${replied ? formatMs(Math.min(...hop.rtts)) : '-'}</td>` +
        `<td class="num wide faint">${replied ? formatMs(Math.max(...hop.rtts)) : '-'}</td>` +
        `<td class="bar wide">${bar}</td>` +
        '</tr>'
      )
    })
    .join('\n')

  const table = hops.length === 0 ? '' : `
<table>
  <thead><tr>
    <th style="text-align:center">Hop</th><th>Router</th><th class="num">Loss</th><th class="num">Avg ms</th>
    <th class="num wide">Min</th><th class="num wide">Max</th>
    <th class="wide"><span class="scale mono"><span>0</span><span>${formatMs(scale)} ms</span></span></th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`

  const notice = dead === null ? '' : `
<div class="notice"><strong>Nothing answered from hop ${dead} onwards</strong>${escapeHtml(deadHopAdvice(trace, dead))}</div>`
  const footnote = hops.some(reading => reading.limited) ? `\n<p class="footnote">${escapeHtml(LIMITED_NOTE)}</p>` : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p class="meta">
  ${family ? `<span class="chip info">${FAMILY_LABEL[family]}</span>` : ''}
  ${trace.trigger === 'alert' ? '<span class="chip alert">Taken when an alert fired</span>' : ''}
  <span>${escapeHtml(when(trace.timestamp, subject))}</span>
</p>
<section class="card">
<div class="summary ${summary.tone}"><span>${escapeHtml(summary.text)}</span>${took === null ? '' : `<span class="took mono">${formatMs(took)} ms end to end</span>`}</div>
</section>
${hops.length === 0 ? '' : `<section class="card">${table}${notice}${footnote}
</section>`}
<footer>Traced by ClearPing. Page made ${escapeHtml(when(generatedAt, subject))}.</footer>
</main>
</body>
</html>
`
}
