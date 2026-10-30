import type sqlite3 from 'sqlite3'
import { getDatabase } from '../db/database'
import { privacyNow, signInDetail } from '../privacy/current'
import { isFactorPolicy, NO_FACTOR_POLICY, type FactorPolicy } from './factors'
import type { Actor, Via } from './store'

/**
 * The security switches, settings kept as JSON, and the activity record: the
 * part of the security store that sign-in itself (auth.ts) needs, kept apart
 * from the accounts and keys (store.ts) so that neither has to load the other.
 */

type Database = sqlite3.Database

function run(database: Database, sql: string, params: unknown[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (error) {
      if (error) reject(error)
      else resolve(this.changes)
    })
  })
}

function all<T>(database: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => (error ? reject(error) : resolve((rows ?? []) as T[])))
  })
}

// ─── The switches ───────────────────────────────────────────────────────────

export interface SecuritySettings {
  /** The dashboard and its API need a signed-in user or a key. */
  loginRequired: boolean
  /** The MCP address needs a key, even to read. Implied by `loginRequired`. */
  mcpKeyRequired: boolean
  /** Accounts may sign in with a password. Off leaves single sign-on as the only way in. */
  passwordLogin: boolean
  /** Anyone may look, but changing anything needs a signed-in account or a key that may write. Implied by `loginRequired`. */
  changesNeedSignIn: boolean
  /** Other websites (origins) whose pages may call the API from a browser, with a key. See cors.ts. */
  corsOrigins: string[]
}

type Switches = Omit<SecuritySettings, 'corsOrigins'>

const DEFAULTS: Switches = { loginRequired: false, mcpKeyRequired: false, passwordLogin: true, changesNeedSignIn: false }

export async function getSecuritySettings(): Promise<SecuritySettings> {
  const rows = await all<{ key: string; value: string }>(
    await getDatabase(),
    `SELECT key, value FROM settings WHERE key IN ('security.loginRequired', 'security.mcpKeyRequired', 'security.passwordLogin', 'security.changesNeedSignIn', 'security.corsOrigins')`
  )
  const stored = new Map(rows.map(row => [row.key, row.value]))
  const flag = (name: keyof Switches) => (stored.has(`security.${name}`) ? stored.get(`security.${name}`) === 'true' : DEFAULTS[name])
  let corsOrigins: string[] = []
  try {
    const parsed: unknown = JSON.parse(stored.get('security.corsOrigins') ?? '[]')
    if (Array.isArray(parsed)) corsOrigins = parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    // Unreadable is no one listed: the safe way round.
  }
  return {
    loginRequired: flag('loginRequired'),
    mcpKeyRequired: flag('mcpKeyRequired'),
    passwordLogin: flag('passwordLogin'),
    changesNeedSignIn: flag('changesNeedSignIn'),
    corsOrigins,
  }
}

export async function setSecuritySettings(changes: Partial<Switches>): Promise<SecuritySettings> {
  const database = await getDatabase()
  for (const [name, value] of Object.entries(changes)) {
    if (typeof value !== 'boolean' || !(name in DEFAULTS)) continue
    await run(database, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      `security.${name}`,
      String(value),
    ])
  }
  return getSecuritySettings()
}

/** The websites whose pages may call the API (already checked by `parseCorsOrigins`). */
export async function setCorsOrigins(origins: string[]): Promise<void> {
  await setJsonSetting('security.corsOrigins', origins)
}

/** CLEARPING_AUTH=off: sign-in is not asked for, and passwords work, whatever the switches say. */
export function recoveryMode(): boolean {
  return /^(off|0|false|no)$/i.test(process.env.CLEARPING_AUTH?.trim() ?? '')
}

/** The switches as they are in force: CLEARPING_AUTH=off turns password sign-in back on. */
export async function securitySwitches(): Promise<SecuritySettings> {
  const settings = await getSecuritySettings()
  return recoveryMode() ? { ...settings, loginRequired: false, changesNeedSignIn: false, passwordLogin: true } : settings
}

/** A setting stored as JSON: the single sign-on configuration. */
export async function getJsonSetting<T>(key: string): Promise<T | null> {
  const [row] = await all<{ value: string }>(await getDatabase(), 'SELECT value FROM settings WHERE key = ?', [key])
  if (!row) return null
  try {
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}

export async function setJsonSetting(key: string, value: unknown): Promise<void> {
  await run(await getDatabase(), 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    JSON.stringify(value),
  ])
}

const SETUP_ADVICE_DISMISSED = 'security.setupAdviceDismissed'

/** An admin said this ClearPing stays on the network, so the first-run prompt stays away. */
export async function isSetupAdviceDismissed(): Promise<boolean> {
  return (await getJsonSetting<unknown>(SETUP_ADVICE_DISMISSED)) === true
}

export async function dismissSetupAdvice(): Promise<void> {
  await setJsonSetting(SETUP_ADVICE_DISMISSED, true)
}

/** Which second factors an admin requires of the accounts that sign in to ClearPing itself. */
export async function getFactorPolicy(): Promise<FactorPolicy> {
  const stored = await getJsonSetting<unknown>('security.factorPolicy')
  return isFactorPolicy(stored) ? stored : NO_FACTOR_POLICY
}

export async function setFactorPolicy(policy: FactorPolicy): Promise<void> {
  await setJsonSetting('security.factorPolicy', policy)
}

// ─── What was done, and by whom ─────────────────────────────────────────────

export interface ActivityEntry {
  id: number
  at: number
  actor: { kind: Actor['kind']; id: string | null; name: string }
  via: Via
  action: string
  detail: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** What is written down about it: a sign-in's address only where Privacy keeps them. */
export function keptDetail(action: string, detail: string | undefined): string | null {
  const kept = action === 'signin' || action === 'signin.failed' ? signInDetail(detail ?? '') : detail
  return kept?.slice(0, 2000) || null
}

/**
 * Note a change in the record. Never throws: failing to write down that
 * something happened must not undo or fail the thing itself.
 */
export async function recordSecurityActivity(actor: Actor, via: Via, action: string, detail?: string): Promise<void> {
  try {
    const database = await getDatabase()
    const now = Date.now()
    await run(
      database,
      'INSERT INTO activity (at, actor_kind, actor_id, actor_name, via, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [now, actor.kind, actor.kind === 'anonymous' ? null : actor.id, actor.name, via, action, keptDetail(action, detail)]
    )
    // Kept as long as Privacy says (a year unless changed), then dropped as new entries arrive.
    await run(database, 'DELETE FROM activity WHERE at < ?', [now - privacyNow().keepActivityDays * DAY_MS])
  } catch (error) {
    console.error('[Activity] Could not record:', action, error)
  }
}

export async function listActivity(limit = 100, before?: number): Promise<ActivityEntry[]> {
  const rows = await all<{
    id: number
    at: number
    actor_kind: Actor['kind']
    actor_id: string | null
    actor_name: string
    via: Via
    action: string
    detail: string | null
  }>(
    await getDatabase(),
    `SELECT * FROM activity ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    before ? [before, limit] : [limit]
  )
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name },
    via: row.via,
    action: row.action,
    detail: row.detail,
  }))
}
