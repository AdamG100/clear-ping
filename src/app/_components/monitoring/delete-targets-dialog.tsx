'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { TargetChecklist } from './target-checklist'
import type { GroupOrder, Target } from '@/types/probe'

/**
 * Deleting several targets at once.
 *
 * Clearing out a list one row at a time is a delete button and a dialog for
 * every target in it. Here they are ticked, one by one or a group at a go,
 * and deleted together.
 *
 * Nothing starts ticked, and the delete has to be held down. What it removes
 * is every reading those targets ever had, and there is no undo.
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

  // Only what is still there to delete: the list is reloaded behind an open dialog.
  const chosen = targets.filter(target => selected.has(target.id))
  const everything = chosen.length === targets.length && targets.length > 0

  const remove = async () => {
    const deleted = await onDelete(chosen.map(target => target.id))
    if (!deleted) throw new Error('Not deleted')
    onClose()
  }

  return (
    <div className="space-y-4">
      <TargetChecklist targets={targets} groupOrders={groupOrders} selected={selected} onChange={setSelected} />

      {chosen.length > 0 ? (
        <Alert tone="danger" title={everything ? 'Every target there is' : `${plural(chosen.length)} and their history`}>
          This deletes everything recorded for {chosen.length === 1 ? 'it' : 'them'}: measurement history, alert rules
          and saved routes. It cannot be undone.
        </Alert>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          A target&apos;s whole history goes with it. Groups are left in place, empty. To stop probing a target but keep
          what it has recorded, pause it instead.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Focused first, so Enter on a dialog opened by accident deletes nothing. */}
        <Button type="button" variant="secondary" onClick={onClose} autoFocus>
          Cancel
        </Button>
        {chosen.length === 0 ? (
          <Button type="button" variant="danger" disabled>
            Tick the targets to delete
          </Button>
        ) : (
          // Keyed by the selection: a change to what is ticked is a change to
          // what was about to be deleted, so it starts over.
          <ConfirmMorph
            key={chosen.map(target => target.id).join(',')}
            label={`Delete ${plural(chosen.length)}`}
            icon={<Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />}
            prompt={`Delete ${plural(chosen.length)}?`}
            confirmLabel="Hold to delete"
            pendingLabel="Deleting"
            doneLabel="Deleted"
            confirmMode="hold"
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
      <DialogContent title="Delete targets" description="Tick the targets to delete, one by one or a whole group at a time.">
        {/* Inside the dialog's content, which is unmounted on close, so every
            opening starts with nothing ticked. */}
        <DeleteTargetsBody {...body} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
