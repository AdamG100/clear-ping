'use client'

import { Fragment, useState } from 'react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { Input } from '@/components/arc/input/input'
import { Select } from '@/components/arc/select/select'
import {
  GROUP_SEPARATOR,
  groupLabel,
  groupName,
  isWithinGroup,
  joinGroupPath,
  parentGroup,
  splitGroupPath,
} from '@/lib/targets/group-path'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import { ChevronRight } from 'lucide-react'

/** The select cannot hold an empty value, so the top level needs a name. */
const TOP_LEVEL = '__top__'
/** Probed from this server, as distinct from a probe agent's id. */
const THIS_SERVER = '__server__'
/** The targets in the group are not all probed from the same place. */
const MIXED = '__mixed__'

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
  /** Where a target can be probed from, besides this server. */
  probeAgents?: ProbeAgentSummary[]
  /**
   * Where each target in the group being edited is probed from, groups inside
   * it included. Empty when nothing in it is a target. Null is this server.
   */
  memberProbes?: (string | null)[]
  onCancel: () => void
  onCreate: (group: string) => void
  onMove: (from: string, to: string) => void
  onDelete: (group: string) => void
  /** Point every target in the group at one place. Resolves to whether that happened. */
  onSetProbe?: (group: string, probeAgentId: string | null) => Promise<boolean>
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

  return (
    <Dialog open={task !== null} onOpenChange={open => { if (!open) form.onCancel() }}>
      <DialogContent
        title={creating ? 'New group' : 'Edit group'}
        description={
          creating
            ? 'Somewhere to keep targets that belong together. It can sit inside another group, and start out empty.'
            : 'Rename the group or move it inside another. Its targets and any groups inside it move too.'
        }
      >
        {/* Keyed so a different group opens with its own values. */}
        {task !== null && (
          <GroupForm key={task.kind === 'edit' ? `edit:${task.group}` : `create:${task.parent}`} task={task} {...form} />
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

function GroupForm({
  task,
  groups,
  probeAgents = [],
  memberProbes = [],
  onCancel,
  onCreate,
  onMove,
  onDelete,
  onSetProbe,
}: GroupDialogProps & { task: GroupDialogTask }) {
  const editing = task.kind === 'edit' ? task : null
  const [name, setName] = useState(editing ? groupName(editing.group) : '')
  const [parent, setParent] = useState(editing ? parentGroup(editing.group) : task.kind === 'create' ? task.parent : '')
  // Said only once the form has been submitted: an empty box in a dialog that
  // has just opened is not a mistake yet.
  const [attempted, setAttempted] = useState(false)
  const [savingProbe, setSavingProbe] = useState(false)

  // One value when every target is probed from the same place, otherwise a
  // choice that changes nothing until someone picks a place.
  const uniform = memberProbes.length > 0 && memberProbes.every(id => id === memberProbes[0])
  const initialProbe = memberProbes.length === 0 ? THIS_SERVER : uniform ? memberProbes[0] ?? THIS_SERVER : MIXED
  const [probe, setProbe] = useState(initialProbe)
  const showProbe = !!editing && memberProbes.length > 0 && (probeAgents.length > 0 || memberProbes.some(id => id))
  const probeOptions = [
    ...(initialProbe === MIXED ? [{ value: MIXED, label: 'Leave each target as it is' }] : []),
    { value: THIS_SERVER, label: 'This server' },
    ...probeAgents.map(agent => ({ value: agent.id, label: agent.name })),
    ...(uniform && memberProbes[0] && !probeAgents.some(agent => agent.id === memberProbes[0])
      ? [{ value: memberProbes[0], label: 'A removed probe agent' }]
      : []),
  ]

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
      className="space-y-4"
      noValidate
      onSubmit={async event => {
        event.preventDefault()
        if (problem || savingProbe) {
          setAttempted(true)
          document.getElementById('group-name')?.focus()
          return
        }
        // The probe is switched on the group's current path, before a rename
        // moves the targets out from under it.
        const probeChanged = !!editing && probe !== initialProbe && probe !== MIXED
        if (probeChanged && editing && onSetProbe) {
          setSavingProbe(true)
          const switched = await onSetProbe(editing.group, probe === THIS_SERVER ? null : probe)
          setSavingProbe(false)
          if (!switched) return
        }
        if (!editing) onCreate(destination)
        else if (destination !== editing.group) onMove(editing.group, destination)
        else onCancel()
      }}
    >
      <Input
        id="group-name"
        label="Name"
        required
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={editing ? undefined : 'e.g. Network'}
        maxLength={60}
        error={shownProblem ?? undefined}
        autoFocus
      />

      <div className="space-y-2">
        <Select
          label="Inside"
          value={parent || TOP_LEVEL}
          onValueChange={value => setParent(value === TOP_LEVEL ? '' : value)}
          options={[
            { value: TOP_LEVEL, label: 'Nothing (top level)' },
            ...parents.map(candidate => ({ value: candidate, label: groupLabel(candidate) })),
          ]}
        />
        {/* Where that puts it, drawn rather than described: the answer to
            "did I nest it the way I meant to" before anything is saved. */}
        {trimmed && !problem && parent && (
          <p className="text-xs text-muted-foreground">
            {editing && destination === editing.group ? 'It is at ' : 'That puts it at '}
            <GroupPath path={destination} />
          </p>
        )}
      </div>

      {showProbe && (
        <div className="space-y-2">
          <Select
            label="Probe from"
            value={probe}
            onValueChange={setProbe}
            options={probeOptions}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Switches {plural(memberProbes.length, 'target')} in this group, including any group inside it, in one go.
            Readings already taken stay where they were taken from.
          </p>
        </div>
      )}

      {editing && exists && !problem && (
        <Alert tone="info" title={`${groupLabel(destination)} already exists`}>
          Saving puts everything from this group into it.
        </Alert>
      )}

      {editing && contents && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Deleting it deletes only the group. Its {contents} {editing.targets + editing.groups === 1 ? 'moves' : 'move'}{' '}
          {upTo ? <>up into {groupLabel(upTo)}</> : 'out to the top level'}, with all of their history.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        {editing && (
          <span className="mr-auto">
            <ConfirmMorph
              label="Delete group"
              prompt="Delete the group?"
              confirmLabel="Delete"
              onConfirm={() => onDelete(editing.group)}
            />
          </span>
        )}
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        {/* Left enabled while something is wrong: pressing it says what. */}
        <Button type="submit" loading={savingProbe} aria-disabled={!!problem}>{editing ? 'Save' : 'Create group'}</Button>
      </div>
    </form>
  )
}
