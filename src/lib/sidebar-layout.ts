import type { GroupOrder, Target } from '@/types/probe'

/**
 * The sidebar's arrangement of targets: which groups exist, in what order, and
 * which target ids each holds.
 *
 * Kept as plain data, separate from the components, because dragging edits it
 * many times a second before anything is saved. Each edit is a pure function
 * of the previous arrangement, which is what makes cancelling a drag as simple
 * as putting the old object back.
 */
export interface SidebarLayout {
  groups: string[]
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

export function buildSidebarLayout(targets: Target[], groupOrders: GroupOrder[]): SidebarLayout {
  const byGroup: Record<string, Target[]> = {}
  for (const target of targets) {
    (byGroup[target.group || UNGROUPED] ??= []).push(target)
  }

  const items: Record<string, string[]> = {}
  for (const [group, list] of Object.entries(byGroup)) {
    items[group] = [...list]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(target => target.id)
  }

  // Persisted order first; groups nobody has ordered yet go last, alphabetically,
  // with the catch-all group at the very end.
  const orderOf = new Map(groupOrders.map(order => [order.groupName, order.sortOrder]))
  const groups = Object.keys(items).sort((a, b) => {
    const aOrder = orderOf.get(a) ?? 999
    const bOrder = orderOf.get(b) ?? 999
    if (aOrder !== bOrder) return aOrder - bOrder
    if (a === UNGROUPED) return 1
    if (b === UNGROUPED) return -1
    return a.localeCompare(b)
  })

  return { groups, items }
}

export function locateTarget(layout: SidebarLayout, id: string): TargetSlot | null {
  for (const group of layout.groups) {
    const index = (layout.items[group] ?? []).indexOf(id)
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
  if (!current || !layout.groups.includes(slot.group)) return layout

  const destination = (layout.items[slot.group] ?? []).filter(other => other !== id)
  const index = Math.max(0, Math.min(slot.index, destination.length))
  if (current.group === slot.group && current.index === index) return layout

  const items = { ...layout.items }
  items[current.group] = layout.items[current.group].filter(other => other !== id)
  items[slot.group] = [...destination.slice(0, index), id, ...destination.slice(index)]

  return { groups: layout.groups, items }
}

/** Add an empty group to the end, if it is not already present. */
export function withGroup(layout: SidebarLayout, group: string): SidebarLayout {
  if (layout.groups.includes(group)) return layout
  return { groups: [...layout.groups, group], items: { ...layout.items, [group]: [] } }
}

/** Drop groups left with nothing in them. A group exists only through its targets. */
export function pruneEmptyGroups(layout: SidebarLayout): SidebarLayout {
  const groups = layout.groups.filter(group => (layout.items[group] ?? []).length > 0)
  if (groups.length === layout.groups.length) return layout

  const items: Record<string, string[]> = {}
  for (const group of groups) items[group] = layout.items[group]
  return { groups, items }
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
