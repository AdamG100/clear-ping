/**
 * The privacy settings in force, held in memory: read often, and from places
 * that cannot wait on the database (a sign-in recorded inside Better Auth is
 * written synchronously). Held on globalThis, as route handlers are bundled
 * apart and a module-level copy would be one each. Imports nothing, so the
 * activity record can use it without a loop.
 */

/** Who sees addresses hidden on screen. */
export type HideAddresses = 'off' | 'viewers' | 'everyone'

export interface PrivacySettings {
  hideAddresses: HideAddresses
  /** Addresses are hidden in everything AI assistants are given over MCP. */
  hideFromAssistants: boolean
  /** Sign-ins and failed sign-ins in Activity say the IP address they came from. */
  recordSignInAddresses: boolean
  /** How long Activity is kept. */
  keepActivityDays: number
  /** ClearPing asks GitHub's container registry whether a newer version is out. */
  checkForUpdates: boolean
  /** A monitor's page asks RIPE NCC which network holds its address, to say who runs it. */
  lookUpNetworks: boolean
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  hideAddresses: 'off',
  hideFromAssistants: false,
  recordSignInAddresses: true,
  keepActivityDays: 365,
  checkForUpdates: true,
  lookUpNetworks: true,
}

export const KEEP_ACTIVITY_CHOICES = [30, 90, 365] as const

const HELD = Symbol.for('clearping.privacy')

function held(): { settings: PrivacySettings } {
  const store = globalThis as typeof globalThis & { [HELD]?: { settings: PrivacySettings } }
  return (store[HELD] ??= { settings: DEFAULT_PRIVACY })
}

/** The settings as last read or saved: the defaults until then. For code that cannot wait. */
export function privacyNow(): PrivacySettings {
  return held().settings
}

export function holdPrivacy(settings: PrivacySettings): void {
  held().settings = settings
}

/** A sign-in's record, with the address it came from left out where Privacy says so. */
export function signInDetail(detail: string): string {
  if (privacyNow().recordSignInAddresses) return detail
  return detail.replace(/,? ?[Ff]rom \S+$/, '')
}
