import type { ProbeId } from '@/types/probe-agent'
import { getProbeReadings, type StoredReading } from '../db/database'

/**
 * The day of readings the overview is worked out from, held in memory while
 * anyone is looking at it.
 *
 * Reading all of it was the most expensive thing the dashboard asked for: every
 * reading of every monitor, every minute, for each tab left open, to learn what
 * the last minute added. So only what is new is read, and the whole day again
 * now and then, for anything changed further back (monitors merged, say).
 */

/** How often the whole day is read again. */
const FULL_READ_EVERY_MS = 15 * 60 * 1000
/**
 * How far back from the newest reading is read again. A reading is stamped when
 * it starts and stored when it ends, up to a couple of minutes later through a
 * probe agent, so one can appear behind a newer one.
 */
const SETTLE_MS = 5 * 60 * 1000
/** Let go of it this long after the last time it was asked for. */
const KEPT_MS = 5 * 60 * 1000

export interface DayLine {
  /** What the line is called in the answer. */
  key: string
  monitor: string
  probe: ProbeId
}

type ReadLine = typeof getProbeReadings

interface Held {
  lines: Map<string, StoredReading[]>
  /** The start of the period and the end of the last whole read. */
  start: number
  fullAt: number
  /** One read at a time: two tabs asking together share the work, the second finding it done. */
  turn: Promise<unknown>
  timer?: ReturnType<typeof setTimeout>
}

/** On globalThis, as the scheduler is: route handlers are bundled separately. */
const KEY = Symbol.for('clearping.overview-day')
type DayGlobal = typeof globalThis & { [KEY]?: Held }

function held(): Held {
  return ((globalThis as DayGlobal)[KEY] ??= { lines: new Map(), start: 0, fullAt: 0, turn: Promise.resolve() })
}

/** Let go of what is held. */
export function forgetDay(): void {
  const store = globalThis as DayGlobal
  if (store[KEY]?.timer) clearTimeout(store[KEY].timer)
  delete store[KEY]
}

async function refresh(state: Held, lines: readonly DayLine[], start: number, end: number, read: ReadLine): Promise<Map<string, StoredReading[]>> {
  const full = end - state.fullAt >= FULL_READ_EVERY_MS || start < state.start
  const next = new Map<string, StoredReading[]>()
  for (const line of lines) {
    const kept = full ? undefined : state.lines.get(line.key)
    const newest = kept?.at(-1)?.timestamp
    const from = newest === undefined ? start : Math.max(start, newest - SETTLE_MS)
    const fresh = await read(line.monitor, new Date(from), new Date(end), { probe: line.probe })
    next.set(line.key, [...(kept ?? []).filter(reading => reading.timestamp >= start && reading.timestamp < from), ...fresh])
  }
  state.lines = next
  if (full) {
    state.fullAt = end
    state.start = start
  }
  return next
}

/** Each line's readings from `start` to `end`, oldest first, by its key. */
export function readDay(lines: readonly DayLine[], start: number, end: number, read: ReadLine = getProbeReadings): Promise<Map<string, StoredReading[]>> {
  const state = held()
  const answer = state.turn.then(() => refresh(state, lines, start, end, read))
  state.turn = answer.catch(() => {})

  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(forgetDay, KEPT_MS)
  // Not what keeps the process alive.
  state.timer.unref?.()
  return answer
}
