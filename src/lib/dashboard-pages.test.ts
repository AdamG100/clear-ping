import { describe, expect, it } from 'vitest'
import { pageFromPath, pathOf, SETTINGS_SECTIONS, type DashboardPage, type SettingsSection } from './dashboard-pages'

describe('dashboard pages', () => {
  it('reads each page from its address', () => {
    expect(pageFromPath('/')).toBeNull()
    expect(pageFromPath('/alerts')).toEqual({ kind: 'alerts' })
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
    const pages: DashboardPage[] = [{ kind: 'alerts' }, ...SETTINGS_SECTIONS.map(section => ({ kind: 'settings' as const, section }))]
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

describe('the pages for adding and editing a target', () => {
  it('reads each from its address', () => {
    expect(pageFromPath('/targets/new')).toEqual({ kind: 'target-new' })
    expect(pageFromPath('/targets/new/in/Home/Network')).toEqual({ kind: 'target-new', group: 'Home/Network' })
    expect(pageFromPath('/targets/new/in/Cool%20Ideas/Lab')).toEqual({ kind: 'target-new', group: 'Cool Ideas/Lab' })
    expect(pageFromPath('/targets/new/copy/abc-123')).toEqual({ kind: 'target-new', from: 'abc-123' })
    expect(pageFromPath('/targets/abc-123/edit')).toEqual({ kind: 'target-edit', id: 'abc-123' })
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
    for (const path of ['/targets', '/targets/abc', '/targets/abc/edit/x', '/targets/new/in', '/targets/new/copy', '/targets/new/copy/a/b', '/targets/new/other']) {
      expect(pageFromPath(path)).toBeNull()
    }
  })

  it('never puts something that is not a group into an address', () => {
    const event = { type: 'click' } as unknown as string
    expect(pathOf({ kind: 'target-new', group: event })).toBe('/targets/new')
  })
})
