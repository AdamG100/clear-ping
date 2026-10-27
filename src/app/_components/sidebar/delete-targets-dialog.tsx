'use client'

import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph, type ConfirmMorphState } from '@/components/arc/confirm-morph/confirm-morph'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { parentGroup } from '@/lib/targets/group-path'
import { buildSidebarLayout, wholeGroups } from '@/lib/targets/sidebar-layout'
import { TargetChecklist } from './target-checklist'
import type { GroupOrder, Target } from '@/types/probe'

/**
 * Deleting several targets at once.
 *
 * Clearing out a list one row at a time is a delete button and a dialog for
 * every target in it. Here they are found with the search, ticked one by one
 * or a group at a go, and deleted together. A group ticked whole goes too,
 * with the groups inside it, the empty ones included.
 *
 * Nothing starts ticked, and the delete has to be held down. What it removes
 * is every reading those targets ever had, and there is no undo.
 */

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** "3 targets", "a group", "3 targets and 2 groups". */
function describe(targets: number, groups: number): string {
  return [targets > 0 ? plural(targets, 'target') : '', groups > 0 ? plural(groups, 'group') : '']
    .filter(Boolean)
    .join(' and ')
}

interface DeleteTargetsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: Target[]
  groupOrders: GroupOrder[]
  /** Every group there is, the empty ones included. */
  groups: string[]
  /**
   * The targets, and the groups to go with them, each given once as the
   * outermost of what goes. Resolves to whether the delete was started; it
   * goes on in the background.
   */
  onDelete: (ids: string[], groups: string[]) => Promise<boolean>
}

function DeleteTargetsBody({ targets, groupOrders, groups, onDelete, onClose }: Omit<DeleteTargetsDialogProps, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const [selected, setSelected] = useState(() => new Set<string>())
  const [tickedGroups, setTickedGroups] = useState(() => new Set<string>())
  // While the delete button is asking, it carries its own Cancel.
  const [asking, setAsking] = useState<ConfirmMorphState>('idle')

  // Only what is still there to delete: the list is reloaded behind an open dialog.
  const chosen = targets.filter(target => selected.has(target.id))
  const everything = chosen.length === targets.length && targets.length > 0

  const layout = useMemo(() => buildSidebarLayout(targets, groupOrders, groups), [targets, groupOrders, groups])
  const going = useMemo(() => {
    const whole = wholeGroups(layout, selected, tickedGroups)
    const all = new Set(whole)
    // The ones inside go with the group around them, so only that one is named.
    return { all: whole.length, outermost: whole.filter(group => !all.has(parentGroup(group))) }
  }, [layout, selected, tickedGroups])

  const nothing = chosen.length === 0 && going.all === 0
  const what = describe(chosen.length, going.all)

  // Starts the delete and is done: it carries on in the background, with its
  // progress shown beside the dashboard, so the dialog is not kept open for it.
  const remove = async () => {
    const started = await onDelete(chosen.map(target => target.id), going.outermost)
    if (!started) throw new Error('Not deleted')
    onClose()
  }

  return (
    <div className="space-y-4 text-foreground">
      <TargetChecklist
        targets={targets}
        groupOrders={groupOrders}
        selected={selected}
        onChange={setSelected}
        groupTicking={{ groups, ticked: tickedGroups, onChange: setTickedGroups }}
        searchable
        maxHeight="min(22rem, 42dvh)"
      />

      {nothing ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Ticking a group deletes the group too, with everything in it. To stop probing a target but keep what it has
          recorded, pause it instead.
        </p>
      ) : (
        <Alert tone="danger" title={everything ? 'Every target there is' : `${what} will be deleted`}>
          {chosen.length > 0
            ? `Their measurement history, alert rules and saved routes go with them, and so does any group left empty. This cannot be undone.`
            : `${going.all === 1 ? 'It has' : 'They have'} nothing in ${going.all === 1 ? 'it' : 'them'}, so nothing else goes.`}
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {/* Focused first, so Enter on a dialog opened by accident deletes nothing. */}
        {asking === 'idle' && (
          <Button type="button" variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
        )}
        {nothing ? (
          <Button type="button" variant="danger" disabled>
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
            Delete
          </Button>
        ) : (
          // Keyed by the selection: a change to what is ticked is a change to
          // what was about to be deleted, so it starts over.
          <ConfirmMorph
            key={[...chosen.map(target => target.id), ...going.outermost].join(',')}
            label={`Delete ${what}`}
            icon={<Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />}
            prompt="For good?"
            confirmLabel="Hold to delete"
            pendingLabel="Starting"
            doneLabel="Started"
            confirmMode="hold"
            onStateChange={setAsking}
            onConfirm={remove}
          />
        )}
      </div>
    </div>
  )
}

export function DeleteTargetsDialog({ open, onOpenChange, ...body }: DeleteTargetsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than Arc's dialog: a name, its address and the delete button's
          question all need the room, and at 440px the button was cut off. */}
      <DialogContent
        title="Delete targets"
        description="Search, then tick targets one by one or a whole group at a time."
        style={{ width: 'min(calc(100vw - 2rem), 600px)' }}
      >
        {/* Inside the dialog's content, which is unmounted on close, so every
            opening starts with nothing ticked. */}
        <DeleteTargetsBody {...body} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
