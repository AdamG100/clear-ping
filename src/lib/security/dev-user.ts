import { randomBytes } from 'node:crypto'
import { getAuth } from './auth'
import { getJsonSetting, setJsonSetting } from './settings-store'
import { createUser, getUser } from './store'

/**
 * Always signed in while developing: under `next dev`, a page opened without
 * a session is signed in as the `dev` account, an admin made the first time.
 * The session is Better Auth's own, made by signing in with the account's
 * password, so everything behaves as for anyone else signed in. The password
 * is made at random and kept in the database, never a fixed one: a database
 * from development that ends up in production lets nobody in by it.
 *
 * Never in a production build. CLEARPING_DEV_USER=off turns it off in
 * development, to see the dashboard as someone signed out.
 */

export const DEV_USERNAME = 'dev'
const SETTING = 'dev.user'

export function devUserEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.CLEARPING_DEV_USER?.trim().toLowerCase() !== 'off'
}

/**
 * Better Auth's answer to signing in as the dev account, with the session
 * cookie, or null when it cannot be: the account was made by hand, has an
 * authenticator app, or passwords are turned off.
 */
export async function signInDevUser(headers: Headers): Promise<Response | null> {
  if (!devUserEnabled()) return null
  const kept = await getJsonSetting<{ userId: string; password: string }>(SETTING)
  let password = kept && (await getUser(kept.userId)) ? kept.password : null
  if (!password) {
    password = randomBytes(24).toString('base64url')
    try {
      const user = await createUser(DEV_USERNAME, password, 'admin')
      await setJsonSetting(SETTING, { userId: user.id, password })
    } catch (error) {
      console.warn('[Dev user] Could not make the dev account:', error instanceof Error ? error.message : error)
      return null
    }
  }
  const auth = await getAuth()
  const answer = await auth.api
    .signInUsername({ body: { username: DEV_USERNAME, password, rememberMe: true }, headers, asResponse: true })
    .catch(() => null)
  const body = answer?.ok ? ((await answer.clone().json().catch(() => null)) as { twoFactorRedirect?: boolean } | null) : null
  return answer?.ok && !body?.twoFactorRedirect ? answer : null
}
