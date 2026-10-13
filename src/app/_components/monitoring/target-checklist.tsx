'use client'

import { useMemo } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { groupDepth, groupName } from '@/lib/group-path'
import { buildSidebarLayout, groupsInOrder, targetsWithin } from '@/lib/sidebar-layout'
import type { GroupOrder, Target } from '@/types/probe'

/**
 * A list of targets to tick, used wherever something applies to some targets
 * and not others: the ones an alert watches, the ones a share link carries.
 */

function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    // Drawn here rather than left to the browser, whose own checkbox is a
    // white square whatever the page around it looks like.
    <span className="relative inline-flex h-3.5 w-3.5 shrink-0">
      <input
        type="checkbox"
        checked={checked}
        // Not an attribute, so it can only be set on the element itself.
        ref={element => { if (element) element.indeterminate = indeterminate }}
        onChange={event => onChange(event.target.checked)}
        aria-label={label}
        className={cn(
          'peer h-3.5 w-3.5 cursor-pointer appearance-none rounded-[4px] border border-border bg-input transition-colors',
          'hover:border-muted-foreground checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
      />
      {indeterminate ? (
        <Minus className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-primary-foreground" strokeWidth={3.5} />
      ) : (
        <Check
          className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-primary-foreground opacity-0 peer-checked:opacity-100"
          strokeWidth={3.5}
        />
      )}
    </span>
  )
}

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
  const layout = useMemo(() => buildSidebarLayout(targets, groupOrders), [targets, groupOrders])
  const byId = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])

  const setMany = (ids: string[], ticked: boolean) => {
    const next = new Set(selected)
    for (const id of ids) {
      if (ticked) next.add(id)
      else next.delete(id)
    }
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {selected.size} of {targets.length} ticked
        </span>
        <button
          type="button"
          onClick={() => onChange(new Set(targets.map(target => target.id)))}
          className="ml-auto cursor-pointer text-primary underline-offset-2 hover:underline"
        >
          All
        </button>
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="cursor-pointer text-primary underline-offset-2 hover:underline"
        >
          None
        </button>
      </div>

      <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background/60 p-2">
        {groupsInOrder(layout).map(group => {
          const members = targetsWithin(layout, group)
          const ticked = members.filter(id => selected.has(id)).length
          const depth = groupDepth(group)

          return (
            <div key={group}>
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50 touch:py-2"
                style={{ paddingLeft: 4 + depth * 16 }}
              >
                <Checkbox
                  checked={members.length > 0 && ticked === members.length}
                  indeterminate={ticked > 0 && ticked < members.length}
                  onChange={next => setMany(members, next)}
                  label={`Every target in ${groupName(group)}`}
                />
                <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {groupName(group)}
                </span>
                <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  {ticked}/{members.length}
                </span>
              </label>

              {(layout.items[group] ?? []).map(id => {
                const target = byId.get(id)
                if (!target) return null
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50 touch:py-2"
                    style={{ paddingLeft: 20 + depth * 16 }}
                  >
                    <Checkbox
                      checked={selected.has(id)}
                      onChange={next => setMany([id], next)}
                      label={target.name}
                    />
                    <span className="min-w-0 truncate text-xs text-foreground">{target.name}</span>
                    {target.note && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {target.note}
                      </span>
                    )}
                    <span className="ml-auto min-w-0 max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">
                      {target.host}
                    </span>
                  </label>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
