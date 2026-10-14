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
}

interface UserRow {
  id: string
  username: string
  password_hash: string
  created_at: number
  last_login_at: number | null
}

const userFrom = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
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

export async function createSession(userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = newToken()
  const now = Date.now()
  const expiresAt = now + SESSION_LIFETIME_MS
  await run(
    await getDatabase(),
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    [tokenHash(token), userId, now, expiresAt, now]
  )
  return { token, expiresAt }
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
}

const DEFAULTS: SecuritySettings = { loginRequired: false, mcpKeyRequired: false }

export async function getSecuritySettings(): Promise<SecuritySettings> {
  const rows = await all<{ key: string; value: string }>(
    await getDatabase(),
    `SELECT key, value FROM settings WHERE key IN ('security.loginRequired', 'security.mcpKeyRequired')`
  )
  const stored = new Map(rows.map(row => [row.key, row.value === 'true']))
  return {
    loginRequired: stored.get('security.loginRequired') ?? DEFAULTS.loginRequired,
    mcpKeyRequired: stored.get('security.mcpKeyRequired') ?? DEFAULTS.mcpKeyRequired,
  }
}

export async function setSecuritySettings(changes: Partial<SecuritySettings>): Promise<SecuritySettings> {
  const database = await getDatabase()
  for (const [name, value] of Object.entries(changes)) {
    if (typeof value !== 'boolean') continue
    await run(database, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      `security.${name}`,
      String(value),
    ])
  }
  return getSecuritySettings()
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
