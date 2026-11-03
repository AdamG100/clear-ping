'use client'

import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { targetTypeFor } from '@/lib/probes/host'
import type { Target } from '@/types/probe'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import { cn } from '@/lib/utils'
import { PANE, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import { PAGE_CARD } from '../settings/mcp-setup'
import { BLANK_TARGET, formValuesOf, TargetForm } from './target-dialogs'
import { agentIdOf } from '@/lib/targets/probes'

/**
 * Adding, duplicating and editing a target, each a page of its own in the
 * main pane, like Alerts and Settings. The form is long, and a panel sliding
 * in from the edge of the screen, or a dialog over the page, was a small
 * place to fill it in. It has an address, so it can be reloaded, bookmarked
 * and left with the browser's back button.
 */

type NewTarget = Omit<Target, 'id' | 'isOnline' | 'lastCheck' | 'avgLatency' | 'packetLoss'>

/**
 * A form's page: a way back, what it is for, and the form in a card. Shared
 * with the alert editor. `wide` takes the full width of the pane, for a form
 * that lays itself out in columns when there is room.
 */
export function PageFrame({ title, description, onBack, wide = false, children }: { title: string; description?: string; onBack: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn(PANE, !wide && 'max-w-3xl')}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Back
          </Button>
          <h1 className={`${PANE_TITLE} mt-2`}>{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
      </header>
      <div className={PAGE_CARD}>{children}</div>
    </div>
  )
}

interface AddTargetPageProps {
  availableGroups: string[]
  /** The group a blank form starts in, when it was opened from inside one. */
  group?: string
  /** The target being duplicated, when it was opened to copy one. */
  template?: Target | null
  onAddTarget: (target: NewTarget) => void
  onClose: () => void
  probeAgents?: ProbeAgentSummary[]
  localProbeName?: string
}

/**
 * Only the address is needed. A copy starts from the same settings, and none
 * of the history is copied.
 */
export function AddTargetPage({ availableGroups, group = '', template = null, onAddTarget, onClose, probeAgents, localProbeName }: AddTargetPageProps) {
  return (
    <PageFrame
      title={template ? `Duplicate ${template.name}` : 'Add a monitor'}
      description={
        template
          ? 'A new monitor that starts with the same settings. Change what is different about this one. None of the history is copied.'
          : 'Only the address is needed. Everything else starts with a sensible default.'
      }
      onBack={onClose}
      wide
    >
      <TargetForm
        idPrefix="add"
        initial={template ? { ...formValuesOf(template), name: `${template.name} copy` } : { ...BLANK_TARGET, group }}
        availableGroups={availableGroups}
        probeAgents={probeAgents}
        localProbeName={localProbeName}
        submitLabel="Add monitor"
        onCancel={onClose}
        onSubmit={values =>
          onAddTarget({
            ...values,
            probes: values.probes.map((id, position) => ({ id, position })),
            probeAgentId: agentIdOf(values.probes[0]),
            group: values.group || undefined,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
            type: targetTypeFor(values.host, values.probeType),
          })
        }
      />
    </PageFrame>
  )
}

interface EditTargetPageProps {
  /** Null once the targets have loaded and there is none by this id. */
  target: Target | null
  availableGroups: string[]
  onSave: (id: string, updates: Partial<Target>) => void
  onClose: () => void
  probeAgents?: ProbeAgentSummary[]
  localProbeName?: string
}

export function EditTargetPage({ target, availableGroups, onSave, onClose, probeAgents, localProbeName }: EditTargetPageProps) {
  if (!target) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          title="That monitor is not here"
          description="It may have been deleted. Pick another from the sidebar."
          action={<Button type="button" onClick={onClose}>Back to the dashboard</Button>}
        />
      </div>
    )
  }

  return (
    <PageFrame title={`Edit ${target.name}`} onBack={onClose} wide>
      <TargetForm
        key={target.id}
        idPrefix="edit"
        initial={formValuesOf(target)}
        availableGroups={availableGroups}
        probeAgents={probeAgents}
        localProbeName={localProbeName}
        submitLabel="Save changes"
        onCancel={onClose}
        // The group is sent even when empty: that is how choosing "None" takes
        // the target out of its group.
        onSubmit={values => onSave(target.id, { ...values, probes: values.probes.map((id, position) => ({ id, position })), probeAgentId: agentIdOf(values.probes[0]), updatedAt: new Date() })}
      />
    </PageFrame>
  )
}
