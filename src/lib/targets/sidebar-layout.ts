import type { GroupOrder, Target } from '@/types/probe'
import { groupName, groupWithAncestors, normalizeGroupPath, parentGroup } from './group-path'

/**
 * The sidebar's arrangement of targets: which groups exist, which sit inside
 * which, in what order, and which target ids each holds.
 *
 * Kept as plain data, separate from the components, because dragging edits it
 * many times a second before anything is saved. Each edit is a pure function
 * of the previous arrangement, which is what makes cancelling a drag as simple
 * as putting the old object back.
 *
 * A group is named by its whole path (see group-path.ts), so every key here is
 * unique however deep it sits.
 */
export interface SidebarLayout {
  /** The groups at the top level, in order. */
  groups: string[]
  /** The groups directly inside each group, in order. Absent where there are none. */
  children: Record<string, string[]>
  /** Each group's own targets, not those of the groups inside it. */
  items: Record<string, string[]>
}

export interface TargetSlot {
  group: string
  index: number
}

export interface TargetOrderUpdate {
  id: string
  sortOrder: number
  group?: string
}

/** The group shown for targets that have none. Stored as an empty group name. */
export const UNGROUPED = 'Ungrouped'

/** As much of a target as arranging it takes. */
type Arrangeable = Pick<Target, 'id' | 'group' | 'sortOrder'>

/**
 * `keptGroups` is every group there is. Left out, only the groups that have a
 * target somewhere in them are laid out, which is what a list of targets to
 * tick wants: an empty group there is a row with nothing to tick.
 */
export function buildSidebarLayout(
  targets: Arrangeable[],
  groupOrders: GroupOrder[],
  keptGroups: string[] = []
): SidebarLayout {
  const byGroup: Record<string, Arrangeable[]> = {}
  for (const group of keptGroups) {
    for (const ancestor of groupWithAncestors(group)) byGroup[ancestor] ??= []
  }
  for (const target of targets) {
    const group = normalizeGroupPath(target.group) || UNGROUPED
    ;(byGroup[group] ??= []).push(target)
    // A group with nothing of its own still exists if a group inside it does.
    for (const ancestor of groupWithAncestors(group)) byGroup[ancestor] ??= []
  }

  const items: Record<string, string[]> = {}
  for (const [group, list] of Object.entries(byGroup)) {
    items[group] = [...list]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(target => target.id)
  }

  // Persisted order first; groups nobody has ordered yet go last, alphabetically,
  // with the catch-all group at the very end. A position is among siblings.
  const orderOf = new Map(groupOrders.map(order => [order.groupName, order.sortOrder]))
  const inOrder = (a: string, b: string) => {
    const aOrder = orderOf.get(a) ?? 999
    const bOrder = orderOf.get(b) ?? 999
    if (aOrder !== bOrder) return aOrder - bOrder
    if (a === UNGROUPED) return 1
    if (b === UNGROUPED) return -1
    return groupName(a).localeCompare(groupName(b))
  }

  const groups: string[] = []
  const children: Record<string, string[]> = {}
  for (const group of Object.keys(items)) {
    const parent = parentGroup(group)
    if (parent) (children[parent] ??= []).push(group)
    else groups.push(group)
  }
  groups.sort(inOrder)
  for (const list of Object.values(children)) list.sort(inOrder)

  return { groups, children, items }
}

/** The groups directly inside `parent`; the top level for an empty parent. */
export function subgroups(layout: SidebarLayout, parent: string): string[] {
  return parent ? layout.children[parent] ?? [] : layout.groups
}

/** Every group, in the order the sidebar lists them: each one, then what is inside it. */
export function groupsInOrder(layout: SidebarLayout, parent = ''): string[] {
  return subgroups(layout, parent).flatMap(group => [group, ...groupsInOrder(layout, group)])
}

/**
 * The groups ticked whole: every target in them ticked, and every group inside
 * them ticked whole too. A group with no target anywhere in it has nothing to
 * tick, so it counts only if it is in `tickedGroups` itself. Outermost first,
 * as `groupsInOrder` lists them. The catch-all group is never one: it is not
 * a group that exists, only where targets without one are shown.
 */
export function wholeGroups(layout: SidebarLayout, ticked: Set<string>, tickedGroups: Set<string>): string[] {
  const whole = (group: string): boolean =>
    (layout.items[group] ?? []).every(id => ticked.has(id)) &&
    subgroups(layout, group).every(whole) &&
    (targetsWithin(layout, group).length > 0 || tickedGroups.has(group))
  return groupsInOrder(layout).filter(group => group !== UNGROUPED && whole(group))
}

/** Every target in a group and in the groups inside it, in sidebar order. */
export function targetsWithin(layout: SidebarLayout, group: string): string[] {
  return [
    ...(layout.items[group] ?? []),
    ...subgroups(layout, group).flatMap(child => targetsWithin(layout, child)),
  ]
}

export function locateTarget(layout: SidebarLayout, id: string): TargetSlot | null {
  for (const [group, ids] of Object.entries(layout.items)) {
    const index = ids.indexOf(id)
    if (index !== -1) return { group, index }
  }
  return null
}

/**
 * Move a target to `slot`, where `slot.index` counts positions among the
 * *other* targets of the destination group. Returns the same object when the
 * target is already there, so callers can skip a re-render by identity.
 */
export function moveTarget(layout: SidebarLayout, id: string, slot: TargetSlot): SidebarLayout {
  const current = locateTarget(layout, id)
  if (!current || !(slot.group in layout.items)) return layout

  const destination = layout.items[slot.group].filter(other => other !== id)
  const index = Math.max(0, Math.min(slot.index, destination.length))
  if (current.group === slot.group && current.index === index) return layout

  const items = { ...layout.items }
  items[current.group] = layout.items[current.group].filter(other => other !== id)
  items[slot.group] = [...destination.slice(0, index), id, ...destination.slice(index)]

  return { ...layout, items }
}

/** Put the groups inside `parent` in a new order. */
export function reorderSubgroups(layout: SidebarLayout, parent: string, ordered: string[]): SidebarLayout {
  return parent
    ? { ...layout, children: { ...layout.children, [parent]: ordered } }
    : { ...layout, groups: ordered }
}

/** Add an empty group to the end of the top level, if it is not already present. */
export function withGroup(layout: SidebarLayout, group: string): SidebarLayout {
  if (group in layout.items) return layout
  return { ...layout, groups: [...layout.groups, group], items: { ...layout.items, [group]: [] } }
}

/**
 * Take a group back off the top level if nothing is in it: the opposite of
 * `withGroup`. A group with something in it, or one that is not there, leaves
 * the arrangement as it was.
 *
 * For Ungrouped, which is not a group anyone made but the place targets
 * without one are listed, and so is only there while there are some. A real
 * group stays when it is emptied.
 */
export function withoutEmptyGroup(layout: SidebarLayout, group: string): SidebarLayout {
  if (!layout.groups.includes(group)) return layout
  if ((layout.items[group] ?? []).length > 0 || subgroups(layout, group).length > 0) return layout

  const items = { ...layout.items }
  delete items[group]
  return { ...layout, groups: layout.groups.filter(other => other !== group), items }
}

/**
 * What has to be saved after `id` moved from `from` to its place in `layout`.
 *
 * Every target in the two groups involved is renumbered, not just the one that
 * moved: sort orders are only meaningful relative to their neighbours, and
 * targets created before ordering existed all share the same value.
 */
export function targetOrderUpdates(layout: SidebarLayout, id: string, from: string): TargetOrderUpdate[] {
  const to = locateTarget(layout, id)?.group
  if (!to) return []

  const updates: TargetOrderUpdate[] = []
  for (const group of new Set([from, to])) {
    (layout.items[group] ?? []).forEach((targetId, sortOrder) => {
      const regrouped = targetId === id && from !== to
      updates.push(
        regrouped
          ? { id: targetId, sortOrder, group: to === UNGROUPED ? '' : to }
          : { id: targetId, sortOrder }
      )
    })
  }
  return updates
}
