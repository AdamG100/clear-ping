import { describe, expect, it } from 'vitest'
import { pageFromPath, pathOf, safeNext, SETTINGS_SECTIONS, type DashboardPage, type SettingsSection } from './dashboard-pages'

describe('dashboard pages', () => {
  it('reads each page from its address', () => {
    expect(pageFromPath('/')).toBeNull()
    expect(pageFromPath('/overview')).toEqual({ kind: 'overview' })
    expect(pageFromPath('/alerts')).toEqual({ kind: 'alerts' })
    expect(pageFromPath('/patch-notes')).toEqual({ kind: 'patch-notes' })
    expect(pageFromPath('/settings')).toEqual({ kind: 'settings', section: 'access' })
    expect(pageFromPath('/settings/keys/')).toEqual({ kind: 'settings', section: 'keys' })
    expect(pageFromPath('/settings/assistant')).toEqual({ kind: 'settings', section: 'assistant' })
  })

  it('takes nothing it does not know for a page', () => {
    for (const path of ['/settings/nope', '/alerts/1', '/settings/keys/x', '/security', '/mcp', '/login', '/api/mcp']) {
      expect(pageFromPath(path)).toBeNull()
    }
  })

  it('gives each page an address that reads back as the same page', () => {
    const pages: DashboardPage[] = [{ kind: 'overview' }, { kind: 'alerts' }, { kind: 'patch-notes' }, ...SETTINGS_SECTIONS.map(section => ({ kind: 'settings' as const, section }))]
    for (const page of pages) expect(pageFromPath(pathOf(page))).toEqual(page)
    expect(pathOf(null)).toBe('/')
    expect(pathOf({ kind: 'settings', section: 'access' })).toBe('/settings')
  })

  it('never puts something that is not a section into an address', () => {
    // A click event handed on where a section was expected once made /security/[object Object].
    const event = { type: 'click' } as unknown as SettingsSection
    expect(pathOf({ kind: 'settings', section: event })).toBe('/settings')
  })
})

describe('the routing pages', () => {
  it('reads each from its address, and gives each an address that reads back as itself', () => {
    expect(pageFromPath('/routing')).toEqual({ kind: 'routing' })
    expect(pageFromPath('/routing/abc-123')).toEqual({ kind: 'routing-prefix', id: 'abc-123' })
    expect(pageFromPath('/routing/abc/more')).toBeNull()
    for (const page of [{ kind: 'routing' }, { kind: 'routing-prefix', id: 'a b/c' }] as DashboardPage[]) {
      expect(pageFromPath(pathOf(page))).toEqual(page)
    }
  })
})

describe('the pages for making and editing an alert', () => {
  it('reads each from its address, and gives each an address that reads back as itself', () => {
    expect(pageFromPath('/alerts/new')).toEqual({ kind: 'alert-new' })
    expect(pageFromPath('/alerts/abc-123/edit')).toEqual({ kind: 'alert-edit', id: 'abc-123' })
    for (const page of [{ kind: 'alert-new' }, { kind: 'alert-edit', id: 'a b/c' }] as DashboardPage[]) {
      expect(pageFromPath(pathOf(page))).toEqual(page)
    }
    for (const path of ['/alerts/new/x', '/alerts/abc-123', '/alerts/abc-123/edit/x']) expect(pageFromPath(path)).toBeNull()
  })
})

describe('the pages for adding and editing a target', () => {
  it('reads each from its address', () => {
    expect(pageFromPath('/monitors/new')).toEqual({ kind: 'target-new' })
    expect(pageFromPath('/monitors/new/in/Home/Network')).toEqual({ kind: 'target-new', group: 'Home/Network' })
    expect(pageFromPath('/monitors/new/in/Cool%20Ideas/Lab')).toEqual({ kind: 'target-new', group: 'Cool Ideas/Lab' })
    expect(pageFromPath('/monitors/new/copy/abc-123')).toEqual({ kind: 'target-new', from: 'abc-123' })
    expect(pageFromPath('/monitors/abc-123/edit')).toEqual({ kind: 'target-edit', id: 'abc-123' })
  })

  it('still reads the addresses they had when they were called targets', () => {
    expect(pageFromPath('/targets/new')).toEqual({ kind: 'target-new' })
    expect(pageFromPath('/targets/abc-123/edit')).toEqual({ kind: 'target-edit', id: 'abc-123' })
    expect(pageFromPath('/settings/probe-agents')).toEqual({ kind: 'settings', section: 'probes' })
  })

  it('gives each an address that reads back as the same page', () => {
    const pages: DashboardPage[] = [
      { kind: 'target-new' },
      { kind: 'target-new', group: 'Cool Ideas/Lab & Rack' },
      { kind: 'target-new', from: 'x y' },
      { kind: 'target-edit', id: 'abc-123' },
    ]
    for (const page of pages) expect(pageFromPath(pathOf(page))).toEqual(page)
  })

  it('takes nothing it does not know for one', () => {
    for (const path of ['/monitors', '/monitors/abc', '/monitors/abc/edit/x', '/monitors/new/in', '/monitors/new/copy', '/monitors/new/copy/a/b', '/monitors/new/other', '/targets']) {
      expect(pageFromPath(path)).toBeNull()
    }
  })

  it('never puts something that is not a group into an address', () => {
    const event = { type: 'click' } as unknown as string
    expect(pathOf({ kind: 'target-new', group: event })).toBe('/monitors/new')
  })
})


describe('safeNext', () => {
  it('keeps a path on this site', () => {
    expect(safeNext('/alerts')).toBe('/alerts')
    expect(safeNext('/monitors/abc/edit?from=x#top')).toBe('/monitors/abc/edit?from=x#top')
  })

  it('goes to the dashboard instead of anywhere else, however it is written', () => {
    for (const elsewhere of [
      '//evil.example',
      'https://evil.example/',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\\\t\\evil.example',
      '/.//evil.example',
      '/..//evil.example',
      '/x/..//evil.example',
      '/%2e//evil.example',
      '/.\t//evil.example',
      'javascript:alert(1)',
      ' /alerts',
      '',
      42,
      undefined,
      ['/alerts'],
    ]) {
      expect(safeNext(elsewhere)).toBe('/')
    }
  })

  it('gives back the path a browser would go to, not what was written', () => {
    expect(safeNext('/al\terts')).toBe('/alerts')
  })
})
