import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'

/**
 * Moving the accounts and keys made before Better Auth into its tables, once,
 * at the first start after the upgrade.
 *
 * - An account keeps its id (the activity record names accounts by it), its
 *   role, its password (ClearPing's scrypt hash, which sign-in still reads),
 *   and its link to the identity provider.
 * - A key keeps working: both kept a SHA-256 of it, ClearPing's in hex and
 *   Better Auth's in base64url, so the hash is written again in the other
 *   encoding. A revoked key stays revoked, and listed. A key from before
 *   roles, with no maker on record, is given to the account named as having
 *   made it, or else to the first admin.
 * - Sessions are not moved: everyone signs in once more.
 *
 * The old tables are left where they are, unread, in case the upgrade has to
 * be undone.
 */

const DONE = 'auth.legacyMoved'

interface LegacyUser {
  id: string
  username: string
  password_hash: string
  created_at: number
  last_login_at: number | null
  sso_subject: string | null
  role: string | null
}

interface LegacyKey {
  id: string
  name: string
  prefix: string
  key_hash: string
  access: string
  created_at: number
  created_by: string | null
  owner_id: string | null
  last_used_at: number | null
  revoked_at: number | null
}

const iso = (millis: number | null | undefined) => (millis ? new Date(millis).toISOString() : null)
const newId = () => randomBytes(24).toString('base64url')

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

export async function moveLegacyAccounts(db: Database.Database): Promise<{ users: number; keys: number } | null> {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(DONE)) return null

  const move = db.transaction(() => {
    let users = 0
    let keys = 0

    if (hasTable(db, 'users')) {
      const legacy = db.prepare('SELECT * FROM users ORDER BY created_at').all() as LegacyUser[]
      const insertUser = db.prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, username, displayUsername, role, banned, lastLoginAt)
         VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, 0, ?)`
      )
      const insertAccount = db.prepare(
        `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      for (const user of legacy) {
        if (db.prepare('SELECT 1 FROM "user" WHERE id = ?').get(user.id)) continue
        const created = iso(user.created_at) ?? new Date().toISOString()
        let email = `${user.username.toLowerCase()}@users.clearping.invalid`
        if (db.prepare('SELECT 1 FROM "user" WHERE email = ?').get(email)) email = `${user.id}@users.clearping.invalid`
        insertUser.run(user.id, user.username, email, created, created, user.username.toLowerCase(), user.username, user.role ?? 'admin', iso(user.last_login_at))
        if (user.password_hash) insertAccount.run(newId(), user.id, 'credential', user.id, user.password_hash, created, created)
        if (user.sso_subject) insertAccount.run(newId(), user.sso_subject, 'sso', user.id, null, created, created)
        users++
      }
    }

    if (hasTable(db, 'api_keys')) {
      const legacy = db.prepare('SELECT * FROM api_keys ORDER BY created_at').all() as LegacyKey[]
      const firstAdmin = db.prepare(`SELECT id FROM "user" WHERE role = 'admin' ORDER BY createdAt LIMIT 1`).get() as { id: string } | undefined
      const insertKey = db.prepare(
        `INSERT INTO apikey (id, configId, name, start, referenceId, prefix, key, enabled, rateLimitEnabled, rateLimitTimeWindow, rateLimitMax,
           requestCount, remaining, lastRequest, expiresAt, createdAt, updatedAt, permissions, metadata)
         VALUES (?, 'default', ?, ?, ?, 'cp_', ?, ?, 0, 86400000, 10, 0, NULL, ?, NULL, ?, ?, ?, ?)`
      )
      for (const key of legacy) {
        if (db.prepare('SELECT 1 FROM apikey WHERE id = ?').get(key.id)) continue
        const named = key.created_by
          ? (db.prepare('SELECT id FROM "user" WHERE username = ?').get(key.created_by.toLowerCase()) as { id: string } | undefined)
          : undefined
        const owner = key.owner_id && db.prepare('SELECT 1 FROM "user" WHERE id = ?').get(key.owner_id) ? key.owner_id : named?.id ?? firstAdmin?.id
        if (!owner) continue
        const created = iso(key.created_at) ?? new Date().toISOString()
        insertKey.run(
          key.id,
          key.name,
          key.prefix,
          owner,
          Buffer.from(key.key_hash, 'hex').toString('base64url'),
          key.revoked_at ? 0 : 1,
          iso(key.last_used_at),
          created,
          iso(key.revoked_at) ?? created,
          JSON.stringify({ clearping: key.access === 'write' ? ['read', 'write'] : ['read'] }),
          JSON.stringify({ createdBy: key.created_by, ...(key.revoked_at ? { revokedAt: key.revoked_at } : {}) })
        )
        keys++
      }
    }

    db.prepare("INSERT INTO settings (key, value) VALUES (?, 'true') ON CONFLICT(key) DO NOTHING").run(DONE)
    return { users, keys }
  })

  const moved = move()
  if (moved.users || moved.keys) {
    console.log(`Sign-in: moved ${moved.users} account(s) and ${moved.keys} key(s) to Better Auth`)
  }
  return moved
}
