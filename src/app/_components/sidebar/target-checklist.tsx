'use client'

import { useId, useMemo, useState } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area'
import { SearchField } from '@/components/arc/search-field/search-field'
import { SearchResults } from '@/components/search-results'
import { groupDepth, groupName, isWithinGroup } from '@/lib/targets/group-path'
import { buildSidebarLayout, groupsInOrder, targetsWithin, wholeGroups } from '@/lib/targets/sidebar-layout'
import type { GroupOrder, Target } from '@/types/probe'
import { Masked } from '../privacy/masked'

/**
 * A list of targets to tick, used wherever something applies to some targets
 * and not others: the ones an alert watches, the ones a share link carries.
 */

/** As much of a target as listing it takes, so a target not yet added can be listed too. */
export type ChecklistTarget = Pick<Target, 'id' | 'name' | 'host' | 'group' | 'sortOrder'> & {
  /** Something about this one that bears on whether to tick it. */
  note?: string
}

/** For a list where the groups themselves are what is being chosen, not only what is in them. */
export interface GroupTicking {
  /** Every group there is, the empty ones included, so they can be ticked too. */
  groups: string[]
  /** The groups ticked themselves: what counts for a group with nothing in it. */
  ticked: Set<string>
  onChange: (ticked: Set<string>) => void
}

/**
 * The targets, laid out as the sidebar lays them out. Ticking a group ticks
 * everything in it, and in the groups inside it.
 *
 * `searchable` puts a search above the list, by name, address or group. What
 * is ticked stays ticked while the search hides it; a group's box still acts
 * on the whole group, whatever of it is shown.
 */
export function TargetChecklist({
  targets,
  groupOrders,
  selected,
  onChange,
  groupTicking,
  searchable = false,
  maxHeight = '16rem',
}: {
  targets: ChecklistTarget[]
  groupOrders: GroupOrder[]
  selected: Set<string>
  onChange: (selected: Set<string>) => void
  groupTicking?: GroupTicking
  searchable?: boolean
  maxHeight?: string
}) {
  const id = useId()
  const [search, setSearch] = useState('')
  const keptGroups = groupTicking?.groups
  const layout = useMemo(() => buildSidebarLayout(targets, groupOrders, keptGroups), [targets, groupOrders, keptGroups])
  const byId = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])
  const ticked = groupTicking?.ticked
  const whole = useMemo(
    () => (ticked ? new Set(wholeGroups(layout, selected, ticked)) : null),
    [ticked, layout, selected]
  )

  // What the search leaves on show: the targets it finds, everything in a
  // group whose name it finds, and the groups on the way down to them.
  const query = search.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!query) return null
    const groups = groupsInOrder(layout)
    const named = groups.filter(group => groupName(group).toLowerCase().includes(query))
    const inNamed = (group: string) => named.some(match => isWithinGroup(group, match))
    const found = new Set(
      targets
        .filter(target => {
          const group = groups.find(each => layout.items[each]?.includes(target.id)) ?? ''
          return target.name.toLowerCase().includes(query) || target.host.toLowerCase().includes(query) || inNamed(group)
        })
        .map(target => target.id)
    )
    const groupsShown = new Set(
      groups.filter(group => inNamed(group) || targetsWithin(layout, group).some(member => found.has(member)))
    )
    return { targets: found, groups: groupsShown }
  }, [query, layout, targets])

  const visibleGroups = groupsInOrder(layout).filter(group => !shown || shown.groups.has(group))

  const setMany = (ids: string[], tick: boolean) => {
    const next = new Set(selected)
    for (const each of ids) {
      if (tick) next.add(each)
      else next.delete(each)
    }
    onChange(next)
  }

  // A group, and the groups inside it, along with every target in them.
  const setGroup = (group: string, tick: boolean) => {
    setMany(targetsWithin(layout, group), tick)
    if (!groupTicking) return
    const next = new Set(groupTicking.ticked)
    for (const each of [group, ...groupsInOrder(layout, group)]) {
      if (tick) next.add(each)
      else next.delete(each)
    }
    groupTicking.onChange(next)
  }

  // Searching, these act on what is on show and leave the rest as it was.
  const tickAll = () => {
    if (shown) {
      setMany([...shown.targets], true)
      return
    }
    onChange(new Set(targets.map(target => target.id)))
    groupTicking?.onChange(new Set(groupsInOrder(layout)))
  }
  const tickNone = () => {
    if (shown) {
      setMany([...shown.targets], false)
      groupTicking?.onChange(new Set([...groupTicking.ticked].filter(group => !shown.groups.has(group))))
      return
    }
    onChange(new Set())
    groupTicking?.onChange(new Set())
  }

  return (
    <div className="space-y-2">
      {searchable && (
        <SearchField
          label="Search targets"
          placeholder="Search name, address or group"
          value={search}
          onValueChange={setSearch}
        />
      )}

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground tabular-nums">
          {selected.size} of {targets.length} ticked
        </span>
        <span className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={tickAll} disabled={shown?.targets.size === 0}>
            {shown ? 'Tick shown' : 'Tick all'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={tickNone} disabled={shown?.targets.size === 0}>
            {shown ? 'Untick shown' : 'Tick none'}
          </Button>
        </span>
      </div>

      <div className="rounded-2xl border border-border bg-background">
        <ScrollArea maxHeight={maxHeight} label="Targets to tick">
          <SearchResults query={query} className="p-1">
            {visibleGroups.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches &ldquo;{search.trim()}&rdquo;.</p>
            )}
            {visibleGroups.map(group => {
              const members = targetsWithin(layout, group)
              const count = members.filter(member => selected.has(member)).length
              const depth = groupDepth(group)
              const groupId = `${id}-group-${group}`
              // Where the groups are being chosen, one is ticked only when it
              // will go whole, empty groups inside it included.
              const all = whole
                ? whole.has(group)
                : members.length > 0 && count === members.length
              const some = count > 0 || (whole !== null && groupsInOrder(layout, group).some(inside => whole.has(inside)))

              return (
                <div key={group}>
                  <div
                    className="flex items-center gap-2 rounded-lg py-1 pr-3 hover:bg-sidebar-row-hover"
                    style={{ paddingLeft: 8 + depth * 16 }}
                  >
                    <Checkbox
                      id={groupId}
                      checked={all ? true : some ? 'indeterminate' : false}
                      onCheckedChange={next => setGroup(group, next === true)}
                      aria-label={whole ? `The group ${groupName(group)} and everything in it` : `Every target in ${groupName(group)}`}
                    />
                    <label htmlFor={groupId} className="min-w-0 flex-1 cursor-pointer truncate text-sm font-medium text-foreground">
                      {groupName(group)}
                    </label>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {count}/{members.length}
                    </span>
                  </div>

                  {(layout.items[group] ?? []).map(member => {
                    const target = byId.get(member)
                    if (!target || (shown && !shown.targets.has(member))) return null
                    const targetId = `${id}-target-${member}`
                    return (
                      <div
                        key={member}
                        className="flex items-center gap-2 rounded-lg py-1 pr-3 hover:bg-sidebar-row-hover"
                        style={{ paddingLeft: 24 + depth * 16 }}
                      >
                        <Checkbox
                          id={targetId}
                          checked={selected.has(member)}
                          onCheckedChange={next => setMany([member], next === true)}
                          aria-label={target.name}
                        />
                        <label htmlFor={targetId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <span className="min-w-0 truncate text-sm text-foreground"><Masked text value={target.name} /></span>
                          {target.note && <Badge size="sm">{target.note}</Badge>}
                          {/* A target named by its address would say it twice. */}
                          {target.host !== target.name && (
                            <span className="ml-auto min-w-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground">
                              <Masked value={target.host} />
                            </span>
                          )}
                        </label>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </SearchResults>
        </ScrollArea>
      </div>
    </div>
  )
}
