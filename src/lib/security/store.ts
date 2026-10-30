import { generateRandomString } from 'better-auth/crypto'
import { authDatabase, getAuth, placeholderEmail, SSO_PROVIDER_ID } from './auth'
import type { FactorsOwed } from './factors'
import { effectiveKeyAccess, isRole, type KeyAccess, type Role } from './roles'
import { verifyPassword } from './secrets'
import { getJsonSetting, recordSecurityActivity, setJsonSetting } from './settings-store'

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
  dismissSetupAdvice,
  getFactorPolicy,
  getJsonSetting,
  getSecuritySettings,
  isSetupAdviceDismissed,
  listActivity,
  setCorsOrigins,
  setFactorPolicy,
  setJsonSetting,
  setSecuritySettings,
  type ActivityEntry,
  type SecuritySettings,
} from './settings-store'

export const recordActivity = recordSecurityActivity

// ─── Who did something ──────────────────────────────────────────────────────

export type { KeyAccess, Role }

export type Actor =
  /** `owes`: second factors an admin requires that the account has yet to add (factors.ts). */
  | { kind: 'user'; id: string; name: string; role: Role; owes?: FactorsOwed }
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
  /** Asked for a code from an authenticator app after its password. */
  twoFactor: boolean
  /** How many passkeys it can sign in with. */
  passkeys: number
  /** The primary account (see primaryUserId). */
  primary: boolean
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
  twoFactorEnabled: number | null
  passkeys: number
}

const USER_SELECT = `
  SELECT u.id, u.username, u.displayUsername, u.name, u.createdAt, u.lastLoginAt, u.role,
    EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = 'credential' AND a.password IS NOT NULL AND a.password != '') AS hasPassword,
    EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = '${SSO_PROVIDER_ID}') AS sso,
    u.twoFactorEnabled,
    (SELECT COUNT(*) FROM passkey p WHERE p.userId = u.id) AS passkeys
  FROM "user" u`

const userFrom = (row: UserRow, primaryId: string | null): User => ({
  id: row.id,
  // As it was typed; the username itself is kept in lower case, for matching.
  username: row.displayUsername || row.username || row.name,
  createdAt: ms(row.createdAt) ?? 0,
  lastLoginAt: ms(row.lastLoginAt),
  sso: row.sso === 1,
  hasPassword: row.hasPassword === 1,
  // Anything unrecognised is the least, never the most.
  role: isRole(row.role) ? row.role : 'viewer',
  twoFactor: row.twoFactorEnabled === 1,
  passkeys: row.passkeys ?? 0,
  primary: row.id === primaryId,
})

/** The user as the one making a change: what the activity record and the checks take. */
export function actorOf(user: Pick<User, 'id' | 'username' | 'role'>): Extract<Actor, { kind: 'user' }> {
  return { kind: 'user', id: user.id, name: user.username, role: user.role }
}

export const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/

const PRIMARY = 'auth.primaryUser'

/**
 * The primary account: the first one made, by whoever runs the server. It is
 * always an admin and cannot be removed, nobody else can set its password,
 * and it alone can reset a forgotten password with a code from the server's
 * log, since reading the log is what proves it is theirs. Every other
 * account's password is set by an admin.
 *
 * An install from before there was a primary account takes its oldest admin,
 * once, and keeps it.
 */
export async function primaryUserId(): Promise<string | null> {
  const db = await authDatabase()
  const kept = await getJsonSetting<string>(PRIMARY)
  if (kept && db.prepare('SELECT 1 FROM "user" WHERE id = ?').get(kept)) return kept
  const oldest = db.prepare(`SELECT id FROM "user" WHERE role = 'admin' ORDER BY createdAt LIMIT 1`).get() as { id: string } | undefined
  if (!oldest) return null
  await setJsonSetting(PRIMARY, oldest.id)
  return oldest.id
}

/** Make the first account the primary one. */
export async function makePrimary(userId: string): Promise<void> {
  await setJsonSetting(PRIMARY, userId)
}

export async function countUsers(): Promise<number> {
  const db = await authDatabase()
  return (db.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number }).count
}

/** How many passkeys there are, on every account: none, and the sign-in page does not offer them. */
export async function countPasskeys(): Promise<number> {
  const db = await authDatabase()
  return (db.prepare('SELECT COUNT(*) AS count FROM passkey').get() as { count: number }).count
}

export async function listUsers(): Promise<User[]> {
  const db = await authDatabase()
  const primary = await primaryUserId()
  return (db.prepare(`${USER_SELECT} ORDER BY u.createdAt`).all() as UserRow[]).map(row => userFrom(row, primary))
}

export async function getUser(userId: string): Promise<User | null> {
  const db = await authDatabase()
  const row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(userId) as UserRow | undefined
  return row ? userFrom(row, await primaryUserId()) : null
}

/** Throws with a reason fit to show when the name is taken or not allowed. */
/** The account a username names, ignoring case, with the address Better Auth knows it by. */
export async function findUserByUsername(username: string): Promise<(User & { email: string }) | null> {
  const db = await authDatabase()
  const row = db.prepare(`${USER_SELECT.replace('SELECT u.id,', 'SELECT u.email, u.id,')} WHERE u.username = ?`).get(username.trim().toLowerCase()) as
    | (UserRow & { email: string })
    | undefined
  return row ? { ...userFrom(row, await primaryUserId()), email: row.email } : null
}

/**
 * Why a sign-in with this username failed, for the server's log only: the
 * page says the same thing whatever it was, so as not to tell anyone which
 * accounts exist, and the person who runs the server is left to find out.
 */
export async function signInTrouble(username: string, refusal: string): Promise<string> {
  if (!username) return 'no username was given'
  const user = await findUserByUsername(username)
  if (!user) return 'there is no account by that name'
  if (!user.hasPassword) {
    return user.sso ? 'the account has no password: it signs in through single sign-on' : 'the account has no password'
  }
  return /invalid (username|email) or password/i.test(refusal) ? 'the password is wrong' : refusal
}

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

/**
 * An admin sets another account's password: for someone who has forgotten
 * theirs, or an account made through single sign-on that has none. Better
 * Auth's admin plugin sets it, with the admin's own session as the authority,
 * and every session of the account is ended. Never the primary account's,
 * which is its own business, and never your own, which is changed with the
 * current password.
 */
export async function setPasswordFor(userId: string, password: string, adminHeaders: Headers): Promise<User> {
  const user = await getUser(userId)
  if (!user) throw new Error('No such account')
  if (user.primary) throw new Error('Only the primary account sets its own password. If it is lost, it can be reset with a code from the server log')
  const auth = await getAuth()
  await auth.api.setUserPassword({ body: { userId, newPassword: password }, headers: adminHeaders })
  await auth.api.revokeUserSessions({ body: { userId }, headers: adminHeaders })
  // A password link given out before would set another over this one.
  const db = await authDatabase()
  db.prepare(`DELETE FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'`).run(userId)
  return (await getUser(userId))!
}

/** How long a password link works for: long enough to reach someone, and be opened the next day. */
export const PASSWORD_LINK_HOURS = 48

/**
 * A link for someone to choose their own password, so the admin who made it
 * never knows it: for a new account, or one whose password is forgotten.
 *
 * It is a Better Auth reset token, kept in Better Auth's verification table
 * and redeemed by its own reset (POST /api/auth/password-reset), which lets
 * it be used once and sets the password. Only its lifetime is ClearPing's:
 * Better Auth gives every reset code the quarter of an hour the primary
 * account's code from the log has, too short for a link passed on to someone.
 * A new link replaces any the account had before. Never the primary
 * account's, which only its owner resets.
 */
export async function makePasswordLink(userId: string): Promise<{ token: string; expiresAt: number }> {
  const user = await getUser(userId)
  if (!user) throw new Error('No such account')
  if (user.primary) throw new Error('Only the primary account sets its own password. If it is lost, it can be reset with a code from the server log')

  const db = await authDatabase()
  db.prepare(`DELETE FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'`).run(userId)

  const token = generateRandomString(32, 'a-z', 'A-Z', '0-9')
  const expiresAt = new Date(Date.now() + PASSWORD_LINK_HOURS * 60 * 60 * 1000)
  const context = await (await getAuth()).$context
  await context.internalAdapter.createVerificationValue({ value: userId, identifier: `reset-password:${token}`, expiresAt })
  return { token, expiresAt: expiresAt.getTime() }
}

/**
 * A new account that chooses its own password through a link. Better Auth
 * needs a password to make the account, so it is given a long random one that
 * is never shown or kept anywhere else: until the link is used, there is no
 * password anyone could sign in with.
 */
export async function createUserWithLink(username: string, role: Role): Promise<{ user: User; token: string; expiresAt: number }> {
  const user = await createUser(username, generateRandomString(64), role)
  return { user, ...(await makePasswordLink(user.id)) }
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
  if (user.primary && role !== 'admin') throw new Error('This is the primary account, which is always an admin')
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
  if ((await primaryUserId()) === userId) throw new Error('This is the primary account, which cannot be removed')
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
  return (await signedIn(headers))?.user ?? null
}

/** The account signed in with these request headers, and whether its session came through single sign-on. */
export async function signedIn(headers: Headers): Promise<{ user: User; viaSso: boolean } | null> {
  const auth = await getAuth()
  const found = await auth.api.getSession({ headers }).catch(() => null)
  if (!found) return null
  const user = await getUser(found.user.id)
  const session = found.session as { viaSso?: boolean | number | null }
  return user ? { user, viaSso: !!session.viaSso } : null
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
  /** When it stops working by itself, or null for a key that does not. */
  expiresAt: number | null
  /** How many days it was made to last, which a re-roll repeats. */
  expiresInDays: number | null
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
  const metadata = parse<{ createdBy?: string; revokedAt?: number; expiresAt?: number; expiresInDays?: number }>(row.metadata)
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
    expiresAt: typeof metadata?.expiresAt === 'number' ? metadata.expiresAt : null,
    expiresInDays: typeof metadata?.expiresInDays === 'number' ? metadata.expiresInDays : null,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The new key itself, which is shown this once and kept only as a hash.
 * `expiresInDays` is how long it works for, or null for a key that never
 * stops. The expiry is kept here rather than in Better Auth's own, which
 * deletes a key when it is first used after it: an expired key stays listed,
 * marked, like a revoked one.
 */
export async function createApiKey(
  name: string,
  access: KeyAccess,
  owner: { id: string; name: string },
  expiresInDays: number | null = null,
  rerolledFrom?: string
): Promise<{ key: string; record: ApiKey }> {
  const auth = await getAuth()
  const made = await auth.api.createApiKey({
    body: {
      name,
      userId: owner.id,
      permissions: { clearping: access === 'write' ? ['read', 'write'] : ['read'] },
      metadata: {
        createdBy: owner.name,
        ...(expiresInDays ? { expiresInDays, expiresAt: Date.now() + expiresInDays * DAY_MS } : {}),
        ...(rerolledFrom ? { rerolledFrom } : {}),
      },
    },
  })
  return { key: made.key, record: (await getApiKey(made.id))! }
}

/**
 * A new key in place of one: the same name, level and maker, lasting the same
 * number of days (or `expiresInDays` if given, null for no end), and the old
 * one revoked at once. Null if there is no such key or it is already revoked.
 */
export async function rerollApiKey(id: string, expiresInDays?: number | null): Promise<{ key: string; record: ApiKey; replaced: ApiKey } | null> {
  const old = await getApiKey(id)
  if (!old || old.revokedAt) return null
  const made = await createApiKey(old.name, old.access, { id: old.ownerId ?? '', name: old.createdBy ?? '' }, expiresInDays === undefined ? old.expiresInDays : expiresInDays, old.id)
  const replaced = (await revokeApiKey(old.id)) ?? old
  return { ...made, replaced }
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
  // Past its end: refused like a revoked one.
  if (record.expiresAt !== null && record.expiresAt <= Date.now()) return null
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
