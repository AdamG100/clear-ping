import { describe, expect, it } from 'vitest'
import type { Target } from '@/types/probe'
import {
  UNGROUPED,
  buildSidebarLayout,
  groupsInOrder,
  locateTarget,
  moveTarget,
  reorderSubgroups,
  subgroups,
  targetOrderUpdates,
  targetsWithin,
  withGroup,
  withoutEmptyGroup,
  type SidebarLayout,
} from './sidebar-layout'

function target(id: string, group: string | undefined, sortOrder: number): Target {
  return {
    id,
    name: id,
    host: `${id}.example`,
    probeType: 'ping',
    interval: 300,
    status: 'active',
    group,
    sortOrder,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

const layout: SidebarLayout = {
  groups: ['DNS', 'Web'],
  children: {},
  items: { DNS: ['a', 'b', 'c'], Web: ['x', 'y'] },
}

/** Home holds a target and two groups; one of those holds a group of its own. */
const nested: SidebarLayout = {
  groups: ['Home', 'Web'],
  children: { Home: ['Home/Network', 'Home/Lab'], 'Home/Network': ['Home/Network/Switches'] },
  items: {
    Home: ['door'],
    'Home/Network': ['router'],
    'Home/Network/Switches': ['sw1', 'sw2'],
    'Home/Lab': ['pi'],
    Web: ['x'],
  },
}

describe('buildSidebarLayout', () => {
  it('groups targets, orders them by sortOrder and files the groupless under Ungrouped', () => {
    const built = buildSidebarLayout(
      [target('b', 'DNS', 1), target('loose', undefined, 0), target('a', 'DNS', 0), target('empty', '', 1)],
      []
    )
    expect(built.items).toEqual({ DNS: ['a', 'b'], [UNGROUPED]: ['loose', 'empty'] })
    expect(built.children).toEqual({})
  })

  it('follows the saved group order, then the alphabet, with Ungrouped last', () => {
    const built = buildSidebarLayout(
      [target('1', 'Zed', 0), target('2', undefined, 0), target('3', 'Alpha', 0), target('4', 'Pinned', 0)],
      [{ groupName: 'Pinned', sortOrder: 0 }]
    )
    expect(built.groups).toEqual(['Pinned', 'Alpha', 'Zed', UNGROUPED])
  })

  it('nests a group inside another by its path', () => {
    const built = buildSidebarLayout(
      [target('sw', 'Home/Network/Switches', 0), target('router', 'Home/Network', 0), target('x', 'Web', 0)],
      []
    )
    expect(built.groups).toEqual(['Home', 'Web'])
    expect(built.children).toEqual({ Home: ['Home/Network'], 'Home/Network': ['Home/Network/Switches'] })
    // Home has nothing of its own, and exists because of what is inside it.
    expect(built.items).toEqual({
      Home: [],
      'Home/Network': ['router'],
      'Home/Network/Switches': ['sw'],
      Web: ['x'],
    })
  })

  it('reads every spelling of a path as the one group', () => {
    const built = buildSidebarLayout([target('a', 'Home / Lab', 0), target('b', 'Home/Lab', 1)], [])
    expect(built.items['Home/Lab']).toEqual(['a', 'b'])
  })

  it('orders the groups inside a group among themselves', () => {
    const built = buildSidebarLayout(
      [target('1', 'Home/Alpha', 0), target('2', 'Home/Zed', 0), target('3', 'Home/Mid', 0)],
      [{ groupName: 'Home/Zed', sortOrder: 0 }]
    )
    expect(built.children.Home).toEqual(['Home/Zed', 'Home/Alpha', 'Home/Mid'])
  })
})

describe('reading the tree', () => {
  it('lists the groups inside a group, and the top level for none', () => {
    expect(subgroups(nested, '')).toEqual(['Home', 'Web'])
    expect(subgroups(nested, 'Home')).toEqual(['Home/Network', 'Home/Lab'])
    expect(subgroups(nested, 'Web')).toEqual([])
  })

  it('lists every group in the order the sidebar shows them', () => {
    expect(groupsInOrder(nested)).toEqual(['Home', 'Home/Network', 'Home/Network/Switches', 'Home/Lab', 'Web'])
  })

  it('gathers a group’s targets with those of the groups inside it', () => {
    expect(targetsWithin(nested, 'Home')).toEqual(['door', 'router', 'sw1', 'sw2', 'pi'])
    expect(targetsWithin(nested, 'Home/Network')).toEqual(['router', 'sw1', 'sw2'])
    expect(targetsWithin(nested, 'Web')).toEqual(['x'])
    expect(targetsWithin(nested, 'Nowhere')).toEqual([])
  })

  it('finds a target however deep it sits', () => {
    expect(locateTarget(nested, 'sw2')).toEqual({ group: 'Home/Network/Switches', index: 1 })
    expect(locateTarget(nested, 'missing')).toBeNull()
  })
})

describe('moveTarget', () => {
  it('reorders within a group', () => {
    expect(moveTarget(layout, 'a', { group: 'DNS', index: 2 }).items.DNS).toEqual(['b', 'c', 'a'])
    expect(moveTarget(layout, 'c', { group: 'DNS', index: 0 }).items.DNS).toEqual(['c', 'a', 'b'])
  })

  it('moves a target into another group at the given position', () => {
    const moved = moveTarget(layout, 'b', { group: 'Web', index: 1 })
    expect(moved.items).toEqual({ DNS: ['a', 'c'], Web: ['x', 'b', 'y'] })
  })

  it('moves a target between a group and one inside it', () => {
    const moved = moveTarget(nested, 'door', { group: 'Home/Network/Switches', index: 1 })
    expect(moved.items.Home).toEqual([])
    expect(moved.items['Home/Network/Switches']).toEqual(['sw1', 'door', 'sw2'])
    expect(moved.children).toBe(nested.children)
  })

  it('clamps an index past the end', () => {
    expect(moveTarget(layout, 'a', { group: 'Web', index: 99 }).items.Web).toEqual(['x', 'y', 'a'])
  })

  it('returns the same object when nothing would change', () => {
    expect(moveTarget(layout, 'b', { group: 'DNS', index: 1 })).toBe(layout)
    expect(moveTarget(layout, 'c', { group: 'DNS', index: 99 })).toBe(layout)
    expect(moveTarget(layout, 'missing', { group: 'DNS', index: 0 })).toBe(layout)
    expect(moveTarget(layout, 'a', { group: 'Nowhere', index: 0 })).toBe(layout)
  })

  it('does not mutate the layout it was given', () => {
    const before = JSON.stringify(layout)
    moveTarget(layout, 'a', { group: 'Web', index: 0 })
    expect(JSON.stringify(layout)).toBe(before)
  })
})

describe('reorderSubgroups', () => {
  it('reorders the top level or the inside of one group, and nothing else', () => {
    expect(reorderSubgroups(nested, '', ['Web', 'Home']).groups).toEqual(['Web', 'Home'])

    const inside = reorderSubgroups(nested, 'Home', ['Home/Lab', 'Home/Network'])
    expect(inside.children.Home).toEqual(['Home/Lab', 'Home/Network'])
    expect(inside.groups).toBe(nested.groups)
    expect(inside.children['Home/Network']).toBe(nested.children['Home/Network'])
  })
})

describe('groups with nothing in them', () => {
  it('lays out a group that holds no target, and the groups it sits inside', () => {
    const built = buildSidebarLayout([target('a', 'DNS', 0)], [], ['DNS', 'Home/Network/Switches', 'Spare'])
    expect(built.groups).toEqual(['DNS', 'Home', 'Spare'])
    expect(built.children).toEqual({ Home: ['Home/Network'], 'Home/Network': ['Home/Network/Switches'] })
    expect(built.items).toEqual({ DNS: ['a'], Home: [], 'Home/Network': [], 'Home/Network/Switches': [], Spare: [] })
    expect(targetsWithin(built, 'Home')).toEqual([])
  })

  it('places an empty group among its neighbours by its saved position', () => {
    const built = buildSidebarLayout([target('a', 'DNS', 0)], [{ groupName: 'Spare', sortOrder: 0 }, { groupName: 'DNS', sortOrder: 1 }], ['Spare'])
    expect(built.groups).toEqual(['Spare', 'DNS'])
  })

  it('leaves them out when it is not told which groups there are', () => {
    expect(buildSidebarLayout([target('a', 'DNS', 0)], []).groups).toEqual(['DNS'])
  })
})

describe('withGroup and withoutEmptyGroup', () => {
  it('adds an empty group once, at the end', () => {
    const added = withGroup(layout, UNGROUPED)
    expect(added.groups).toEqual(['DNS', 'Web', UNGROUPED])
    expect(added.items[UNGROUPED]).toEqual([])
    expect(withGroup(added, UNGROUPED)).toBe(added)
  })

  it('takes the offered group away again when nothing was dropped on it', () => {
    const offered = withGroup(layout, UNGROUPED)
    expect(withoutEmptyGroup(offered, UNGROUPED)).toEqual(layout)
  })

  it('leaves it where something was dropped on it, and when it was never there', () => {
    const dropped = moveTarget(withGroup(layout, UNGROUPED), 'a', { group: UNGROUPED, index: 0 })
    expect(withoutEmptyGroup(dropped, UNGROUPED)).toBe(dropped)
    expect(withoutEmptyGroup(layout, UNGROUPED)).toBe(layout)
  })

  it('takes away nothing else: a group somebody made stays when it is emptied', () => {
    const emptied = moveTarget(moveTarget(layout, 'x', { group: 'DNS', index: 0 }), 'y', { group: 'DNS', index: 0 })
    expect(withoutEmptyGroup(withGroup(emptied, UNGROUPED), UNGROUPED)).toEqual({
      groups: ['DNS', 'Web'],
      children: {},
      items: { DNS: ['y', 'x', 'a', 'b', 'c'], Web: [] },
    })
  })

  it('leaves a group that holds nothing itself but has a group inside it', () => {
    const moved = moveTarget(nested, 'door', { group: 'Web', index: 0 })
    expect(withoutEmptyGroup(moved, 'Home')).toBe(moved)
  })
})

describe('targetOrderUpdates', () => {
  it('renumbers the one group when a target moved within it', () => {
    const moved = moveTarget(layout, 'c', { group: 'DNS', index: 0 })
    expect(targetOrderUpdates(moved, 'c', 'DNS')).toEqual([
      { id: 'c', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ])
  })

  it('renumbers both groups and regroups only the moved target', () => {
    const moved = moveTarget(layout, 'b', { group: 'Web', index: 0 })
    expect(targetOrderUpdates(moved, 'b', 'DNS')).toEqual([
      { id: 'a', sortOrder: 0 },
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 0, group: 'Web' },
      { id: 'x', sortOrder: 1 },
      { id: 'y', sortOrder: 2 },
    ])
  })

  it('saves a move into a nested group under its whole path', () => {
    const moved = moveTarget(nested, 'x', { group: 'Home/Network/Switches', index: 0 })
    expect(targetOrderUpdates(moved, 'x', 'Web')).toContainEqual({
      id: 'x',
      sortOrder: 0,
      group: 'Home/Network/Switches',
    })
  })

  it('saves a move to Ungrouped as an empty group name', () => {
    const moved = moveTarget(withGroup(layout, UNGROUPED), 'a', { group: UNGROUPED, index: 0 })
    expect(targetOrderUpdates(moved, 'a', 'DNS')).toContainEqual({ id: 'a', sortOrder: 0, group: '' })
  })

  it('copes with the source group having been left empty, or taken away', () => {
    const single: SidebarLayout = { groups: ['Solo', 'Web'], children: {}, items: { Solo: ['s'], Web: ['x'] } }
    const moved = withoutEmptyGroup(moveTarget(single, 's', { group: 'Web', index: 1 }), 'Solo')
    expect(targetOrderUpdates(moved, 's', 'Solo')).toEqual([
      { id: 'x', sortOrder: 0 },
      { id: 's', sortOrder: 1, group: 'Web' },
    ])
    expect(locateTarget(moved, 's')).toEqual({ group: 'Web', index: 1 })
  })
})
