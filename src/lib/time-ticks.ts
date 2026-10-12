/**
 * Where the marks go along a chart's time axis, and what each one says.
 *
 * A mark is only useful on a time someone would say out loud: on the hour, on
 * the quarter, at midnight. So the gap between marks is picked from the gaps a
 * clock is read in, the smallest of them that leaves the labels room to be
 * read, and the marks are put on round times by the viewer's own clock rather
 * than at even fractions of whatever period happens to be on screen.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Smallest first. Every one under a day divides a day, so midnight is always a mark. */
const STEPS = [
  5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 28 * DAY,
]

/** The width of one character of an axis label, which is set in 10px mono. */
const CHARACTER_PX = 6
/** Clear space between one label and the next. */
const LABEL_GAP_PX = 12

export interface TimeTick {
  /** Epoch milliseconds. */
  time: number
  label: string
}

/** How many characters a label takes when the marks are `step` apart. */
function labelLength(step: number): number {
  if (step >= DAY) return 'Oct 13'.length
  return step < MINUTE ? '02:30:15 PM'.length : '02:30 PM'.length
}

function labelFor(time: number, step: number): string {
  const date = new Date(time)

  // Midnight is where the date changes, which is worth more than "12:00 AM".
  const midnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0
  if (step >= DAY || midnight) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: step < MINUTE ? '2-digit' : undefined,
  })
}

/** Local midnight at the start of the day `time` falls in. */
function startOfDay(time: number): Date {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date
}

/** Every time from `start` to `end` that is a whole number of `step`s past local midnight. */
function roundTimes(start: number, end: number, step: number): number[] {
  const times: number[] = []

  if (step < HOUR) {
    // Clocks are only ever moved by a multiple of these steps, so counting
    // from the offset in force at the start stays on round minutes throughout.
    const offset = new Date(start).getTimezoneOffset() * MINUTE
    for (let time = Math.ceil((start - offset) / step) * step + offset; time <= end; time += step) times.push(time)
    return times
  }

  // By the calendar from here up, a day at a time: a day is 23 or 25 hours
  // long twice a year, and marks counted out in milliseconds would slide off
  // the hour for the rest of the chart.
  const day = startOfDay(start)
  for (; day.getTime() <= end; day.setDate(day.getDate() + 1)) {
    if (step >= DAY) {
      // Counted from a fixed day, so the marks stay on the same dates as the
      // period on screen moves forward. That day is a Monday (the 1st of
      // January 1970 was a Thursday), so marks a week apart are on Mondays.
      const dayNumber = Math.round(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / DAY) + 3
      if (dayNumber % (step / DAY) === 0) times.push(day.getTime())
      continue
    }
    for (let hour = 0; hour < 24; hour += step / HOUR) {
      const time = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime()
      // An hour the clocks skipped comes back as the one after it.
      if (time !== times[times.length - 1]) times.push(time)
    }
  }
  return times.filter(time => time >= start && time <= end)
}

/**
 * The marks for a period drawn `plotWidth` pixels wide: as many as fit with
 * their labels clear of each other.
 */
export function timeTicks(start: number, end: number, plotWidth: number): TimeTick[] {
  const span = end - start
  if (!Number.isFinite(span) || span <= 0 || plotWidth <= 0) return []

  const fits = (step: number) => (span / step) * (labelLength(step) * CHARACTER_PX + LABEL_GAP_PX) <= plotWidth
  const step = STEPS.find(fits) ?? STEPS[STEPS.length - 1]

  return roundTimes(start, end, step).map(time => ({ time, label: labelFor(time, step) }))
}
