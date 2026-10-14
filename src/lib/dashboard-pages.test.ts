import { describe, expect, it } from 'vitest'
import { pageFromPath, pathOf, SECURITY_TABS, type DashboardPage } from './dashboard-pages'

describe('dashboard pages', () => {
  it('reads each page from its address', () => {
    expect(pageFromPath('/')).toBeNull()
    expect(pageFromPath('/alerts')).toEqual({ kind: 'alerts' })
    expect(pageFromPath('/mcp/')).toEqual({ kind: 'mcp' })
    expect(pageFromPath('/security')).toEqual({ kind: 'security', tab: 'access' })
    expect(pageFromPath('/security/keys')).toEqual({ kind: 'security', tab: 'keys' })
  })

  it('takes nothing it does not know for a page', () => {
    for (const path of ['/security/nope', '/alerts/1', '/security/keys/x', '/login', '/api/mcp']) {
      expect(pageFromPath(path)).toBeNull()
    }
  })

  it('gives each page an address that reads back as the same page', () => {
    const pages: DashboardPage[] = [{ kind: 'alerts' }, { kind: 'mcp' }, ...SECURITY_TABS.map(tab => ({ kind: 'security' as const, tab }))]
    for (const page of pages) expect(pageFromPath(pathOf(page))).toEqual(page)
    expect(pathOf(null)).toBe('/')
    expect(pathOf({ kind: 'security', tab: 'access' })).toBe('/security')
  })
})
