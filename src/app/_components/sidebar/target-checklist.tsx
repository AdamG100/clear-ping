'use client'

import { useId, useMemo } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area'
import { groupDepth, groupName } from '@/lib/targets/group-path'
import { buildSidebarLayout, groupsInOrder, targetsWithin } from '@/lib/targets/sidebar-layout'
import type { GroupOrder, Target } from '@/types/probe'

/**
 * A list of targets to tick, used wherever something applies to some targets
 * and not others: the ones an alert watches, the ones a share link carries.
 */

/** As much of a target as listing it takes, so a target not yet added can be listed too. */
export type ChecklistTarget = Pick<Target, 'id' | 'name' | 'host' | 'group' | 'sortOrder'> & {
  /** Something about this one that bears on whether to tick it. */
  note?: string
}

/**
 * The targets, laid out as the sidebar lays them out. Ticking a group ticks
 * everything in it, and in the groups inside it.
 */
export function TargetChecklist({
  targets,
  groupOrders,
  selected,
  onChange,
}: {
  targets: ChecklistTarget[]
  groupOrders: GroupOrder[]
  selected: Set<string>
  onChange: (selected: Set<string>) => void
}) {
  const id = useId()
  const layout = useMemo(() => buildSidebarLayout(targets, groupOrders), [targets, groupOrders])
  const byId = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])

  const setMany = (ids: string[], ticked: boolean) => {
    const next = new Set(selected)
    for (const each of ids) {
      if (ticked) next.add(each)
      else next.delete(each)
    }
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground tabular-nums">
          {selected.size} of {targets.length} ticked
        </span>
        <span className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(new Set(targets.map(target => target.id)))}>
            Tick all
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(new Set())}>
            Tick none
          </Button>
        </span>
      </div>

      <div className="rounded-2xl border border-border bg-background">
        <ScrollArea maxHeight="16rem" label="Targets to tick">
          <div className="p-1">
            {groupsInOrder(layout).map(group => {
              const members = targetsWithin(layout, group)
              const ticked = members.filter(member => selected.has(member)).length
              const depth = groupDepth(group)
              const groupId = `${id}-group-${group}`

              return (
                <div key={group}>
                  <div className="flex items-center gap-1 pr-3" style={{ paddingLeft: depth * 16 }}>
                    <Checkbox
                      id={groupId}
                      checked={members.length > 0 && ticked === members.length ? true : ticked > 0 ? 'indeterminate' : false}
                      onCheckedChange={next => setMany(members, next === true)}
                      aria-label={`Every target in ${groupName(group)}`}
                    />
                    <label htmlFor={groupId} className="min-w-0 flex-1 cursor-pointer truncate text-sm font-medium text-muted-foreground">
                      {groupName(group)}
                    </label>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {ticked}/{members.length}
                    </span>
                  </div>

                  {(layout.items[group] ?? []).map(member => {
                    const target = byId.get(member)
                    if (!target) return null
                    const targetId = `${id}-target-${member}`
                    return (
                      <div key={member} className="flex items-center gap-1 pr-3" style={{ paddingLeft: 16 + depth * 16 }}>
                        <Checkbox
                          id={targetId}
                          checked={selected.has(member)}
                          onCheckedChange={next => setMany([member], next === true)}
                          aria-label={target.name}
                        />
                        <label htmlFor={targetId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <span className="min-w-0 truncate text-sm text-foreground">{target.name}</span>
                          {target.note && <Badge size="sm">{target.note}</Badge>}
                          <span className="ml-auto min-w-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground">
                            {target.host}
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
