import type { Role } from './roles'

/**
 * Second factors: what an account has, and what an admin requires of it.
 *
 * The factors are Better Auth's: codes from an authenticator app (its
 * two-factor plugin, asked for after the password) and passkeys (its passkey
 * plugin, which sign in on their own). This is only the rule an admin sets
 * for which of them an account must have, and how an account stands against
 * it. Pure, so the browser and the server read it alike.
 *
 * Only accounts that sign in to ClearPing itself are held to it. A session
 * made through single sign-on is the identity provider's to secure, with
 * whatever second factor it asks for.
 */

export type Factor = 'totp' | 'passkey'

/** What an admin can require: nothing, either factor, one in particular, or both. */
export type FactorRequirement = 'none' | 'either' | 'totp' | 'passkey' | 'both'

/** Who it is required of: everyone, or every account but the admins'. */
export type FactorScope = 'everyone' | 'others'

export interface FactorPolicy {
  require: FactorRequirement
  appliesTo: FactorScope
}

export const NO_FACTOR_POLICY: FactorPolicy = { require: 'none', appliesTo: 'everyone' }

export const FACTOR_REQUIREMENTS: readonly FactorRequirement[] = ['none', 'either', 'totp', 'passkey', 'both']
export const FACTOR_SCOPES: readonly FactorScope[] = ['everyone', 'others']

export const FACTOR_LABEL: Record<Factor, string> = { totp: 'an authenticator app', passkey: 'a passkey' }

export const REQUIREMENT_LABEL: Record<FactorRequirement, string> = {
  none: 'Nothing more than a password',
  either: 'An authenticator app or a passkey',
  totp: 'An authenticator app',
  passkey: 'A passkey',
  both: 'An authenticator app and a passkey',
}

export function isFactorPolicy(value: unknown): value is FactorPolicy {
  const policy = value as Partial<FactorPolicy> | null
  return (
    !!policy &&
    FACTOR_REQUIREMENTS.includes(policy.require as FactorRequirement) &&
    FACTOR_SCOPES.includes(policy.appliesTo as FactorScope)
  )
}

/** What an account has set up. */
export interface AccountFactors {
  totp: boolean
  passkeys: number
}

/**
 * What an account still has to add, or null if nothing. `either` is satisfied
 * by adding any one of `missing`; otherwise every one of them is needed.
 */
export type FactorsOwed = { either: boolean; missing: Factor[] } | null

export function factorsOwed(
  policy: FactorPolicy,
  account: { role: Role } & AccountFactors,
  session: { viaSso: boolean }
): FactorsOwed {
  if (session.viaSso || policy.require === 'none') return null
  if (policy.appliesTo === 'others' && account.role === 'admin') return null

  const has: Record<Factor, boolean> = { totp: account.totp, passkey: account.passkeys > 0 }
  if (policy.require === 'either') {
    return has.totp || has.passkey ? null : { either: true, missing: ['totp', 'passkey'] }
  }
  const wanted: Factor[] = policy.require === 'both' ? ['totp', 'passkey'] : [policy.require]
  const missing = wanted.filter(factor => !has[factor])
  return missing.length === 0 ? null : { either: false, missing }
}

/**
 * The factor an account must still use before this sign-in gets a session, or
 * null. Having a factor is not using it: a policy that names one asks for it
 * at sign-in. Only for what the account has; what it has not added yet is for
 * `factorsOwed`, which sends it to add it.
 */
export function factorToProve(
  policy: FactorPolicy,
  account: { role: Role } & AccountFactors,
  used: Factor[]
): Factor | null {
  if (policy.require === 'none') return null
  if (policy.appliesTo === 'others' && account.role === 'admin') return null

  const has: Record<Factor, boolean> = { totp: account.totp, passkey: account.passkeys > 0 }
  if (policy.require === 'either') {
    if (used.length > 0) return null
    return has.totp ? 'totp' : has.passkey ? 'passkey' : null
  }
  const wanted: Factor[] = policy.require === 'both' ? ['totp', 'passkey'] : [policy.require]
  return wanted.find(factor => has[factor] && !used.includes(factor)) ?? null
}

/**
 * Why a factor cannot be taken away, or null if it can: removing it would
 * leave the account short of what is required. Checked as though signed in
 * with a password, since that is how it would next have to sign in.
 */
export function removalProblem(
  policy: FactorPolicy,
  account: { role: Role } & AccountFactors,
  removing: { factor: Factor }
): string | null {
  const after: AccountFactors =
    removing.factor === 'totp' ? { ...account, totp: false } : { ...account, passkeys: Math.max(0, account.passkeys - 1) }
  if (!factorsOwed(policy, { ...account, ...after }, { viaSso: false })) return null
  return `An admin requires ${REQUIREMENT_LABEL[policy.require].toLowerCase()} for your account. Add another before removing this one.`
}

/** What an account owes, in a sentence. */
export function describeOwed(owed: NonNullable<FactorsOwed>): string {
  const names = owed.missing.map(factor => FACTOR_LABEL[factor])
  return owed.either ? `Add ${names.join(' or ')} to your account` : `Add ${names.join(' and ')} to your account`
}
