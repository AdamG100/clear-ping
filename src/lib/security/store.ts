import { authDatabase, getAuth, placeholderEmail, SSO_PROVIDER_ID } from './auth'
import { effectiveKeyAccess, isRole, type KeyAccess, type Role } from './roles'
import { verifyPassword } from './secrets'
import { recordSecurityActivity } from './settings-store'

/**
 * Accounts, sessions and keys: ClearPing's view of what Better Auth keeps
 * (see auth.ts), with ClearPing's rules on top. That there is always an
 * admin; that a key never does more than the account that made it; that a
 * key revoked stays listed, so the activity it was used for still says
 * whose it was. Everything that reads or writes those tables goes through
 * here, or through auth.ts.
 *
 * Better Auth keeps its dates as ISO strings; they are milliseconds here, as
 * everywhere else in ClearPing.
 */

export {
  getJsonSetting,
  getSecuritySettings,
  listActivity,
  setJsonSetting,
  setSecuritySettings,
  type ActivityEntry,
  type SecuritySettings,
} from './settings-store'

export const recordActivity = recordSecurityActivity

// ─── Who did something ──────────────────────────────────────────────────────

export type { KeyAccess, Role }

export type Actor =
  | { kind: 'user'; id: string; name: string; role: Role }
  | { kind: 'key'; id: string; name: string; access: KeyAccess }
  | { kind: 'anonymous'; name: string }

export const ANONYMOUS: Actor = { kind: 'anonymous', name: 'Anonymous' }

/** How the change arrived. */
export type Via = 'dashboard' | 'api' | 'mcp'

const ms = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

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
  role: Role
}

interface UserRow {
  id: string
  username: string | null
  displayUsername: string | null
  name: string
  createdAt: string
  lastLoginAt: string | null
  role: string | null
  hasPassword: number
  sso: number
}

const USER_SELECT = `
  SELECT u.id, u.username, u.displayUsername, u.name, u.createdAt, u.lastLoginAt, u.role,
    EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = 'credential' AND a.password IS NOT NULL AND a.password != '') AS hasPassword,
    EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = '${SSO_PROVIDER_ID}') AS sso
  FROM "user" u`

const userFrom = (row: UserRow): User => ({
  id: row.id,
  // As it was typed; the username itself is kept in lower case, for matching.
  username: row.displayUsername || row.username || row.name,
  createdAt: ms(row.createdAt) ?? 0,
  lastLoginAt: ms(row.lastLoginAt),
  sso: row.sso === 1,
  hasPassword: row.hasPassword === 1,
  // Anything unrecognised is the least, never the most.
  role: isRole(row.role) ? row.role : 'viewer',
})

/** The user as the one making a change: what the activity record and the checks take. */
export function actorOf(user: Pick<User, 'id' | 'username' | 'role'>): Extract<Actor, { kind: 'user' }> {
  return { kind: 'user', id: user.id, name: user.username, role: user.role }
}

export const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/

export async function countUsers(): Promise<number> {
  const db = await authDatabase()
  return (db.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number }).count
}

export async function listUsers(): Promise<User[]> {
  const db = await authDatabase()
  return (db.prepare(`${USER_SELECT} ORDER BY u.createdAt`).all() as UserRow[]).map(userFrom)
}

export async function getUser(userId: string): Promise<User | null> {
  const db = await authDatabase()
  const row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(userId) as UserRow | undefined
  return row ? userFrom(row) : null
}

/** Throws with a reason fit to show when the name is taken or not allowed. */
export async function createUser(username: string, password: string, role: Role): Promise<User> {
  if (!USERNAME.test(username)) {
    throw new Error('A username is 1 to 64 letters, digits, dots, dashes, underscores or @')
  }
  const db = await authDatabase()
  if (db.prepare('SELECT 1 FROM "user" WHERE username = ?').get(username.toLowerCase())) {
    throw new Error('That username is taken')
  }
  let email = placeholderEmail(username)
  for (let n = 2; db.prepare('SELECT 1 FROM "user" WHERE email = ?').get(email); n++) email = placeholderEmail(`${username}-${n}`)

  const auth = await getAuth()
  const { user } = await auth.api.createUser({
    body: { email, password, name: username, role, data: { username: username.toLowerCase(), displayUsername: username } },
  })
  return (await getUser(user.id))!
}

/** Whether this is the account's password. */
export async function checkPassword(userId: string, password: string): Promise<boolean> {
  const db = await authDatabase()
  const row = db.prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'").get(userId) as
    | { password: string | null }
    | undefined
  return !!row?.password && (await verifyPassword(password, row.password))
}

export async function countAdmins(): Promise<number> {
  const db = await authDatabase()
  return (db.prepare(`SELECT COUNT(*) AS count FROM "user" WHERE role = 'admin'`).get() as { count: number }).count
}

/** Would taking this account's admin role away, or the account itself, leave no admin? */
export async function isLastAdmin(userId: string): Promise<boolean> {
  const user = await getUser(userId)
  return user?.role === 'admin' && (await countAdmins()) <= 1
}

/** Change an account's role. Throws, changing nothing, if it would leave no admin. */
export async function setRole(userId: string, role: Role): Promise<User> {
  const user = await getUser(userId)
  if (!user) throw new Error('No such account')
  if (user.role === 'admin' && role !== 'admin' && (await isLastAdmin(userId))) {
    throw new Error('This is the only admin. Make another account an admin first')
  }
  const db = await authDatabase()
  db.prepare('UPDATE "user" SET role = ?, updatedAt = ? WHERE id = ?').run(role, new Date().toISOString(), userId)
  return { ...user, role }
}

/**
 * Remove an account, its sessions and its links to the provider. Its keys are
 * revoked with it: a key does what the account that made it may, and that
 * account is gone. Throws if it is the last admin.
 */
export async function deleteUser(userId: string): Promise<boolean> {
  if (await isLastAdmin(userId)) throw new Error('This is the only admin. Make another account an admin first')
  const db = await authDatabase()
  const remove = db.transaction(() => {
    for (const key of db.prepare('SELECT id FROM apikey WHERE referenceId = ? AND enabled = 1').all(userId) as { id: string }[]) {
      revokeKeyRow(db, key.id)
    }
    db.prepare('DELETE FROM session WHERE userId = ?').run(userId)
    db.prepare('DELETE FROM account WHERE userId = ?').run(userId)
    return db.prepare('DELETE FROM "user" WHERE id = ?').run(userId).changes > 0
  })
  return remove()
}

// ─── Single sign-on ─────────────────────────────────────────────────────────

/** Stop an account signing in through the provider. */
export async function unlinkSso(userId: string): Promise<void> {
  const db = await authDatabase()
  db.prepare('DELETE FROM account WHERE userId = ? AND providerId = ?').run(userId, SSO_PROVIDER_ID)
  db.prepare('UPDATE session SET viaSso = 0, ssoSid = NULL WHERE userId = ?').run(userId)
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** The cookie a session travels in (Better Auth's, under ClearPing's prefix). */
export const SESSION_COOKIE = 'clearping.session_token'

/** The account signed in with these request headers, if any. */
export async function userForHeaders(headers: Headers): Promise<User | null> {
  const auth = await getAuth()
  const found = await auth.api.getSession({ headers }).catch(() => null)
  return found ? getUser(found.user.id) : null
}

/** The sign-in at the identity provider the signed-in session came from, if it came from one. */
export async function sessionSso(headers: Headers): Promise<{ sid: string | null; idToken: string | null } | null> {
  const auth = await getAuth()
  const found = await auth.api.getSession({ headers }).catch(() => null)
  const session = found?.session as { id: string; userId: string; viaSso?: boolean | number | null; ssoSid?: string | null } | undefined
  if (!session || !session.viaSso) return null
  const db = await authDatabase()
  const account = db.prepare('SELECT idToken FROM account WHERE userId = ? AND providerId = ?').get(session.userId, SSO_PROVIDER_ID) as
    | { idToken: string | null }
    | undefined
  return { sid: session.ssoSid ?? null, idToken: account?.idToken ?? null }
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
export async function endSsoSessions(who: { sub?: string; sid?: string }): Promise<User[]> {
  const db = await authDatabase()
  const owners = who.sub
    ? (db.prepare('SELECT userId FROM account WHERE providerId = ? AND accountId = ?').all(SSO_PROVIDER_ID, who.sub) as { userId: string }[])
    : null

  let rows: { id: string; userId: string }[]
  if (who.sid && owners) {
    rows = owners.flatMap(({ userId }) =>
      db
        .prepare('SELECT id, userId FROM session WHERE userId = ? AND viaSso = 1 AND (ssoSid = ? OR ssoSid IS NULL)')
        .all(userId, who.sid) as { id: string; userId: string }[]
    )
  } else if (who.sid) {
    rows = db.prepare('SELECT id, userId FROM session WHERE viaSso = 1 AND ssoSid = ?').all(who.sid) as { id: string; userId: string }[]
  } else {
    rows = (owners ?? []).flatMap(({ userId }) =>
      db.prepare('SELECT id, userId FROM session WHERE userId = ? AND viaSso = 1').all(userId) as { id: string; userId: string }[]
    )
  }

  const remove = db.prepare('DELETE FROM session WHERE id = ?')
  for (const row of rows) remove.run(row.id)
  const users = await Promise.all([...new Set(rows.map(row => row.userId))].map(getUser))
  return users.filter((user): user is User => user !== null)
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
  /** The account that made it, which it can never do more than. */
  ownerId: string | null
  lastUsedAt: number | null
  revokedAt: number | null
}

interface KeyRow {
  id: string
  name: string | null
  start: string | null
  referenceId: string
  enabled: number | null
  lastRequest: string | null
  createdAt: string
  permissions: string | null
  metadata: string | null
}

function parse<T>(text: string | null): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** What a key was made to do, from its permissions. */
function madeFor(permissions: unknown): KeyAccess {
  const granted = (permissions as { clearping?: unknown } | null)?.clearping
  return Array.isArray(granted) && granted.includes('write') ? 'write' : 'read'
}

const keyFrom = (row: KeyRow): ApiKey => {
  const metadata = parse<{ createdBy?: string; revokedAt?: number }>(row.metadata)
  return {
    id: row.id,
    name: row.name ?? '',
    prefix: row.start ?? '',
    access: madeFor(parse(row.permissions)),
    createdAt: ms(row.createdAt) ?? 0,
    createdBy: metadata?.createdBy ?? null,
    ownerId: row.referenceId,
    lastUsedAt: ms(row.lastRequest),
    revokedAt: row.enabled ? null : (metadata?.revokedAt ?? ms(row.createdAt)),
  }
}

/** The new key itself, which is shown this once and kept only as a hash. */
export async function createApiKey(name: string, access: KeyAccess, owner: { id: string; name: string }): Promise<{ key: string; record: ApiKey }> {
  const auth = await getAuth()
  const made = await auth.api.createApiKey({
    body: {
      name,
      userId: owner.id,
      permissions: { clearping: access === 'write' ? ['read', 'write'] : ['read'] },
      metadata: { createdBy: owner.name },
    },
  })
  return { key: made.key, record: (await getApiKey(made.id))! }
}

/**
 * The key, if it is one and not revoked, with `access` as it stands now:
 * never more than the account that made it may do (see effectiveKeyAccess).
 */
export async function apiKeyFor(key: string): Promise<ApiKey | null> {
  const auth = await getAuth()
  const checked = await auth.api.verifyApiKey({ body: { key } }).catch(() => null)
  if (!checked?.valid || !checked.key) return null
  const owner = await getUser(checked.key.referenceId)
  // A maker no longer here: the key went with them.
  if (!owner) return null
  const record = await getApiKey(checked.key.id)
  if (!record) return null
  return { ...record, access: effectiveKeyAccess(madeFor(checked.key.permissions), owner.role) }
}

export async function getApiKey(id: string): Promise<ApiKey | null> {
  const db = await authDatabase()
  const row = db.prepare('SELECT * FROM apikey WHERE id = ?').get(id) as KeyRow | undefined
  return row ? keyFrom(row) : null
}

/** Every key, or with `ownerId` only the keys that account made. */
export async function listApiKeys(ownerId?: string): Promise<ApiKey[]> {
  const db = await authDatabase()
  const rows = (ownerId
    ? db.prepare('SELECT * FROM apikey WHERE referenceId = ? ORDER BY enabled DESC, createdAt DESC').all(ownerId)
    : db.prepare('SELECT * FROM apikey ORDER BY enabled DESC, createdAt DESC').all()) as KeyRow[]
  return rows.map(keyFrom)
}

function revokeKeyRow(db: Awaited<ReturnType<typeof authDatabase>>, id: string) {
  const row = db.prepare('SELECT metadata FROM apikey WHERE id = ?').get(id) as { metadata: string | null } | undefined
  if (!row) return
  const metadata = { ...(parse<Record<string, unknown>>(row.metadata) ?? {}), revokedAt: Date.now() }
  db.prepare('UPDATE apikey SET enabled = 0, metadata = ?, updatedAt = ? WHERE id = ? AND enabled = 1').run(
    JSON.stringify(metadata),
    new Date().toISOString(),
    id
  )
}

/** Stop a key working, at once. It stays listed, marked revoked. */
export async function revokeApiKey(id: string): Promise<ApiKey | null> {
  const db = await authDatabase()
  revokeKeyRow(db, id)
  return getApiKey(id)
}
