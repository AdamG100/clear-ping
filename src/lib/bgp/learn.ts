import type { BgpBaseline } from '@/types/bgp'

/**
 * Normal, learned: rather than staying as it was when a prefix was added
 * until someone takes it again, what is normal follows how the prefix is
 * carried, slowly. Pure.
 *
 * - Something new (an upstream, a more-specific, a peer that sees it or
 *   reaches it directly, an exchange the origin offers it at) is normal once
 *   it has been there without a break for LEARN_AFTER_MS. A diversion that
 *   lasts that long is how it is carried now; one that ends before is flagged
 *   for as long as it lasted.
 * - Something normal that has gone is forgotten once it has been gone for
 *   FORGET_AFTER_MS: an upstream dropped, a collector's session closed. Until
 *   then its return is no news.
 * - The networks announcing it are never learned: a new one is what a hijack
 *   looks like, and only you can say it is not one (taking it as normal).
 *
 * What is waiting to be learned or forgotten, and since when, is kept in the
 * baseline itself, so a restart does not start the wait again.
 */

export const LEARN_AFTER_MS = 24 * 60 * 60 * 1000
export const FORGET_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** The parts of normal that are learned, and how one of each is said. */
const PARTS = ['upstreams', 'prefixes', 'exchanges', 'directPeers', 'peers'] as const
type Part = (typeof PARTS)[number]

/** How the prefix is carried now, as takeBaseline says; `exchanges` only when the exchanges were read well. */
export type Carried = Pick<BgpBaseline, 'upstreams' | 'prefixes' | 'peers'> & { directPeers: string[]; exchanges?: string[] }

function held(baseline: BgpBaseline, part: Part): string[] | undefined {
  const values = baseline[part]
  return values?.map(String)
}

function said(part: Part, values: string[], learned: boolean): string {
  const n = values.length
  const is = n === 1 ? 'is' : 'are'
  switch (part) {
    case 'upstreams': {
      const list = values.map(asn => (asn === '0' ? 'Directly connected' : `AS${asn}`)).join(', ')
      return learned ? `${list} ${is} one of its usual upstreams now: it has carried it for a day` : `${list} ${is} no longer usual: it has not carried it for a week`
    }
    case 'prefixes':
      return learned
        ? `${values.join(', ')} ${is} expected now: announced for a day`
        : `${values.join(', ')} ${is} no longer expected: not announced for a week`
    case 'exchanges':
      return learned
        ? `The origin offering it at ${values.join(', ')} is usual now: for a day`
        : `The origin is no longer expected at ${values.join(', ')}: gone from there for a week`
    case 'directPeers':
      return learned
        ? `${n} peer${n === 1 ? '' : 's'} reaching it directly for a day now count${n === 1 ? 's' : ''} as direct`
        : `${n} peer${n === 1 ? '' : 's'} that went over to an upstream a week ago no longer count${n === 1 ? 's' : ''} as direct`
    case 'peers':
      return learned
        ? `${n} collector peer${n === 1 ? '' : 's'} seeing it for a day now count${n === 1 ? 's' : ''} towards how widely it is seen`
        : `${n} collector peer${n === 1 ? '' : 's'} that stopped seeing it a week ago no longer count${n === 1 ? 's' : ''}`
  }
}

/**
 * Normal brought up to date with how the prefix is carried now, at `at`.
 * `changed` says whether it needs saving; `reasons` what was learned or
 * forgotten, in words, for the timeline.
 */
export function learn(baseline: BgpBaseline, carried: Carried, at: number): { baseline: BgpBaseline; changed: boolean; reasons: string[] } {
  const pending = { ...(baseline.pending ?? {}) }
  const missing = { ...(baseline.missing ?? {}) }
  const next: BgpBaseline = { ...baseline }
  const reasons: string[] = []
  let changed = false

  for (const part of PARTS) {
    const now = carried[part]?.map(String)
    const was = held(baseline, part)
    // The exchanges not read well, or normal from before they were recorded: nothing to learn from.
    if (!now || !was) continue
    const nowSet = new Set(now)
    const wasSet = new Set(was)
    const learned: string[] = []
    const forgotten: string[] = []

    for (const value of now) {
      if (wasSet.has(value)) continue
      const key = `${part}:${value}`
      if (pending[key] === undefined) {
        pending[key] = at
        changed = true
      } else if (at - pending[key] >= LEARN_AFTER_MS) {
        learned.push(value)
        delete pending[key]
      }
    }
    for (const value of was) {
      const key = `${part}:${value}`
      if (nowSet.has(value)) continue
      if (missing[key] === undefined) {
        missing[key] = at
        changed = true
      } else if (at - missing[key] >= FORGET_AFTER_MS) {
        forgotten.push(value)
        delete missing[key]
      }
    }
    // A break starts the wait again: what is waiting must be there, or gone, the whole time.
    for (const key of Object.keys(pending)) {
      if (key.startsWith(`${part}:`) && !nowSet.has(key.slice(part.length + 1))) {
        delete pending[key]
        changed = true
      }
    }
    for (const key of Object.keys(missing)) {
      if (key.startsWith(`${part}:`) && nowSet.has(key.slice(part.length + 1))) {
        delete missing[key]
        changed = true
      }
    }

    if (learned.length === 0 && forgotten.length === 0) continue
    changed = true
    const values = [...was.filter(value => !forgotten.includes(value)), ...learned]
    // Kept as they were: AS numbers as numbers, the rest as text.
    ;(next as unknown as Record<Part, (string | number)[]>)[part] = part === 'upstreams' ? values.map(Number) : values.sort()
    if (learned.length > 0) reasons.push(said(part, learned, true))
    if (forgotten.length > 0) reasons.push(said(part, forgotten, false))
  }

  next.pending = pending
  next.missing = missing
  return { baseline: next, changed, reasons }
}
