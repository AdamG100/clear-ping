/**
 * The pages the dashboard shows in place of a target or a group, and their
 * addresses.
 *
 * They are views of the one dashboard, not separate pages: the sidebar stays,
 * and moving between them changes the address (pushState) without loading
 * anything. Having an address is what lets one be bookmarked, reloaded, and
 * left with the browser's back button.
 */

/** The sections of Settings, in the order its menu lists them. */
export const SETTINGS_SECTIONS = ['access', 'sign-in', 'keys', 'sso', 'accounts', 'activity', 'assistant'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** Where Settings opens when no section is asked for. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'access'

export type DashboardPage = { kind: 'alerts' } | { kind: 'settings'; section: SettingsSection }

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** The page at an address, or null for the dashboard itself (a target or a group). */
export function pageFromPath(pathname: string): DashboardPage | null {
  const [first, second, ...rest] = pathname.split('/').filter(Boolean)
  if (rest.length > 0) return null
  if (first === 'alerts' && !second) return { kind: 'alerts' }
  if (first === 'settings') {
    if (!second) return { kind: 'settings', section: DEFAULT_SETTINGS_SECTION }
    if (isSettingsSection(second)) return { kind: 'settings', section: second }
  }
  return null
}

/** The address of a page. The first section of Settings is at /settings itself. */
export function pathOf(page: DashboardPage | null): string {
  if (!page) return '/'
  if (page.kind === 'settings') {
    // Whatever arrives here as a section, only a real one becomes part of an address.
    const section = isSettingsSection(page.section) ? page.section : DEFAULT_SETTINGS_SECTION
    return section === DEFAULT_SETTINGS_SECTION ? '/settings' : `/settings/${section}`
  }
  return `/${page.kind}`
}
