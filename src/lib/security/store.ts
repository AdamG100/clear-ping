import { randomUUID } from 'node:crypto'
import type sqlite3 from 'sqlite3'
import { getDatabase } from '../database'
import { decoyHash, hashPassword, KEY_PREFIX, newToken, tokenHash, verifyPassword } from './secrets'

/**
 * Where accounts, sessions, keys, the security switches and the activity
 * record are kept. Everything that reads or writes those tables goes through
 * here.
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

async function one<T>(database: Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await all<T>(database, sql, params))[0]
}

// ─── Who did something ──────────────────────────────────────────────────────

export type KeyAccess = 'read' | 'write'

export type Actor =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'key'; id: string; name: string; access: KeyAccess }
  | { kind: 'anonymous'; name: string }

export const ANONYMOUS: Actor = { kind: 'anonymous', name: 'Anonymous' }

// ─── Accounts ───────────────────────────────────────────────────────────────

export interface User {
  id: string
  username: string
  createdAt: number
  lastLoginAt: number | null
  /** Signs in through the identity provider. */
  sso: boolean
  /** Can also sign in with a password. An account made by signing in through the provider cannot. */
  hasPassword: boolean
}

interface UserRow {
  id: string
  username: string
  password_hash: string
  created_at: number
  last_login_at: number | null
  sso_issuer: string | null
  sso_subject: string | null
}

const userFrom = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  sso: !!row.sso_subject,
  hasPassword: row.password_hash !== '',
})

export const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/

export async function countUsers(): Promise<number> {
  const row = await one<{ count: number }>(await getDatabase(), 'SELECT COUNT(*) AS count FROM users')
  return row?.count ?? 0
}

export async function listUsers(): Promise<User[]> {
  const rows = await all<UserRow>(await getDatabase(), 'SELECT * FROM users ORDER BY created_at')
  return rows.map(userFrom)
}

/** Throws with a reason fit to show when the name is taken or not allowed. */
export async function createUser(username: string, password: string): Promise<User> {
  if (!USERNAME.test(username)) {
    throw new Error('A username is 1 to 64 letters, digits, dots, dashes, underscores or @')
  }
  const database = await getDatabase()
  if (await one(database, 'SELECT 1 FROM users WHERE username = ?', [username])) {
    throw new Error('That username is taken')
  }
  const row: UserRow = {
    id: randomUUID(),
    username,
    password_hash: await hashPassword(password),
    created_at: Date.now(),
    last_login_at: null,
    sso_issuer: null,
    sso_subject: null,
  }
  await run(database, 'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', [
    row.id,
    row.username,
    row.password_hash,
    row.created_at,
  ])
  return userFrom(row)
}

/** The user, if the name and password are right. Takes as long either way. */
export async function checkLogin(username: string, password: string): Promise<User | null> {
  const database = await getDatabase()
  const row = await one<UserRow>(database, 'SELECT * FROM users WHERE username = ?', [username])
  const matches = await verifyPassword(password, row?.password_hash ?? (await decoyHash()))
  if (!row || !matches) return null
  await run(database, 'UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), row.id])
  return userFrom(row)
}

// ─── Single sign-on ─────────────────────────────────────────────────────────

/** The account a person at the identity provider signs in as, if there is one. */
export async function userForSso(issuer: string, subject: string): Promise<User | null> {
  const row = await one<UserRow>(await getDatabase(), 'SELECT * FROM users WHERE sso_issuer = ? AND sso_subject = ?', [issuer, subject])
  return row ? userFrom(row) : null
}

/**
 * A new account for someone signing in through the provider for the first
 * time, under the name the provider gives them, or that name with a number if
 * an account here already has it: an existing account is never taken over by
 * a name that happens to match.
 */
export async function createSsoUser(wanted: string, issuer: string, subject: string): Promise<User> {
  const database = await getDatabase()
  const base = wanted.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 56) || 'user'
  let username = base
  for (let n = 2; await one(database, 'SELECT 1 FROM users WHERE username = ?', [username]); n++) username = `${base}-${n}`

  const row: UserRow = {
    id: randomUUID(),
    username,
    password_hash: '',
    created_at: Date.now(),
    last_login_at: null,
    sso_issuer: issuer,
    sso_subject: subject,
  }
  await run(
    database,
    'INSERT INTO users (id, username, password_hash, created_at, sso_issuer, sso_subject) VALUES (?, ?, ?, ?, ?, ?)',
    [row.id, row.username, row.password_hash, row.created_at, issuer, subject]
  )
  return userFrom(row)
}

/** Have an existing account sign in as this person at the provider. Throws if another account already does. */
export async function linkSso(userId: string, issuer: string, subject: string): Promise<void> {
  const other = await userForSso(issuer, subject)
  if (other && other.id !== userId) throw new Error(`That identity already signs in as ${other.username}`)
  await run(await getDatabase(), 'UPDATE users SET sso_issuer = ?, sso_subject = ? WHERE id = ?', [issuer, subject, userId])
}

export async function unlinkSso(userId: string): Promise<void> {
  await run(await getDatabase(), 'UPDATE users SET sso_issuer = NULL, sso_subject = NULL WHERE id = ?', [userId])
}

export async function noteLogin(userId: string): Promise<void> {
  await run(await getDatabase(), 'UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), userId])
}

export async function getUser(userId: string): Promise<User | null> {
  const row = await one<UserRow>(await getDatabase(), 'SELECT * FROM users WHERE id = ?', [userId])
  return row ? userFrom(row) : null
}

export async function checkPassword(userId: string, password: string): Promise<boolean> {
  const row = await one<UserRow>(await getDatabase(), 'SELECT * FROM users WHERE id = ?', [userId])
  return !!row && (await verifyPassword(password, row.password_hash))
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await run(await getDatabase(), 'UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), userId])
}

export async function deleteUser(userId: string): Promise<boolean> {
  return (await run(await getDatabase(), 'DELETE FROM users WHERE id = ?', [userId])) > 0
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'clearping_session'
/** Signed in for 30 days from the last visit. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
/** How stale "last seen" may get before it is written again: not on every request. */
const TOUCH_AFTER_MS = 5 * 60 * 1000

/** The sign-in at the identity provider a session was made from. */
export interface SsoOrigin {
  issuer: string
  subject: string
  /** The provider's id for its own session, when its ID token gives one. */
  sid: string | null
  idToken: string
}

export async function createSession(userId: string, sso?: SsoOrigin): Promise<{ token: string; expiresAt: number }> {
  const token = newToken()
  const now = Date.now()
  const expiresAt = now + SESSION_LIFETIME_MS
  await run(
    await getDatabase(),
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, sso_issuer, sso_subject, sso_sid, sso_id_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tokenHash(token), userId, now, expiresAt, now, sso?.issuer ?? null, sso?.subject ?? null, sso?.sid ?? null, sso?.idToken ?? null]
  )
  return { token, expiresAt }
}

/** The provider sign-in a session came from, if it came from one. */
export async function sessionSso(token: string): Promise<SsoOrigin | null> {
  const row = await one<{ sso_issuer: string | null; sso_subject: string | null; sso_sid: string | null; sso_id_token: string | null }>(
    await getDatabase(),
    'SELECT sso_issuer, sso_subject, sso_sid, sso_id_token FROM sessions WHERE token_hash = ?',
    [tokenHash(token)]
  )
  if (!row?.sso_issuer || !row.sso_subject) return null
  return { issuer: row.sso_issuer, subject: row.sso_subject, sid: row.sso_sid, idToken: row.sso_id_token ?? '' }
}

/**
 * End the sessions made from a sign-in at the provider that has just ended
 * there. With the provider's session id, the session made from that sign-in;
 * a session whose sign-in did not say its id is taken to be it too if it is
 * the same person's, since nothing else could tell them apart. With only the
 * person, every session they made through the provider. Sessions made with a
 * password are left alone: signing out at the provider says nothing about them.
 *
 * Returns the accounts signed out, for the activity record.
 */
export async function endSsoSessions(issuer: string, who: { sub?: string; sid?: string }): Promise<User[]> {
  const database = await getDatabase()
  let where: string
  let params: unknown[]
  if (who.sid) {
    where = who.sub
      ? 'sso_issuer = ? AND sso_subject = ? AND (sso_sid = ? OR sso_sid IS NULL)'
      : 'sso_issuer = ? AND sso_sid = ?'
    params = who.sub ? [issuer, who.sub, who.sid] : [issuer, who.sid]
  } else {
    where = 'sso_issuer = ? AND sso_subject = ?'
    params = [issuer, who.sub]
  }

  const rows = await all<UserRow>(
    database,
    `SELECT DISTINCT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE ${where.replace(/sso_/g, 'sessions.sso_')}`,
    params
  )
  await run(database, `DELETE FROM sessions WHERE ${where}`, params)
  return rows.map(userFrom)
}

export async function userForSession(token: string): Promise<User | null> {
  const database = await getDatabase()
  const hash = tokenHash(token)
  const row = await one<UserRow & { expires_at: number; last_seen_at: number }>(
    database,
    `SELECT users.*, sessions.expires_at, sessions.last_seen_at
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?`,
    [hash]
  )
  const now = Date.now()
  if (!row) return null
  if (row.expires_at <= now) {
    await run(database, 'DELETE FROM sessions WHERE token_hash = ?', [hash])
    return null
  }
  if (now - row.last_seen_at > TOUCH_AFTER_MS) {
    await run(database, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', [
      now,
      now + SESSION_LIFETIME_MS,
      hash,
    ]).catch(() => {})
  }
  return userFrom(row)
}

export async function endSession(token: string): Promise<void> {
  await run(await getDatabase(), 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash(token)])
}

/** Sign a user out everywhere, but for the session given. */
export async function endOtherSessions(userId: string, keepToken?: string): Promise<void> {
  await run(await getDatabase(), 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [
    userId,
    keepToken ? tokenHash(keepToken) : '',
  ])
}

// ─── Keys ───────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string
  name: string
  /** The start of the key, enough to tell which one it is. Never the key. */
  prefix: string
  access: KeyAccess
  createdAt: number
  createdBy: string | null
  lastUsedAt: number | null
  revokedAt: number | null
}

interface KeyRow {
  id: string
  name: string
  prefix: string
  key_hash: string
  access: KeyAccess
  created_at: number
  created_by: string | null
  last_used_at: number | null
  revoked_at: number | null
}

const keyFrom = (row: KeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  access: row.access,
  createdAt: row.created_at,
  createdBy: row.created_by,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
})

/** The new key itself, which is shown this once and kept only as a hash. */
export async function createApiKey(name: string, access: KeyAccess, createdBy: string | null): Promise<{ key: string; record: ApiKey }> {
  const key = newToken(KEY_PREFIX)
  const row: KeyRow = {
    id: randomUUID(),
    name,
    prefix: key.slice(0, KEY_PREFIX.length + 6),
    key_hash: tokenHash(key),
    access,
    created_at: Date.now(),
    created_by: createdBy,
    last_used_at: null,
    revoked_at: null,
  }
  await run(
    await getDatabase(),
    'INSERT INTO api_keys (id, name, prefix, key_hash, access, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.name, row.prefix, row.key_hash, row.access, row.created_at, row.created_by]
  )
  return { key, record: keyFrom(row) }
}

export async function apiKeyFor(key: string): Promise<ApiKey | null> {
  const database = await getDatabase()
  const row = await one<KeyRow>(database, 'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [tokenHash(key)])
  if (!row) return null
  const now = Date.now()
  if (!row.last_used_at || now - row.last_used_at > TOUCH_AFTER_MS) {
    await run(database, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.id]).catch(() => {})
  }
  return keyFrom(row)
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const rows = await all<KeyRow>(await getDatabase(), 'SELECT * FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC')
  return rows.map(keyFrom)
}

export async function revokeApiKey(id: string): Promise<ApiKey | null> {
  const database = await getDatabase()
  await run(database, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Date.now(), id])
  const row = await one<KeyRow>(database, 'SELECT * FROM api_keys WHERE id = ?', [id])
  return row ? keyFrom(row) : null
}

// ─── The switches ───────────────────────────────────────────────────────────

export interface SecuritySettings {
  /** The dashboard and its API need a signed-in user or a key. */
  loginRequired: boolean
  /** The MCP address needs a key, even to read. Implied by `loginRequired`. */
  mcpKeyRequired: boolean
  /** Accounts may sign in with a password. Off leaves single sign-on as the only way in. */
  passwordLogin: boolean
}

const DEFAULTS: SecuritySettings = { loginRequired: false, mcpKeyRequired: false, passwordLogin: true }

export async function getSecuritySettings(): Promise<SecuritySettings> {
  const rows = await all<{ key: string; value: string }>(
    await getDatabase(),
    `SELECT key, value FROM settings WHERE key IN ('security.loginRequired', 'security.mcpKeyRequired', 'security.passwordLogin')`
  )
  const stored = new Map(rows.map(row => [row.key, row.value === 'true']))
  return {
    loginRequired: stored.get('security.loginRequired') ?? DEFAULTS.loginRequired,
    mcpKeyRequired: stored.get('security.mcpKeyRequired') ?? DEFAULTS.mcpKeyRequired,
    passwordLogin: stored.get('security.passwordLogin') ?? DEFAULTS.passwordLogin,
  }
}

export async function setSecuritySettings(changes: Partial<SecuritySettings>): Promise<SecuritySettings> {
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

/** A setting stored as JSON: the single sign-on configuration. */
export async function getJsonSetting<T>(key: string): Promise<T | null> {
  const row = await one<{ value: string }>(await getDatabase(), 'SELECT value FROM settings WHERE key = ?', [key])
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

// ─── What was done, and by whom ─────────────────────────────────────────────

/** How the change arrived. */
export type Via = 'dashboard' | 'api' | 'mcp'

export interface ActivityEntry {
  id: number
  at: number
  actor: { kind: Actor['kind']; id: string | null; name: string }
  via: Via
  action: string
  detail: string | null
}

/** Kept for a year, then dropped as new entries arrive. */
const KEEP_ACTIVITY_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Note a change in the record. Never throws: failing to write down that
 * something happened must not undo or fail the thing itself.
 */
export async function recordActivity(actor: Actor, via: Via, action: string, detail?: string): Promise<void> {
  try {
    const database = await getDatabase()
    const now = Date.now()
    await run(
      database,
      'INSERT INTO activity (at, actor_kind, actor_id, actor_name, via, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [now, actor.kind, actor.kind === 'anonymous' ? null : actor.id, actor.name, via, action, detail?.slice(0, 2000) ?? null]
    )
    await run(database, 'DELETE FROM activity WHERE at < ?', [now - KEEP_ACTIVITY_MS])
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
