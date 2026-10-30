/**
 * How long a key lasts: a number of days from when it is made, or no end.
 * Pure, so that the form, the routes and the tests agree on what is allowed.
 */

/** The longest a key can be made to last, in days (ten years). */
export const MAX_KEY_DAYS = 3650

/** The choices the form offers: days, and null for a key that never stops. */
export const KEY_LIFETIMES: Array<{ days: number | null; label: string }> = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: null, label: 'No expiry' },
]

/**
 * The days a request asks for: none given or null is no end, otherwise a
 * whole number from 1 to `MAX_KEY_DAYS`.
 */
export function parseKeyDays(value: unknown): { days: number | null } | { error: string } {
  if (value === undefined || value === null) return { days: null }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_KEY_DAYS) {
    return { error: `Choose how many days the key lasts, from 1 to ${MAX_KEY_DAYS}, or no expiry` }
  }
  return { days: value }
}

/** "in 6 days", "tomorrow", "today" or "expired": how long a key has left, for a person to read. */
export function describeTimeLeft(expiresAt: number, now = Date.now()): string {
  const left = expiresAt - now
  if (left <= 0) return 'expired'
  const days = Math.ceil(left / (24 * 60 * 60 * 1000))
  if (left < 24 * 60 * 60 * 1000) return 'today'
  return days === 1 ? 'tomorrow' : `in ${days} days`
}
