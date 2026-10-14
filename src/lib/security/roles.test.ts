import { describe, expect, it } from 'vitest'
import { canAdminister, canChange, effectiveKeyAccess, isRole, maxKeyAccess, roleFromGroups } from './roles'

describe('roles', () => {
  it('lets each role do what it says', () => {
    expect([canChange('admin'), canChange('editor'), canChange('viewer')]).toEqual([true, true, false])
    expect([canAdminister('admin'), canAdminister('editor'), canAdminister('viewer')]).toEqual([true, false, false])
    expect(isRole('editor')).toBe(true)
    expect(isRole('owner')).toBe(false)
  })

  it('never lets a key do more than the account that made it', () => {
    expect(maxKeyAccess('viewer')).toBe('read')
    expect(effectiveKeyAccess('write', 'editor')).toBe('write')
    expect(effectiveKeyAccess('write', 'viewer')).toBe('read')
    expect(effectiveKeyAccess('read', 'admin')).toBe('read')
    // From before roles, when every account could do everything.
    expect(effectiveKeyAccess('write', null)).toBe('write')
  })

  it('takes the role from the groups at the provider, when groups are mapped', () => {
    const mapping = { adminGroup: 'ClearPing Admins', editorGroup: 'clearping-editors' }
    expect(roleFromGroups(['clearping admins', 'clearping-editors'], mapping)).toBe('admin')
    expect(roleFromGroups(['ClearPing-Editors'], mapping)).toBe('editor')
    expect(roleFromGroups(['family'], mapping)).toBe('viewer')
    expect(roleFromGroups(['ClearPing Admins'], { adminGroup: '', editorGroup: '' })).toBeNull()
    expect(roleFromGroups([], { adminGroup: 'admins', editorGroup: '' })).toBe('viewer')
  })
})
