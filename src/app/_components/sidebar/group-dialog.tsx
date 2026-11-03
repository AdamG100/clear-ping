'use client'

import { Fragment, useState } from 'react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { Input } from '@/components/arc/input/input'
import { Select } from '@/components/arc/select/select'
import { ProbeChecklist, probeSummaries } from '../targets/probe-checklist'
import { GroupResolvers } from './group-resolvers'
import type { ResolverProbeChange } from '@/lib/targets/resolver-probes'
import type { Target } from '@/types/probe'
import {
  GROUP_SEPARATOR,
  groupLabel,
  groupName,
  isWithinGroup,
  joinGroupPath,
  parentGroup,
  splitGroupPath,
} from '@/lib/targets/group-path'
import { LOCAL_PROBE, type ProbeAgentSummary, type ProbeId } from '@/types/probe-agent'
import { ChevronRight } from 'lucide-react'

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
  /** Where a target can be measured from, besides the local probe. */
  probeAgents?: ProbeAgentSummary[]
  /** What the local probe is called. */
  localProbeName?: string
  /**
   * The probes each target in the group being edited is measured from, groups
   * inside it included. Empty when nothing in it is a target.
   */
  memberProbes?: ProbeId[][]
  /** The monitors in the group being edited, groups inside it included: for which probes ask their resolvers. */
  memberTargets?: Target[]
  /** Change which probes ask which resolvers across the group. Resolves to whether that happened. */
  onSetResolvers?: (group: string, changes: ResolverProbeChange[]) => Promise<boolean>
  onCancel: () => void
  onCreate: (group: string) => void
  onMove: (from: string, to: string) => void
  onDelete: (group: string) => void
  /** Add and take off probes across the group, leaving each monitor's others. Resolves to whether that happened. */
  onSetProbe?: (group: string, change: { add: ProbeId[]; remove: ProbeId[] }) => Promise<boolean>
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
            ? 'Somewhere to keep monitors that belong together. It can sit inside another group, and start out empty.'
            : 'Rename the group or move it inside another. Its monitors and any groups inside it move too.'
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
  localProbeName,
  memberProbes = [],
  memberTargets = [],
  onSetResolvers,
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
  const [resolverChanges, setResolverChanges] = useState<ResolverProbeChange[]>([])

  // Each probe is ticked (every monitor here has it), unticked (none has it)
  // or part-ticked (only some have it). Saving gives a ticked probe to every
  // monitor and takes an unticked one off every monitor; one left part-ticked
  // stays on just the monitors that have it. Nothing changes until a box is
  // touched, and each monitor keeps its other probes, primary first.
  const everyProbe = [...new Set(memberProbes.flat())]
  const shared = everyProbe.filter(id => memberProbes.every(list => list.includes(id)))
  const someHave = everyProbe.filter(id => !shared.includes(id))
  const [ticked, setTicked] = useState<ProbeId[]>(shared)
  const [partial, setPartial] = useState<ProbeId[]>(someHave)
  const add = ticked.filter(id => !shared.includes(id))
  const remove = everyProbe.filter(id => !ticked.includes(id) && !partial.includes(id))
  const touched = add.length > 0 || remove.length > 0
  // A monitor left with no probe at all: nothing ticked, and every probe it has unticked.
  const leftWithout = ticked.length > 0 ? 0 : memberProbes.filter(list => list.every(id => remove.includes(id))).length
  const showProbe = !!editing && memberProbes.length > 0 && (probeAgents.length > 0 || everyProbe.some(id => id !== LOCAL_PROBE))
  const summaries = probeSummaries(probeAgents, localProbeName)
  // A probe the targets have but that is no longer listed (a removed probe agent).
  for (const id of everyProbe) {
    if (!summaries.some(probe => probe.id === id)) summaries.push({ id, name: 'A removed probe agent', local: false, state: 'offline' })
  }

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
    ? [editing.targets > 0 && plural(editing.targets, 'monitor'), editing.groups > 0 && plural(editing.groups, 'group')]
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
        if (touched && editing && onSetProbe) {
          if (leftWithout > 0) return
          setSavingProbe(true)
          const switched = await onSetProbe(editing.group, { add, remove })
          setSavingProbe(false)
          if (!switched) return
        }
        if (resolverChanges.length > 0 && editing && onSetResolvers) {
          setSavingProbe(true)
          const changed = await onSetResolvers(editing.group, resolverChanges)
          setSavingProbe(false)
          if (!changed) return
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
          <p className="text-sm font-medium text-foreground">Probes</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            For the {plural(memberProbes.length, 'monitor')} in this group, and in groups inside it. Tick a probe to measure
            every one of them from it, untick it to stop. {someHave.length > 0 ? 'Part-ticked is a probe only some of them have; left that way, it stays on just those. ' : ''}
            Each monitor keeps its other probes, and readings already taken stay in its history.
          </p>
          <ProbeChecklist
            idPrefix="group-probes"
            probes={summaries}
            value={ticked}
            partial={partial}
            showPrimary={false}
            allowNone
            onChange={next => {
              // A part-ticked probe that is clicked is decided: ticked now, and unticked if clicked again.
              setPartial(current => current.filter(id => !next.includes(id)))
              setTicked(next)
            }}
          />
          {leftWithout > 0 && (
            <p className="text-xs text-destructive">
              {plural(leftWithout, 'monitor')} would be left with no probe. Keep at least one of {leftWithout === 1 ? 'its' : 'their'} probes ticked.
            </p>
          )}
          {touched && (
            <Button type="button" size="sm" variant="ghost" onClick={() => { setTicked(shared); setPartial(someHave) }}>
              Leave the probes as they are
            </Button>
          )}
        </div>
      )}

      {showProbe && editing && onSetResolvers && (
        <GroupResolvers targets={memberTargets} probes={summaries} changes={resolverChanges} onChange={setResolverChanges} />
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
