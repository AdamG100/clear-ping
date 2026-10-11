import { describe, expect, it } from 'vitest'
import {
  groupDepth,
  groupInitials,
  groupLabel,
  groupName,
  groupWithAncestors,
  isWithinGroup,
  joinGroupPath,
  normalizeGroupPath,
  parentGroup,
  rebaseGroupPath,
} from './group-path'

describe('normalizeGroupPath', () => {
  it('treats every spelling of a path as the one group', () => {
    for (const spelling of ['Home/Network', 'Home / Network', ' Home//Network ', '/Home/Network/']) {
      expect(normalizeGroupPath(spelling)).toBe('Home/Network')
    }
  })

  it('leaves a plain name alone and reads nothing as no group', () => {
    expect(normalizeGroupPath('DNS')).toBe('DNS')
    expect(normalizeGroupPath('')).toBe('')
    expect(normalizeGroupPath(' / ')).toBe('')
    expect(normalizeGroupPath(undefined)).toBe('')
    expect(normalizeGroupPath(null)).toBe('')
  })
})

describe('taking a path apart', () => {
  it('finds the parent, the name and the depth', () => {
    expect(parentGroup('Home/Network/Switches')).toBe('Home/Network')
    expect(parentGroup('Home')).toBe('')
    expect(groupName('Home/Network/Switches')).toBe('Switches')
    expect(groupName('Home')).toBe('Home')
    expect(groupDepth('Home')).toBe(0)
    expect(groupDepth('Home/Network/Switches')).toBe(2)
  })

  it('lists a group with the groups it sits inside, outermost first', () => {
    expect(groupWithAncestors('Home/Network/Switches')).toEqual(['Home', 'Home/Network', 'Home/Network/Switches'])
    expect(groupWithAncestors('')).toEqual([])
  })

  it('joins a name onto a parent, or onto nothing', () => {
    expect(joinGroupPath('Home', 'Network')).toBe('Home/Network')
    expect(joinGroupPath('', 'Network')).toBe('Network')
  })

  it('spells a path out for display', () => {
    expect(groupLabel('Home/Network')).toBe('Home / Network')
  })
})

describe('isWithinGroup', () => {
  it('is true for the group itself and anything beneath it', () => {
    expect(isWithinGroup('Home', 'Home')).toBe(true)
    expect(isWithinGroup('Home/Network', 'Home')).toBe(true)
    expect(isWithinGroup('Home/Network/Switches', 'Home')).toBe(true)
  })

  it('is not fooled by a name that merely starts the same way', () => {
    expect(isWithinGroup('Homelab', 'Home')).toBe(false)
    expect(isWithinGroup('Home', 'Home/Network')).toBe(false)
  })
})

describe('rebaseGroupPath', () => {
  it('moves a group and everything beneath it', () => {
    expect(rebaseGroupPath('Lab', 'Lab', 'Home/Lab')).toBe('Home/Lab')
    expect(rebaseGroupPath('Lab/Rack 1', 'Lab', 'Home/Lab')).toBe('Home/Lab/Rack 1')
  })

  it('renames in place', () => {
    expect(rebaseGroupPath('Home/Net/Switches', 'Home/Net', 'Home/Network')).toBe('Home/Network/Switches')
  })

  it('leaves groups outside the branch alone', () => {
    expect(rebaseGroupPath('Labs', 'Lab', 'Home/Lab')).toBe('Labs')
    expect(rebaseGroupPath('Office', 'Lab', 'Home/Lab')).toBe('Office')
  })
})

describe('groupInitials', () => {
  it('takes the first letter of each of the first two words', () => {
    expect(groupInitials('DNS Servers')).toBe('DS')
    expect(groupInitials('home network switches')).toBe('HN')
    expect(groupInitials('Rack-2')).toBe('R2')
  })

  it('takes two letters of a single word', () => {
    expect(groupInitials('Home')).toBe('HO')
    expect(groupInitials('X')).toBe('X')
  })

  it('stands for the group itself, not the groups it sits inside', () => {
    expect(groupInitials('Home/Network')).toBe('NE')
  })

  it('has nothing to give for no group', () => {
    expect(groupInitials('')).toBe('')
  })
})
