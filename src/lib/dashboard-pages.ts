/**
 * The pages the dashboard shows in place of a target or a group, and their
 * addresses.
 *
 * They are views of the one dashboard, not separate pages: the sidebar stays,
 * and moving between them changes the address (pushState) without loading
 * anything. Having an address is what lets one be bookmarked, reloaded, and
 * left with the browser's back button.
 */

export const SECURITY_TABS = ['access', 'keys', 'sso', 'accounts', 'activity'] as const
export type SecurityTab = (typeof SECURITY_TABS)[number]

export type DashboardPage = { kind: 'alerts' } | { kind: 'mcp' } | { kind: 'security'; tab: SecurityTab }

export function isSecurityTab(value: unknown): value is SecurityTab {
  return typeof value === 'string' && (SECURITY_TABS as readonly string[]).includes(value)
}

/** The page at an address, or null for the dashboard itself (a target or a group). */
export function pageFromPath(pathname: string): DashboardPage | null {
  const [first, second, ...rest] = pathname.split('/').filter(Boolean)
  if (rest.length > 0) return null
  if (first === 'alerts' && !second) return { kind: 'alerts' }
  if (first === 'mcp' && !second) return { kind: 'mcp' }
  if (first === 'security') {
    if (!second) return { kind: 'security', tab: 'access' }
    if (isSecurityTab(second)) return { kind: 'security', tab: second }
  }
  return null
}

/** The address of a page. The first tab of Security is at /security itself. */
export function pathOf(page: DashboardPage | null): string {
  if (!page) return '/'
  if (page.kind === 'security') return page.tab === 'access' ? '/security' : `/security/${page.tab}`
  return `/${page.kind}`
}
