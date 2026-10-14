/**
 * What an account may do: its role.
 *
 * Three, from most to least:
 *
 * - **Admin**: everything, Settings included: whether sign-in is asked for,
 *   every key, single sign-on, the accounts and their roles, the activity
 *   record.
 * - **Editor**: everything that is monitored. Adds, changes and deletes
 *   targets, groups and alerts, probes and traces. Keys of its own.
 * - **Viewer**: sees everything that is monitored and changes nothing. A key
 *   of its own can only read.
 *
 * Roles say what a signed-in account may do. With sign-in off, anyone who can
 * reach ClearPing can do anything, as before roles: what an account may not
 * do, signed out it could. Roles are for a ClearPing that asks for sign-in.
 */

export const ROLES = ['admin', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' }

export const ROLE_DETAIL: Record<Role, string> = {
  admin: 'Everything, Settings included: sign-in, keys, single sign-on, accounts and the activity record.',
  editor: 'Adds, changes and deletes targets, groups and alerts. Creates keys of its own. No other settings.',
  viewer: 'Sees everything monitored and changes nothing. Creates read-only keys of its own.',
}

/** The role an account added by an admin starts with, unless they choose another: the least. */
export const DEFAULT_NEW_ROLE: Role = 'viewer'

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** Can change what is monitored: targets, groups, alerts, probes and traces. */
export function canChange(role: Role): boolean {
  return role === 'admin' || role === 'editor'
}

/** Can change Settings, and see and act on everyone's keys and accounts. */
export function canAdminister(role: Role): boolean {
  return role === 'admin'
}

export type KeyAccess = 'read' | 'write'

/** The most a key made by an account of this role may do. */
export function maxKeyAccess(role: Role): KeyAccess {
  return canChange(role) ? 'write' : 'read'
}

/**
 * What a key may do now: what it was made to do, but never more than the
 * account that made it may. An editor made a viewer has keys that only read,
 * from the next request. A key with no maker on record is from before roles,
 * when every account could do everything, and does what it was made to.
 */
export function effectiveKeyAccess(made: KeyAccess, makerRole: Role | null): KeyAccess {
  if (makerRole === null) return made
  return made === 'write' && maxKeyAccess(makerRole) === 'write' ? 'write' : 'read'
}

/**
 * The role a person's groups at the identity provider give them, when the
 * single sign-on settings map groups to roles; null when they map none, and
 * the account's role is left as it is. Mapped, a person in neither group is
 * a viewer: the groups decide, both ways.
 */
export function roleFromGroups(groups: string[], mapping: { adminGroup: string; editorGroup: string }): Role | null {
  const adminGroup = mapping.adminGroup.trim().toLowerCase()
  const editorGroup = mapping.editorGroup.trim().toLowerCase()
  if (!adminGroup && !editorGroup) return null
  const member = new Set(groups.map(group => group.toLowerCase()))
  if (adminGroup && member.has(adminGroup)) return 'admin'
  if (editorGroup && member.has(editorGroup)) return 'editor'
  return 'viewer'
}
