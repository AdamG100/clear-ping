import { randomBytes } from 'node:crypto'
import { sameSecret } from './secrets'

/**
 * What the first account needs besides a password.
 *
 * While there is no account, /api/auth/register is open to whoever reaches
 * ClearPing first, and the account it makes is an admin. So it also asks for a
 * code that only the person running the server can read: CLEARPING_SETUP_CODE
 * if that is set, otherwise one made at start-up and written to the server's
 * log (`docker logs clear_ping`). Not asked while CLEARPING_AUTH=off is set,
 * which already proves access to the server's settings.
 */

const KEY = Symbol.for('clearping.setupCode')
type Holder = typeof globalThis & { [KEY]?: string }

export function setupCode(): string {
  const fixed = process.env.CLEARPING_SETUP_CODE?.trim()
  if (fixed) return fixed
  // On globalThis for the reason the scheduler is: route handlers are bundled
  // apart, and each would otherwise make a code of its own.
  const store = globalThis as Holder
  return (store[KEY] ??= randomBytes(10).toString('base64url'))
}

export function setupCodeMatches(given: unknown): boolean {
  return typeof given === 'string' && given.trim() !== '' && sameSecret(given.trim(), setupCode())
}

/** Writes the code to the log, once, for an install with no account. */
export function announceSetupCode(): void {
  if (process.env.CLEARPING_SETUP_CODE?.trim()) {
    console.log('[Setup] No account yet. Creating the first one asks for CLEARPING_SETUP_CODE.')
    return
  }
  console.log(`[Setup] No account yet. Creating the first one asks for this setup code: ${setupCode()}`)
}
