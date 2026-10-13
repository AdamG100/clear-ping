'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TargetChecklist } from './target-checklist'
import type { GroupOrder, Target } from '@/types/probe'

/**
 * Deleting several targets at once.
 *
 * Clearing out a list one row at a time is a delete button and a dialog for
 * every target in it. Here they are ticked, one by one or a group at a go,
 * and deleted together.
 *
 * Nothing starts ticked, and the button has to be pressed twice. What it
 * removes is every reading those targets ever had, and there is no undo.
 */

function plural(count: number): string {
  return `${count} target${count === 1 ? '' : 's'}`
}

interface DeleteTargetsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: Target[]
  groupOrders: GroupOrder[]
  /** Resolves to whether they were deleted. */
  onDelete: (ids: string[]) => Promise<boolean>
}

function DeleteTargetsBody({ targets, groupOrders, onDelete, onClose }: Omit<DeleteTargetsDialogProps, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const [selected, setSelected] = useState(() => new Set<string>())
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Only what is still there to delete: the list is reloaded behind an open dialog.
  const chosen = targets.filter(target => selected.has(target.id))
  const everything = chosen.length === targets.length && targets.length > 0

  const remove = async () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setDeleting(true)
    const deleted = await onDelete(chosen.map(target => target.id))
    setDeleting(false)
    if (deleted) onClose()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-card-foreground">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
            <Trash2 className="h-4 w-4 text-destructive" />
          </div>
          Delete targets
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          Tick the targets to delete, one by one or a whole group at a time.
        </DialogDescription>
      </DialogHeader>

      <TargetChecklist
        targets={targets}
        groupOrders={groupOrders}
        selected={selected}
        // A change to the list is a change to what was about to be deleted,
        // so it has to be confirmed again.
        onChange={next => { setSelected(next); setConfirming(false) }}
      />

      {confirming ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-foreground" role="alert">
          This deletes {everything ? <span className="font-medium">every target there is</span> : plural(chosen.length)} and
          everything recorded for {chosen.length === 1 ? 'it' : 'them'}: measurement history, alert rules and saved routes. It
          cannot be undone. Press Delete again to go ahead.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          A target&apos;s whole history goes with it. Groups are left in place, empty. To stop probing a target but keep
          what it has recorded, pause it instead.
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        {/* Focused first, so Enter on a dialog opened by accident deletes nothing. */}
        <Button type="button" variant="outline" onClick={onClose} autoFocus>
          Cancel
        </Button>
        <Button type="button" variant="destructive" onClick={remove} disabled={chosen.length === 0 || deleting}>
          <Trash2 className="h-4 w-4" />
          {deleting
            ? 'Deleting…'
            : chosen.length === 0
              ? 'Tick the targets to delete'
              : confirming
                ? `Delete ${plural(chosen.length)}`
                : `Delete ${plural(chosen.length)}…`}
        </Button>
      </div>
    </>
  )
}

export function DeleteTargetsDialog({ open, onOpenChange, ...body }: DeleteTargetsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-xl" suppressHydrationWarning>
        {/* Inside the dialog's content, which is unmounted on close, so every
            opening starts with nothing ticked. */}
        <DeleteTargetsBody {...body} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
