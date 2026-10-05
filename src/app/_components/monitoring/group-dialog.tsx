'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  GROUP_SEPARATOR,
  groupLabel,
  groupName,
  isWithinGroup,
  joinGroupPath,
  parentGroup,
} from '@/lib/group-path'
import { FolderTree } from 'lucide-react'

/** The select cannot hold an empty value, so the top level needs a name. */
const TOP_LEVEL = '__top__'

interface GroupDialogProps {
  /** The group being edited; the dialog is open while this is set. */
  group: string | null
  /** Every group there is, as paths. */
  groups: string[]
  onCancel: () => void
  onSave: (from: string, to: string) => void
}

/**
 * Rename a group, or put it inside another.
 *
 * Both are the same change, a group's path becoming a different path, so they
 * share one dialog. Everything in the group goes with it.
 */
export function GroupDialog({ group, groups, onCancel, onSave }: GroupDialogProps) {
  return (
    <Dialog open={group !== null} onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent className="bg-card border-border sm:max-w-md" suppressHydrationWarning>
        {group !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="text-card-foreground flex items-center gap-2">
                <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                  <FolderTree className="h-4 w-4 text-primary" />
                </div>
                Edit group
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Rename the group or move it inside another. Its targets, and any groups inside it, go with it.
              </DialogDescription>
            </DialogHeader>

            {/* Keyed so a different group opens with its own values. */}
            <GroupForm key={group} group={group} groups={groups} onCancel={onCancel} onSave={onSave} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function GroupForm({ group, groups, onCancel, onSave }: GroupDialogProps & { group: string }) {
  const [name, setName] = useState(groupName(group))
  const [parent, setParent] = useState(parentGroup(group))

  // A group cannot go inside itself, or inside anything it contains.
  const parents = groups.filter(candidate => !isWithinGroup(candidate, group))

  const trimmed = name.trim()
  const problem = !trimmed
    ? 'Give the group a name.'
    : trimmed.includes(GROUP_SEPARATOR)
      ? `A name cannot contain "${GROUP_SEPARATOR}". Use the box below to put the group inside another.`
      : null

  const destination = problem ? group : joinGroupPath(parent, trimmed)
  const merges = destination !== group && groups.includes(destination)

  return (
    <form
      className="space-y-4 pt-2"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        if (problem) return
        if (destination !== group) onSave(group, destination)
        else onCancel()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="group-name" className="text-sm font-medium text-card-foreground">Name</Label>
        <Input
          id="group-name"
          value={name}
          onChange={e => setName(e.target.value)}
          aria-invalid={!!problem}
          aria-describedby={problem ? 'group-name-error' : undefined}
          className="bg-input border-border text-foreground"
          autoFocus
        />
        {problem && <p id="group-name-error" className="text-xs text-destructive">{problem}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="group-parent" className="text-sm font-medium text-card-foreground">Inside</Label>
        <Select value={parent || TOP_LEVEL} onValueChange={value => setParent(value === TOP_LEVEL ? '' : value)}>
          <SelectTrigger id="group-parent" className="bg-input border-border text-foreground h-9 w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TOP_LEVEL}>Nothing (top level)</SelectItem>
            {parents.map(candidate => (
              <SelectItem key={candidate} value={candidate}>{groupLabel(candidate)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {merges && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {groupLabel(destination)} already exists. Saving puts everything from this group into it.
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" aria-disabled={!!problem}>Save</Button>
      </div>
    </form>
  )
}
