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
export const SETTINGS_SECTIONS = ['access', 'sign-in', 'keys', 'sso', 'accounts', 'privacy', 'probes', 'routing', 'activity', 'maintenance', 'assistant'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** Where Settings opens when no section is asked for. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'access'

export type DashboardPage =
  /** Everything at a glance: where the dashboard opens. */
  | { kind: 'overview' }
  | { kind: 'alerts' }
  /** The form for a new alert, in the main pane rather than a panel over it. */
  | { kind: 'alert-new' }
  | { kind: 'alert-edit'; id: string }
  | { kind: 'settings'; section: SettingsSection }
  /** A blank form for a new target, started in `group` or as a copy of the target `from`. */
  | { kind: 'target-new'; group?: string; from?: string }
  | { kind: 'target-edit'; id: string }
  /** What changed in each version, opened from the version badge. */
  | { kind: 'patch-notes' }
  /** BGP monitoring: every watched prefix, and one of them in full. */
  | { kind: 'routing' }
  | { kind: 'routing-prefix'; id: string }

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** The page at an address, or null for the dashboard itself (a target or a group). */
/** A segment of an address as written, whether or not the browser left it encoded. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * The page at an address, or null for the dashboard itself (a target or a group).
 *
 * Adding a monitor is /monitors/new, /monitors/new/in/<group> to start in a group
 * (the group's own path, so /monitors/new/in/Home/Network) and
 * /monitors/new/copy/<id> to duplicate one. Editing is /monitors/<id>/edit.
 * The same under /targets, which is what they were called, still reads.
 * Alerts are the same: /alerts/new, and /alerts/<id>/edit.
 */
export function pageFromPath(pathname: string): DashboardPage | null {
  const [first, second, ...rest] = pathname.split('/').filter(Boolean)

  if (first === 'alerts' && second) {
    if (second === 'new' && rest.length === 0) return { kind: 'alert-new' }
    if (rest.length === 1 && rest[0] === 'edit') return { kind: 'alert-edit', id: decodeSegment(second) }
    return null
  }

  // Monitors were called targets, and their pages still open at the old address.
  if ((first === 'monitors' || first === 'targets') && second) {
    if (second === 'new') {
      if (rest.length === 0) return { kind: 'target-new' }
      const [how, ...value] = rest
      if (how === 'in' && value.length > 0) return { kind: 'target-new', group: value.map(decodeSegment).join('/') }
      if (how === 'copy' && value.length === 1) return { kind: 'target-new', from: decodeSegment(value[0]) }
      return null
    }
    if (rest.length === 1 && rest[0] === 'edit') return { kind: 'target-edit', id: decodeSegment(second) }
    return null
  }

  if (first === 'routing') {
    if (!second) return { kind: 'routing' }
    return rest.length === 0 ? { kind: 'routing-prefix', id: decodeSegment(second) } : null
  }

  if (rest.length > 0) return null
  if (first === 'overview' && !second) return { kind: 'overview' }
  if (first === 'alerts' && !second) return { kind: 'alerts' }
  if (first === 'patch-notes' && !second) return { kind: 'patch-notes' }
  if (first === 'settings') {
    if (!second) return { kind: 'settings', section: DEFAULT_SETTINGS_SECTION }
    if (isSettingsSection(second)) return { kind: 'settings', section: second }
    // What the section was called before it held the local probe too.
    if (second === 'probe-agents') return { kind: 'settings', section: 'probes' }
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
  if (page.kind === 'target-edit') return `/monitors/${encodeURIComponent(page.id)}/edit`
  if (page.kind === 'routing-prefix') return `/routing/${encodeURIComponent(page.id)}`
  if (page.kind === 'alert-new') return '/alerts/new'
  if (page.kind === 'alert-edit') return `/alerts/${encodeURIComponent(page.id)}/edit`
  if (page.kind === 'target-new') {
    if (typeof page.from === 'string' && page.from) return `/monitors/new/copy/${encodeURIComponent(page.from)}`
    // Only a group given as a path: anything else (a click event, say) is not one.
    if (typeof page.group === 'string' && page.group) {
      return `/monitors/new/in/${page.group.split('/').map(encodeURIComponent).join('/')}`
    }
    return '/monitors/new'
  }
  return `/${page.kind}`
}

const SAFE_NEXT_BASE = 'http://clearping.invalid'

/**
 * Where to go next from a `next` anyone could have written into a link: a
 * path on this site, or the dashboard. It is read the way a browser will read
 * it, since that is where it leads: a browser drops tabs and line breaks from
 * an address and takes `\` for `/`, so `/<tab>/evil.example` and
 * `/\evil.example` are both `//evil.example`, another site. What comes out is
 * checked too: `/.//evil.example` starts on this site, but its dot is resolved
 * away and leaves the same `//evil.example`.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/'
  let url: URL
  try {
    url = new URL(next, SAFE_NEXT_BASE)
  } catch {
    return '/'
  }
  if (url.origin !== SAFE_NEXT_BASE || url.pathname.startsWith('//')) return '/'
  return `${url.pathname}${url.search}${url.hash}`
}
