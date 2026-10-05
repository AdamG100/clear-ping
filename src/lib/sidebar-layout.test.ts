import { describe, expect, it } from 'vitest'
import type { Target } from '@/types/probe'
import {
  UNGROUPED,
  buildSidebarLayout,
  locateTarget,
  moveTarget,
  pruneEmptyGroups,
  targetOrderUpdates,
  withGroup,
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
  items: { DNS: ['a', 'b', 'c'], Web: ['x', 'y'] },
}

describe('buildSidebarLayout', () => {
  it('groups targets, orders them by sortOrder and files the groupless under Ungrouped', () => {
    const built = buildSidebarLayout(
      [target('b', 'DNS', 1), target('loose', undefined, 0), target('a', 'DNS', 0), target('empty', '', 1)],
      []
    )
    expect(built.items).toEqual({ DNS: ['a', 'b'], [UNGROUPED]: ['loose', 'empty'] })
  })

  it('follows the saved group order, then the alphabet, with Ungrouped last', () => {
    const built = buildSidebarLayout(
      [target('1', 'Zed', 0), target('2', undefined, 0), target('3', 'Alpha', 0), target('4', 'Pinned', 0)],
      [{ groupName: 'Pinned', sortOrder: 0 }]
    )
    expect(built.groups).toEqual(['Pinned', 'Alpha', 'Zed', UNGROUPED])
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

describe('withGroup and pruneEmptyGroups', () => {
  it('adds an empty group once, at the end', () => {
    const added = withGroup(layout, UNGROUPED)
    expect(added.groups).toEqual(['DNS', 'Web', UNGROUPED])
    expect(added.items[UNGROUPED]).toEqual([])
    expect(withGroup(added, UNGROUPED)).toBe(added)
  })

  it('removes groups that were emptied and keeps the rest untouched', () => {
    const emptied = moveTarget(moveTarget(layout, 'x', { group: 'DNS', index: 0 }), 'y', { group: 'DNS', index: 0 })
    expect(pruneEmptyGroups(withGroup(emptied, UNGROUPED))).toEqual({
      groups: ['DNS'],
      items: { DNS: ['y', 'x', 'a', 'b', 'c'] },
    })
    expect(pruneEmptyGroups(layout)).toBe(layout)
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

  it('saves a move to Ungrouped as an empty group name', () => {
    const moved = moveTarget(withGroup(layout, UNGROUPED), 'a', { group: UNGROUPED, index: 0 })
    expect(targetOrderUpdates(moved, 'a', 'DNS')).toContainEqual({ id: 'a', sortOrder: 0, group: '' })
  })

  it('copes with the source group having been pruned away', () => {
    const single: SidebarLayout = { groups: ['Solo', 'Web'], items: { Solo: ['s'], Web: ['x'] } }
    const moved = pruneEmptyGroups(moveTarget(single, 's', { group: 'Web', index: 1 }))
    expect(targetOrderUpdates(moved, 's', 'Solo')).toEqual([
      { id: 'x', sortOrder: 0 },
      { id: 's', sortOrder: 1, group: 'Web' },
    ])
    expect(locateTarget(moved, 's')).toEqual({ group: 'Web', index: 1 })
  })
})
