'use client'

import { Fragment, useState } from 'react'
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
  splitGroupPath,
} from '@/lib/group-path'
import { ChevronRight, FolderPlus, FolderTree } from 'lucide-react'

/** The select cannot hold an empty value, so the top level needs a name. */
const TOP_LEVEL = '__top__'

/** What the dialog has been opened to do. */
export type GroupDialogTask =
  | {
      kind: 'create'
      /** The group the new one starts inside; empty for the top level. */
      parent: string
    }
  | {
      kind: 'edit'
      group: string
      /** How much is in it, at any depth: what deleting it would move. */
      targets: number
      groups: number
    }

interface GroupDialogProps {
  /** The dialog is open while this is set. */
  task: GroupDialogTask | null
  /** Every group there is, as paths. */
  groups: string[]
  onCancel: () => void
  onCreate: (group: string) => void
  onMove: (from: string, to: string) => void
  onDelete: (group: string) => void
}

/**
 * Make a group, or change one: rename it, put it inside another, delete it.
 *
 * Making and changing are one form because they ask the same two things, what
 * the group is called and what it sits inside. Nesting is the second of them,
 * a list to pick from, and nobody has to know that a group is stored as a path
 * with slashes in it.
 */
export function GroupDialog({ task, ...form }: GroupDialogProps) {
  const creating = task?.kind === 'create'
  const TitleIcon = creating ? FolderPlus : FolderTree

  return (
    <Dialog open={task !== null} onOpenChange={open => { if (!open) form.onCancel() }}>
      <DialogContent className="bg-card border-border sm:max-w-md" suppressHydrationWarning>
        {task !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="text-card-foreground flex items-center gap-2">
                <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                  <TitleIcon className="h-4 w-4 text-primary" />
                </div>
                {creating ? 'New group' : 'Edit group'}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {creating
                  ? 'Somewhere to keep targets that belong together. It can sit inside another group, and start out empty.'
                  : 'Rename the group or move it inside another. Its targets, and any groups inside it, go with it.'}
              </DialogDescription>
            </DialogHeader>

            {/* Keyed so a different group opens with its own values. */}
            <GroupForm key={task.kind === 'edit' ? `edit:${task.group}` : `create:${task.parent}`} task={task} {...form} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A group's place in the tree, outermost first, with the group itself picked out. */
function GroupPath({ path }: { path: string }) {
  const segments = splitGroupPath(path)

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 align-bottom">
      {segments.map((segment, index) => (
        // A path can hold the same name twice, so the place is part of the key.
        <Fragment key={`${index}:${segment}`}>
          {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />}
          <span className={index === segments.length - 1 ? 'font-medium text-foreground' : undefined}>{segment}</span>
        </Fragment>
      ))}
    </span>
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function GroupForm({ task, groups, onCancel, onCreate, onMove, onDelete }: GroupDialogProps & { task: GroupDialogTask }) {
  const editing = task.kind === 'edit' ? task : null
  const [name, setName] = useState(editing ? groupName(editing.group) : '')
  const [parent, setParent] = useState(editing ? parentGroup(editing.group) : task.kind === 'create' ? task.parent : '')
  // Said only once the form has been submitted: an empty box in a dialog that
  // has just opened is not a mistake yet.
  const [attempted, setAttempted] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // A group cannot go inside itself, or inside anything it contains.
  const parents = editing ? groups.filter(candidate => !isWithinGroup(candidate, editing.group)) : groups

  const trimmed = name.trim()
  const destination = joinGroupPath(parent, trimmed)
  const exists = groups.includes(destination) && destination !== editing?.group

  const problem = !trimmed
    ? 'Give the group a name.'
    : trimmed.includes(GROUP_SEPARATOR)
      ? `A name cannot contain "${GROUP_SEPARATOR}". To put the group inside another, pick that one under Inside.`
      : !editing && exists
        ? `There is already a group called ${trimmed} ${parent ? `in ${groupLabel(parent)}` : 'at the top level'}.`
        : null
  const shownProblem = attempted || trimmed ? problem : null

  // What deleting the group would move, and where to.
  const contents = editing
    ? [editing.targets > 0 && plural(editing.targets, 'target'), editing.groups > 0 && plural(editing.groups, 'group')]
        .filter((part): part is string => !!part)
        .join(' and ')
    : ''
  const upTo = editing && parentGroup(editing.group)

  return (
    <form
      className="space-y-4 pt-2"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        if (problem) {
          setAttempted(true)
          document.getElementById('group-name')?.focus()
          return
        }
        if (!editing) onCreate(destination)
        else if (destination !== editing.group) onMove(editing.group, destination)
        else onCancel()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="group-name" className="text-sm font-medium text-card-foreground">Name</Label>
        <Input
          id="group-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={editing ? undefined : 'e.g. Network'}
          maxLength={60}
          aria-invalid={!!shownProblem}
          aria-describedby={shownProblem ? 'group-name-error' : undefined}
          className="bg-input border-border text-foreground"
          autoFocus
        />
        {shownProblem && <p id="group-name-error" className="text-xs text-destructive">{shownProblem}</p>}
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
        {/* Where that puts it, drawn rather than described: the answer to
            "did I nest it the way I meant to" before anything is saved. */}
        {trimmed && !problem && parent && (
          <p className="text-xs text-muted-foreground">
            {editing && destination === editing.group ? 'It is at ' : 'That puts it at '}
            <GroupPath path={destination} />
          </p>
        )}
      </div>

      {editing && exists && !problem && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {groupLabel(destination)} already exists. Saving puts everything from this group into it.
        </p>
      )}

      {editing && confirmingDelete && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="alert">
          Only the group is deleted. Its {contents} {editing.targets + editing.groups === 1 ? 'moves' : 'move'}{' '}
          {upTo ? <>up into {groupLabel(upTo)}</> : 'out to the top level'}, with all of their history. Press
          Delete again to go ahead.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        {editing && (
          <Button
            type="button"
            variant="outline"
            className="mr-auto text-destructive hover:text-destructive"
            onClick={() => {
              // An empty group goes at once: there is nothing to be warned about.
              if (contents && !confirmingDelete) setConfirmingDelete(true)
              else onDelete(editing.group)
            }}
          >
            {confirmingDelete ? 'Delete' : 'Delete group'}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        {/* Left enabled while something is wrong: pressing it says what. */}
        <Button type="submit" aria-disabled={!!problem}>{editing ? 'Save' : 'Create group'}</Button>
      </div>
    </form>
  )
}
