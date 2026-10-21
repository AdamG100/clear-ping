import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { SqliteDialect } from 'kysely'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { admin as adminPlugin, genericOAuth, twoFactor, username as usernamePlugin } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access'
import { apiKey } from '@better-auth/api-key'
import { databasePath, getDatabase } from '../db/database'
import { discover, getSsoConfig, groupsOf, inAllowedGroup, ssoRole, ssoUsable, usernameFrom, type Claims, type SsoConfig } from './oidc'
import { ROLE_LABEL, type Role } from './roles'
import { hashPassword, KEY_PREFIX, newToken, verifyPassword } from './secrets'
import { securitySwitches } from './settings-store'
import type { Actor, Via } from './store'

/**
 * Sign-in, run by Better Auth (https://better-auth.com).
 *
 * Better Auth keeps the accounts, their passwords and sessions, the keys, the
 * roles (its admin plugin) and the sign-in through Authentik (its generic
 * OAuth plugin, which checks the ID token's signature against the provider's
 * keys). What ClearPing adds on top, it adds here and in store.ts:
 *
 * - Usernames, not email addresses. Better Auth wants an email on every
 *   account, so an account without one is given an address on the reserved
 *   `.invalid` domain, which is never shown and never sent to.
 * - The three roles, and that the last admin stays one.
 * - Keys that never do more than the account that made it (store.ts).
 * - Who may sign in through the provider (its group), the roles its groups
 *   give, and which of a person's provider sessions a ClearPing session came
 *   from, so that signing out there ends it here (back-channel logout).
 * - The activity record.
 * - Which second factors an account must have (factors.ts). The factors
 *   themselves, an authenticator app's codes and passkeys, are Better Auth's
 *   two-factor and passkey plugins.
 *
 * Its HTTP endpoints are not opened to the browser, apart from the provider's
 * callback (/api/auth/sso/callback hands it over). Everything else is called
 * from ClearPing's own routes, on the server, which apply ClearPing's rules
 * before and after: a direct call to Better Auth's admin or key endpoints
 * would skip them.
 *
 * The secret that signs cookies is BETTER_AUTH_SECRET where it is set, and
 * otherwise one made at the first start and kept in the database, so an
 * existing install needs no new setting.
 */

/** The provider's id in Better Auth, and in the account table. */
export const SSO_PROVIDER_ID = 'sso'

/** Where an account without an email of its own gets one. `.invalid` is reserved: nothing there exists. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'users.clearping.invalid'

export function placeholderEmail(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}@${PLACEHOLDER_EMAIL_DOMAIN}`
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)
}

/** The three roles, in Better Auth's terms: an admin manages accounts; nobody else does. */
const ac = createAccessControl(defaultStatements)
const ROLES = {
  admin: ac.newRole(adminAc.statements),
  editor: ac.newRole(userAc.statements),
  viewer: ac.newRole(userAc.statements),
}

const SESSION_DAYS = 30

/** How long a password reset code from the server log works for. */
export const RESET_CODE_MINUTES = 15

// â”€â”€â”€ The database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * The connection sign-in uses: the same file as the rest of ClearPing, opened
 * with better-sqlite3, which Better Auth's SQLite support is built on. WAL and
 * a busy timeout let the two connections share it.
 */
function openDatabase(): Database.Database {
  const db = new Database(databasePath())
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  return db
}

/** The secret that signs cookies, made once and kept if not given. */
function authSecret(db: Database.Database): string {
  const given = process.env.BETTER_AUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim()
  if (given) return given
  const row = db.prepare("SELECT value FROM settings WHERE key = 'auth.secret'").get() as { value: string } | undefined
  if (row?.value) return row.value
  const made = randomBytes(32).toString('base64url')
  db.prepare("INSERT INTO settings (key, value) VALUES ('auth.secret', ?) ON CONFLICT(key) DO NOTHING").run(made)
  return (db.prepare("SELECT value FROM settings WHERE key = 'auth.secret'").get() as { value: string }).value
}

/**
 * Note something in the activity record, on sign-in's own connection. What
 * Better Auth does it does inside a transaction on this connection, and a
 * write from ClearPing's other connection meanwhile would wait for it to end,
 * while it waits for the write: the entry goes into the transaction instead.
 * Never throws, as recordActivity does not.
 */
function recordOnAuthDb(db: Database.Database, actor: Actor, via: Via, action: string, detail?: string): void {
  try {
    db.prepare('INSERT INTO activity (at, actor_kind, actor_id, actor_name, via, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      Date.now(),
      actor.kind,
      actor.kind === 'anonymous' ? null : actor.id,
      actor.name,
      via,
      action,
      detail?.slice(0, 2000) ?? null
    )
  } catch (error) {
    console.error('[Activity] Could not record:', action, error)
  }
}

// â”€â”€â”€ Single sign-on â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * What the provider said about whoever is signing in, for the moment between
 * reading it and making their session, when the role their groups give is
 * set. Keyed by the provider's id for them; gone after a minute.
 */
const PROFILE_KEY = Symbol.for('clearping.sso-profiles')
function recentProfiles(): Map<string, { claims: Claims; at: number }> {
  const store = globalThis as typeof globalThis & { [PROFILE_KEY]?: Map<string, { claims: Claims; at: number }> }
  return (store[PROFILE_KEY] ??= new Map())
}
function keepProfile(claims: Claims) {
  const profiles = recentProfiles()
  const now = Date.now()
  for (const [key, entry] of profiles) if (now - entry.at > 60_000) profiles.delete(key)
  profiles.set(claims.sub, { claims, at: now })
}
function profileFor(sub: string): Claims | null {
  return recentProfiles().get(sub)?.claims ?? null
}

/** The ID token's claims, read without checking: Better Auth has checked it before anything here sees it. */
function idTokenClaims(idToken: string | null | undefined): Record<string, unknown> {
  if (!idToken) return {}
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function ssoProvider(db: Database.Database, config: SsoConfig) {
  return {
    providerId: SSO_PROVIDER_ID,
    name: config.label,
    discoveryUrl: config.issuer.replace(/\/?$/, '/') + '.well-known/openid-configuration',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // `profile` is where Authentik puts the username and the person's groups.
    scopes: ['openid', 'profile', 'email'],
    // The address the provider already knows: unchanged by the move to Better Auth.
    redirectURI: config.redirectUri,
    disableSignUp: !config.autoCreate,
    // Signing out at the provider is ClearPing's: only for sessions made through it.
    disableProviderLogout: true,
    /**
     * The ID token's claims (checked by Better Auth before this is called)
     * with what the userinfo address adds: Authentik may leave the groups out
     * of the token. Someone outside the group allowed to use ClearPing is
     * turned away here, before any account is made or session given.
     */
    getUserInfo: async (tokens: { idToken?: string; accessToken?: string }) => {
      const fromToken = idTokenClaims(tokens.idToken)
      let fromUserinfo: Record<string, unknown> = {}
      try {
        const discovery = await discover(config.issuer)
        if (discovery.userinfo_endpoint && tokens.accessToken) {
          const answer = await fetch(discovery.userinfo_endpoint, {
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
          })
          if (answer.ok) fromUserinfo = await answer.json()
        }
      } catch {
        // The token alone is enough to sign in with; the groups may be missing.
      }
      const sub = String(fromToken.sub ?? fromUserinfo.sub ?? '')
      if (!sub || (fromUserinfo.sub !== undefined && fromUserinfo.sub !== sub)) return null
      const claims = { ...fromUserinfo, ...fromToken, groups: fromToken.groups ?? fromUserinfo.groups, sub } as Claims

      if (!inAllowedGroup(claims, config.allowedGroup)) {
        recordOnAuthDb(db, { kind: 'anonymous', name: usernameFrom(claims) }, 'dashboard', 'signin.failed', `${config.label}: not in ${config.allowedGroup}`)
        return null
      }
      keepProfile(claims)
      return {
        ...claims,
        id: sub,
        // Never the provider's email. Every account's email is a placeholder
        // of its own, so no two ever match, and Better Auth never links an
        // account by a matching email: only by someone signed in choosing to.
        email: placeholderEmail(`sso-${sub}`),
        emailVerified: true,
        name: typeof claims.name === 'string' && claims.name ? claims.name : usernameFrom(claims),
      }
    },
    mapProfileToUser: (profile: Record<string, unknown>) => {
      const wanted = usernameFrom(profile as Claims)
      return { username: wanted.toLowerCase(), displayUsername: wanted }
    },
  }
}

// â”€â”€â”€ The instance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Every account's username is unique, ignoring case. A first sign-in through
 * the provider takes the provider's username, or that with a number if it is
 * taken here: an existing account is never taken over by a name that matches.
 */
function freeUsername(db: Database.Database, wanted: string): string {
  const base = (wanted.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 56) || 'user').toLowerCase()
  const taken = db.prepare('SELECT 1 FROM user WHERE username = ?')
  let name = base
  for (let n = 2; taken.get(name); n++) name = `${base}-${n}`
  return name
}

function adminCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM user WHERE role = 'admin'").get() as { count: number }).count
}

/**
 * The site name passkeys are made for and checked against, when the instance
 * is not made for one in particular. A passkey belongs to a site name, and
 * Better Auth's plugin takes it when an instance is made, so passkeys are
 * made and used through an instance for the name the browser is on
 * (getAuth(site)).
 */
function defaultSite(sso: SsoConfig): string {
  return sso.redirectUri ? new URL(sso.redirectUri).hostname : 'localhost'
}

function buildOptions(db: Database.Database, secret: string, sso: SsoConfig, site: string) {
  const usable = ssoUsable(sso)

  return {
    appName: 'ClearPing',
    // Without transactions. SQLite through better-sqlite3 is one connection,
    // and inside a transaction Better Auth's username plugin still looks a
    // name up outside it: the lookup waits for the transaction, which waits for
    // the lookup, and a first sign-in through the provider never finishes.
    database: { dialect: new SqliteDialect({ database: db }), type: 'sqlite' as const, transaction: false },
    secret,
    basePath: '/api/auth',
    // The address the provider knows this site by, where there is one;
    // otherwise each request's own (see trustedOrigins).
    baseURL: sso.redirectUri ? new URL(sso.redirectUri).origin : undefined,
    // Warnings about the address, which is left to each request on purpose, stay out of the log.
    logger: { level: 'error' },
    // ClearPing is reached at addresses nobody configures (localhost, a LAN
    // address, a domain behind a proxy), so a request is taken at its own
    // address, as before: a page of this site posts from that same origin.
    trustedOrigins: request => {
      if (!request) return []
      const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim() || request.headers.get('host')
      if (!host) return []
      const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
      const proto = forwarded || new URL(request.url).protocol.replace(':', '')
      return [`${proto}://${host}`]
    },
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      // Accounts are made by an admin, or as the first, by ClearPing itself.
      disableSignUp: true,
      minPasswordLength: 10,
      maxPasswordLength: 1024,
      // ClearPing's own scrypt format, so passwords set before Better Auth still work.
      password: {
        hash: hashPassword,
        verify: ({ hash, password }: { hash: string; password: string }) => verifyPassword(password, hash),
      },
      // A forgotten password. Better Auth makes the code, keeps it, lets it be
      // used once and sets the new password; the code is written to the
      // server's log instead of being emailed, since accounts here have no
      // address to send it to. Whoever can read the log runs the server.
      sendResetPassword: async ({ user, token }: { user: { name: string; username?: string | null }; token: string }) => {
        console.log(
          `[Sign-in] Password reset code for "${user.username ?? user.name}": ${token}  ` +
            `(works once, for ${RESET_CODE_MINUTES} minutes; type it on the sign-in page under "Forgot your password?")`
        )
      },
      resetPasswordTokenExpiresIn: RESET_CODE_MINUTES * 60,
      // Whoever had the old password is signed out with it.
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        const row = db.prepare('SELECT id, username, role FROM user WHERE id = ?').get(user.id) as
          | { id: string; username: string; role: Role }
          | undefined
        if (row) recordOnAuthDb(db, { kind: 'user', id: row.id, name: row.username, role: row.role }, 'dashboard', 'account.password.reset', 'With a code from the server log')
      },
    },
    session: {
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      additionalFields: {
        /** Made by signing in through the provider. */
        viaSso: { type: 'boolean', required: false, defaultValue: false, input: false },
        /** The provider's id for its own session (the ID token's `sid`), when it gives one. */
        ssoSid: { type: 'string', required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        lastLoginAt: { type: 'date', required: false, input: false },
      },
    },
    account: {
      // Every account's email is a placeholder of its own, never the
      // provider's, so linking is always by choice (Link my account, signed
      // in), never by a match. The provider is trusted for that choice.
      accountLinking: { enabled: true, allowDifferentEmails: true, trustedProviders: [SSO_PROVIDER_ID] },
    },
    advanced: {
      cookiePrefix: 'clearping',
      // Secure is added per request, by whether it came over HTTPS (see
      // passCookies): a ClearPing on a home network is reached over plain
      // HTTP, where a cookie marked Secure is never kept, and sign-in with it.
      useSecureCookies: false,
      // Not read from headers unless a proxy we trust writes them (see clientAddress).
      ipAddress: { ipAddressHeaders: [] },
    },
    rateLimit: { enabled: false },
    plugins: [
      usernamePlugin({
        minUsernameLength: 1,
        maxUsernameLength: 64,
        usernameValidator: name => /^[A-Za-z0-9._@-]{1,64}$/.test(name),
      }),
      adminPlugin({ ac, roles: ROLES, defaultRole: 'viewer', adminRoles: ['admin'] }),
      apiKey({
        defaultPrefix: KEY_PREFIX,
        // `cp_` and 43 characters, as keys made before Better Auth are.
        customKeyGenerator: ({ prefix }: { prefix?: string }) => newToken(prefix || KEY_PREFIX),
        defaultKeyLength: 43,
        maximumNameLength: 60,
        enableMetadata: true,
        startingCharactersConfig: { shouldStore: true, charactersLength: KEY_PREFIX.length + 6 },
        rateLimit: { enabled: false },
      }),
      ...(usable ? [genericOAuth({ config: [ssoProvider(db, sso)] })] : []),
      // Codes from an authenticator app, asked for after the password. Signing
      // in through the provider or with a passkey is not asked for one: the
      // provider has its own, and a passkey is already two factors in one.
      twoFactor({
        issuer: 'ClearPing',
        backupCodeOptions: { amount: 10, length: 10 },
        // Ten wrong codes in a row lock the account's second step for a quarter of an hour.
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
      }),
      passkey({ rpName: 'ClearPing', rpID: site, origin: null }),
    ],
    hooks: {
      before: createAuthMiddleware(async ctx => {
        // Only the provider's callback comes from a browser; everything else
        // is called by ClearPing's own routes.
        if (ctx.request && ctx.path !== '/callback/:id') throw new APIError('NOT_FOUND')
        // A passkey signs in an account of ClearPing's own, as a password
        // does: with single sign-on the only way in, neither does.
        if (ctx.path === '/sign-in/username' || ctx.path === '/passkey/verify-authentication') {
          const { passwordLogin } = await securitySwitches()
          if (!passwordLogin) throw new APIError('FORBIDDEN', { message: `Signing in here is turned off. Sign in with ${sso.label}.` })
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // A first sign-in through the provider: a free username, and the role its groups give.
          before: async (user, context) => {
            if (context?.path !== '/callback/:id') return
            const sub = String((user as Record<string, unknown>).sub ?? '')
            const claims = sub ? profileFor(sub) : null
            const role: Role = (claims && ssoRole(claims, sso)) || sso.newAccountRole
            const username = freeUsername(db, String(user.username ?? user.name ?? 'user'))
            return { data: { ...user, username, displayUsername: username, role } }
          },
          after: async (user, context) => {
            if (context?.path !== '/callback/:id') return
            recordOnAuthDb(db, 
              { kind: 'user', id: user.id, name: String(user.username), role: (user.role as Role) ?? 'viewer' },
              'dashboard',
              'account.create',
              `First sign-in with ${sso.label}, as ${ROLE_LABEL[(user.role as Role) ?? 'viewer']}`
            )
          },
        },
        update: {
          // Never the last admin made anything else, however the change comes.
          before: async (changes, context) => {
            const id = (context?.body as { userId?: string } | undefined)?.userId ?? (changes as { id?: string }).id
            if (changes.role === undefined || changes.role === 'admin' || !id) return
            const current = db.prepare('SELECT role FROM user WHERE id = ?').get(id) as { role: string } | undefined
            if (current?.role === 'admin' && adminCount(db) <= 1) return false
          },
        },
      },
      account: {
        create: {
          // An existing account linked to the provider: by choice, signed in, from Settings.
          after: async (account, context) => {
            if (account.providerId !== SSO_PROVIDER_ID || context?.path !== '/callback/:id') return
            const user = db.prepare('SELECT id, username, role, createdAt FROM user WHERE id = ?').get(account.userId) as
              | { id: string; username: string; role: Role; createdAt: number }
              | undefined
            if (!user || Date.now() - Number(user.createdAt) < 5_000) return
            recordOnAuthDb(db, { kind: 'user', id: user.id, name: user.username, role: user.role }, 'dashboard', 'account.sso.link', sso.label)
          },
        },
      },
      session: {
        create: {
          /**
           * A session made through the provider remembers that, and the
           * provider's own session id, so that signing out there ends it here.
           * At every such sign-in the account's role is set again from the
           * person's groups, when the settings map groups to roles.
           */
          before: async (session, context) => {
            if (context?.path !== '/callback/:id') return
            const account = db
              .prepare('SELECT accountId, idToken FROM account WHERE userId = ? AND providerId = ? ORDER BY updatedAt DESC LIMIT 1')
              .get(session.userId, SSO_PROVIDER_ID) as { accountId: string; idToken: string | null } | undefined
            const sid = idTokenClaims(account?.idToken).sid
            const claims = account ? profileFor(account.accountId) : null
            const groupRole = claims ? ssoRole(claims, sso) : null
            if (groupRole) {
              const user = db.prepare('SELECT id, username, role FROM user WHERE id = ?').get(session.userId) as
                | { id: string; username: string; role: Role }
                | undefined
              if (user && user.role !== groupRole) {
                const actor = { kind: 'user' as const, id: user.id, name: user.username, role: user.role }
                if (user.role === 'admin' && adminCount(db) <= 1) {
                  recordOnAuthDb(db, actor, 'dashboard', 'account.role', `Kept as ${ROLE_LABEL[user.role]}: the only admin is never made anything else`)
                } else {
                  db.prepare('UPDATE user SET role = ? WHERE id = ?').run(groupRole, user.id)
                  recordOnAuthDb(db, actor, 'dashboard', 'account.role', `${ROLE_LABEL[user.role]} to ${ROLE_LABEL[groupRole]}, by their groups at ${sso.label}`)
                }
              }
            }
            return { data: { ...session, viaSso: true, ssoSid: typeof sid === 'string' && sid ? sid : null } }
          },
          after: async (session, context) => {
            db.prepare('UPDATE user SET lastLoginAt = ? WHERE id = ?').run(Date.now(), session.userId)
            if (context?.path !== '/callback/:id') return
            const user = db.prepare('SELECT id, username, role FROM user WHERE id = ?').get(session.userId) as
              | { id: string; username: string; role: Role }
              | undefined
            if (user) {
              const from = String(session.ipAddress ?? 'unknown')
              recordOnAuthDb(db, { kind: 'user', id: user.id, name: user.username, role: user.role }, 'dashboard', 'signin', `With ${sso.label}, from ${from}`)
            }
          },
        },
      },
    },
  } satisfies BetterAuthOptions
}

type Auth = ReturnType<typeof betterAuth<ReturnType<typeof buildOptions>>>

interface Instance {
  key: string
  auth: Auth
}

interface Holder {
  /** One connection for as long as the process runs. */
  db: Database.Database | null
  /** The instances made, by the site name they are for ('' for the general one). */
  instances: Map<string, Instance>
  /** Instances being made, which every request in the meantime waits for. */
  building: Map<string, { key: string; done: Promise<Instance> }>
}

const INSTANCE_KEY = Symbol.for('clearping.auth.v2')
function holder(): Holder {
  const store = globalThis as typeof globalThis & { [INSTANCE_KEY]?: Holder }
  return (store[INSTANCE_KEY] ??= { db: null, instances: new Map(), building: new Map() })
}

/** How many site names get an instance of their own before the oldest are let go. */
const MAX_SITE_INSTANCES = 8

/** Make an instance: Better Auth's tables first (it checks them as soon as it starts), then the accounts moved across. */
async function build(db: Database.Database, secret: string, sso: SsoConfig, key: string, site: string): Promise<Instance> {
  const options = buildOptions(db, secret, sso, site)
  const { runMigrations } = await getMigrations(options)
  await runMigrations()
  const { moveLegacyAccounts } = await import('./auth-migration')
  await moveLegacyAccounts(db)
  return { key, auth: betterAuth(options) }
}

/**
 * The Better Auth instance, made for the single sign-on settings as they are
 * now. Saving those settings makes a new one: providers are read when an
 * instance is made. One whose provider could not be reached is made again a
 * minute later, rather than leaving sign-in through it off until a restart.
 *
 * With `site`, the instance that makes and checks passkeys for that site
 * name (see defaultSite). Every instance shares the one database and secret,
 * so a session made by any of them is a session to all.
 */
export async function getAuth(site?: string): Promise<Auth> {
  // ClearPing's own tables first: the settings, and the accounts to move across.
  await getDatabase()
  const sso = await getSsoConfig()
  const state = holder()
  state.db ??= openDatabase()
  const db = state.db
  const secret = authSecret(db)
  const slot = site ?? ''
  const key = JSON.stringify([secret, sso, databasePath(), slot])

  const current = state.instances.get(slot)
  if (current?.key === key) return current.auth
  let building = state.building.get(slot)
  if (building?.key !== key) {
    // A site name comes from the request, so there is a limit to how many are kept.
    if (slot && !state.instances.has(slot) && state.instances.size > MAX_SITE_INSTANCES) {
      for (const name of state.instances.keys()) if (name) { state.instances.delete(name); break }
    }
    const done = build(db, secret, sso, key, site ?? defaultSite(sso)).then(instance => {
      state.instances.set(slot, instance)
      if (ssoUsable(sso)) scheduleProviderCheck(slot, instance)
      return instance
    })
    building = { key, done }
    state.building.set(slot, building)
    done.finally(() => {
      if (state.building.get(slot)?.done === done) state.building.delete(slot)
    }).catch(() => {})
  }
  return (await building.done).auth
}

/** Drop an instance whose provider was not reached, so the next request makes one that tries again. */
function scheduleProviderCheck(slot: string, instance: Instance) {
  void (async () => {
    try {
      const context = await instance.auth.$context
      if (context.socialProviders.some(provider => provider.id === SSO_PROVIDER_ID)) return
      setTimeout(() => {
        const state = holder()
        if (state.instances.get(slot) === instance) state.instances.set(slot, { ...instance, key: '' })
      }, 60_000)
    } catch {
      // A failed check leaves the instance as it is.
    }
  })()
}

/** The database connection sign-in uses, for reading its tables. */
export async function authDatabase(): Promise<Database.Database> {
  await getAuth()
  return holder().db!
}

/** Close sign-in's connection: for the tests, and for a clean shutdown. */
export function closeAuth(): void {
  const state = holder()
  state.db?.close()
  state.db = null
  state.instances.clear()
  state.building.clear()
}

/** Whether sign-in through the provider is set up and its configuration was read. */
export async function ssoReady(): Promise<boolean> {
  const sso = await getSsoConfig()
  if (!ssoUsable(sso)) return false
  const context = await (await getAuth()).$context
  return context.socialProviders.some(provider => provider.id === SSO_PROVIDER_ID)
}

export { groupsOf }
