/**
 * Which time zone ClearPing's times are shown in.
 *
 * Set with `TZ` in the container's environment (the compose file), the same
 * variable that sets the container's own clock: then the server's logs, the
 * alerts it sends, the nightly clean-up and every time on the page agree, in
 * one zone, whoever is looking and from wherever. Without it the page shows
 * each person their own time, as it always did.
 *
 * The browser cannot read the server's environment, and a page built ahead of
 * time would carry whatever `TZ` the build had, so the root layout reads it on
 * each request and hands it over on <html data-time-zone>.
 */

/** The zone `value` names, in the spelling Intl uses, or null if it names none. */
export function configuredTimeZone(value: string | undefined | null): string | null {
  // POSIX lets TZ start with a colon (":Europe/London"); the name is the same.
  const zone = value?.trim().replace(/^:/, '')
  if (!zone) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/**
 * The zone to show times in: the configured one, or undefined for the
 * viewer's own. In the browser it is the one the page was handed; on the
 * server, where a page is first drawn and alerts are written, it is TZ.
 */
export function displayTimeZone(): string | undefined {
  if (typeof document !== 'undefined') return document.documentElement.dataset.timeZone || undefined
  return configuredTimeZone(process.env.TZ) ?? undefined
}

/** Options for toLocaleString and friends, set to the zone times are shown in. */
export function inDisplayZone<T extends Intl.DateTimeFormatOptions>(options: T): T & { timeZone?: string } {
  return { ...options, timeZone: displayTimeZone() }
}

/** The zone named, or the one this machine is in. */
function resolveZone(zone: string | undefined): string {
  return zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone
}

// ─── The calendar in a zone ─────────────────────────────────────────────────

/** A moment as a clock on the wall in some zone reads it. Months run from 1. */
export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>()

function clockFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = clockFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      // h23: midnight is 0, where some engines say 24 for it under h24.
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    clockFormatters.set(zone, formatter)
  }
  return formatter
}

/** What the clock reads at `time` in `zone` (the machine's own if none). */
export function wallClock(time: number, zone?: string): WallClock {
  const parts: Record<string, number> = {}
  for (const part of clockFormatter(resolveZone(zone)).formatToParts(new Date(time))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second }
}

/** How far ahead of UTC `zone` is at `time`, in milliseconds. */
export function zoneOffset(time: number, zone?: string): number {
  const clock = wallClock(time, zone)
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second)
  // The wall clock has no milliseconds to compare, so neither does this.
  return asUtc - Math.floor(time / 1000) * 1000
}

/**
 * The moment the clock in `zone` reads the given date and time. Days and
 * hours past the end of their month or day roll over, as Date.UTC's do.
 *
 * A time the clocks skipped (the hour lost in spring) comes back as the
 * moment after the gap; one they passed twice, as the first of the two.
 */
export function zonedTime(year: number, month: number, day: number, hour = 0, minute = 0, zone?: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  // The offsets in force a day either side: across a change of the clocks,
  // the two that could apply. A candidate is real if the clock reads the
  // asked-for time at it.
  const before = zoneOffset(asUtc - DAY_MS, zone)
  const after = zoneOffset(asUtc + DAY_MS, zone)
  const real = [asUtc - before, asUtc - after].filter(time => time + zoneOffset(time, zone) === asUtc)
  if (real.length > 0) return Math.min(...real)
  // In the gap. Counted on by the offset from before it, which lands as far
  // past the gap's end as the time asked for is past its start.
  return asUtc - before
}

const DAY_MS = 24 * 60 * 60 * 1000

// ─── Saying when ────────────────────────────────────────────────────────────

const pad = (value: number) => String(value).padStart(2, '0')

/** "GMT+2", "GMT-4:30" or "UTC": how far `zone` is from UTC at `time`. */
export function offsetLabel(time: number, zone?: string): string {
  const minutes = Math.round(zoneOffset(time, zone) / 60_000)
  if (minutes === 0) return 'UTC'
  const sign = minutes > 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(minutes) / 60)
  const rest = Math.abs(minutes) % 60
  return `GMT${sign}${hours}${rest ? `:${pad(rest)}` : ''}`
}

/**
 * A moment, in full and with its offset from UTC, for something read away
 * from ClearPing: a shared trace, an alert in a chat. "2026-10-20 11:05:07
 * GMT+2" means the same thing to whoever reads it, in whatever zone.
 */
export function formatMoment(at: Date, zone: string | undefined = displayTimeZone()): string {
  const time = at.getTime()
  const clock = wallClock(time, zone)
  return (
    `${clock.year}-${pad(clock.month)}-${pad(clock.day)} ` +
    `${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)} ${offsetLabel(time, zone)}`
  )
}
