'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Scale } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { useToast } from '@/components/notifications'
import { knownProbeIdsOf } from '@/lib/targets/probes'
import type { Comparison, ComparisonLine } from '@/types/comparison'
import type { GroupOrder, Target, TimeRange } from '@/types/probe'
import type { ProbeAgentSummary, ProbeId } from '@/types/probe-agent'
import { ComparePanel } from '../charts/compare-panel'
import { TimeRangeSelector } from '../charts/time-range-selector'
import { PANE, PANE_ACTIONS, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import { Masked } from '../privacy/masked'
import { TargetChecklist } from '../sidebar/target-checklist'
import { ProbeChecklist, probeSummaries } from '../targets/probe-checklist'
import { PageFrame } from '../targets/target-page'
import type { DashboardPage } from '@/lib/dashboard-pages'

type ComparePage = Extract<DashboardPage, { kind: 'compare' | 'compare-new' | 'compare-view' | 'compare-edit' }>

interface ComparisonsPageProps {
  page: ComparePage
  targets: Target[]
  groupOrders: GroupOrder[]
  probeAgents: ProbeAgentSummary[]
  localProbeName?: string
  readOnly?: boolean
  onOpenPage: (page: DashboardPage) => void
  onSelectTarget: (id: string) => void
  reportError: (title: string, error?: unknown) => void
}

/** The line a probe draws, as `/api/compare?series=` takes it. */
const lineKey = (line: ComparisonLine) => `${line.targetId}:${line.probe}`

function useComparisons(reportError: (title: string, error?: unknown) => void) {
  const [comparisons, setComparisons] = useState<Comparison[] | null>(null)
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/comparisons')
      if (!response.ok) return reportError('Could not load the comparisons', `Server responded ${response.status}`)
      setComparisons((await response.json()).comparisons ?? [])
    } catch (error) {
      reportError('Could not load the comparisons', error)
    }
  }, [reportError])
  useEffect(() => {
    // Loaded when the page opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  return { comparisons, reload: load }
}

/**
 * Saved comparisons: monitors from any group, each from the probes chosen for
 * it, drawn on one chart and kept under a name. They are pages of their own, so
 * saving one adds nothing to the sidebar's list.
 */
export function ComparisonsPage(props: ComparisonsPageProps) {
  const { page } = props
  if (page.kind === 'compare') return <ComparisonList {...props} />
  if (page.kind === 'compare-view') return <ComparisonView {...props} id={page.id} />
  return <ComparisonBuilder {...props} editing={page.kind === 'compare-edit' ? page.id : null} seed={page.kind === 'compare-new' ? page.targets : undefined} />
}

function ComparisonList({ targets, readOnly, onOpenPage, reportError }: ComparisonsPageProps) {
  const { comparisons } = useComparisons(reportError)
  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Comparisons</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Monitors from any group, from the probes you choose, drawn on one chart and saved under a name.
          </p>
        </div>
        {!readOnly && (
          <div className={PANE_ACTIONS}>
            <Button size="sm" onClick={() => onOpenPage({ kind: 'compare-new' })} disabled={targets.length < 2}>
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              New comparison
            </Button>
          </div>
        )}
      </header>
      {comparisons === null ? (
        <Skeleton label="Loading the comparisons" lines={3} />
      ) : comparisons.length === 0 ? (
        <EmptyState
          icon={<Scale size={24} strokeWidth={1.75} />}
          title="No saved comparisons"
          description={targets.length < 2 ? 'Add a second monitor to compare it with the first.' : 'Pick monitors and the probes to compare them from, and keep the chart under a name.'}
        />
      ) : (
        <ul className="space-y-2">
          {comparisons.map(comparison => (
            <li key={comparison.id}>
              <button
                type="button"
                onClick={() => onOpenPage({ kind: 'compare-view', id: comparison.id })}
                className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-left hover:border-border-strong"
              >
                <span className="min-w-0 truncate text-sm font-medium text-foreground"><Masked text value={comparison.name} /></span>
                <span className="text-xs text-muted-foreground">{comparison.lines.length} lines</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ComparisonView({ id, targets, probeAgents, localProbeName, readOnly, onOpenPage, onSelectTarget, reportError }: ComparisonsPageProps & { id: string }) {
  const { notify } = useToast()
  const [comparison, setComparison] = useState<Comparison | null | undefined>(undefined)
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null)

  useEffect(() => {
    let current = true
    fetch(`/api/comparisons/${id}`)
      .then(response => (response.ok ? response.json() : null))
      .catch(() => null)
      .then(found => { if (current) setComparison(found) })
    return () => { current = false }
  }, [id])

  const probeNames = useMemo(() => new Map(probeSummaries(probeAgents, localProbeName).map(probe => [probe.id, probe.name])), [probeAgents, localProbeName])
  const byId = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets])
  const drawn = comparison?.lines.filter(line => byId.has(line.targetId)) ?? []
  const monitors = [...new Set(drawn.map(line => line.targetId))].map(each => byId.get(each)!)

  const remove = async () => {
    const response = await fetch(`/api/comparisons/${id}`, { method: 'DELETE' })
    if (!response.ok) {
      reportError('Could not delete the comparison', `Server responded ${response.status}`)
      throw new Error('Not deleted')
    }
    notify({ tone: 'info', title: 'Comparison deleted', detail: 'The monitors in it are untouched.' })
    onOpenPage({ kind: 'compare' })
  }

  if (comparison === undefined) return <div className={PANE}><Skeleton label="Loading the comparison" lines={3} /></div>
  if (comparison === null) {
    return (
      <PageFrame title="Comparison not found" onBack={() => onOpenPage({ kind: 'compare' })}>
        <EmptyState icon={<Scale size={24} strokeWidth={1.75} />} title="It may have been deleted" description="Go back to the list of saved comparisons." />
      </PageFrame>
    )
  }

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenPage({ kind: 'compare' })}>All comparisons</Button>
          <h1 className={`${PANE_TITLE} mt-2`}><Masked text value={comparison.name} /></h1>
          <p className="mt-1 text-sm text-muted-foreground">{drawn.length} lines from {monitors.length} monitors</p>
        </div>
        <div className={PANE_ACTIONS}>
          <TimeRangeSelector value={timeRange} onChange={range => { setTimeRange(range); setZoom(null) }} />
          {!readOnly && (
            <>
              <Button variant="secondary" size="sm" onClick={() => onOpenPage({ kind: 'compare-edit', id })}>Edit</Button>
              <ConfirmMorph label="Delete" prompt="Delete this comparison?" confirmLabel="Delete" doneLabel="Deleted" onConfirm={remove} />
            </>
          )}
        </div>
      </header>
      <ComparePanel
        targets={monitors}
        timeRange={timeRange}
        zoom={zoom}
        onZoom={(start, end) => setZoom({ start, end })}
        onResetZoom={() => setZoom(null)}
        title="Compared"
        description="Each line is a monitor as one probe measures it, on a shared scale. The strips underneath mark when each one lost packets or failed."
        drawn={drawn.map(lineKey).join(',')}
        probeNames={probeNames}
        showAddress={false}
        onSelectTarget={onSelectTarget}
        reportError={reportError}
      />
    </div>
  )
}

function ComparisonBuilder({
  editing, seed, targets, groupOrders, probeAgents, localProbeName, onOpenPage, reportError,
}: ComparisonsPageProps & { editing: string | null; seed?: string[] }) {
  const { notify } = useToast()
  const [saved, setSaved] = useState<Comparison | null | undefined>(editing ? undefined : null)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(seed ?? []))
  const [probes, setProbes] = useState<ProbeId[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [attempted, setAttempted] = useState(false)

  useEffect(() => {
    if (!editing) return
    let current = true
    fetch(`/api/comparisons/${editing}`)
      .then(response => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((found: Comparison | null) => {
        if (!current) return
        setSaved(found)
        if (found) {
          setName(found.name)
          setSelected(new Set(found.lines.map(line => line.targetId)))
          setProbes([...new Set(found.lines.map(line => line.probe))])
        }
      })
    return () => { current = false }
  }, [editing])

  const summaries = useMemo(() => probeSummaries(probeAgents, localProbeName), [probeAgents, localProbeName])
  const chosen = useMemo(() => targets.filter(target => selected.has(target.id)), [targets, selected])
  // Until probes are chosen, every probe the chosen monitors have is drawn.
  const ticked = probes ?? [...new Set(chosen.flatMap(target => knownProbeIdsOf(target)))]
  // The lines: each chosen monitor from each ticked probe that measures it.
  const lines: ComparisonLine[] = chosen.flatMap(target =>
    knownProbeIdsOf(target).filter(probe => ticked.includes(probe)).map(probe => ({ targetId: target.id, probe }))
  )
  const problem = !name.trim() ? 'Give the comparison a name.' : lines.length < 2 ? 'Pick monitors and probes for at least two lines.' : null

  const save = async () => {
    setAttempted(true)
    if (problem) return
    setSaving(true)
    try {
      const response = await fetch(editing ? `/api/comparisons/${editing}` : '/api/comparisons', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), lines }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) return reportError('Could not save the comparison', String(body.error ?? `Server responded ${response.status}`))
      notify({ tone: 'success', title: editing ? 'Comparison saved' : 'Comparison created' })
      onOpenPage({ kind: 'compare-view', id: body.id })
    } catch (error) {
      reportError('Could not save the comparison', error)
    } finally {
      setSaving(false)
    }
  }

  if (saved === undefined) return <div className={PANE}><Skeleton label="Loading the comparison" lines={3} /></div>

  return (
    <PageFrame
      title={editing ? 'Edit comparison' : 'New comparison'}
      description="Monitors from any group, each from the probes you tick, on one chart."
      onBack={() => onOpenPage(editing ? { kind: 'compare-view', id: editing } : { kind: 'compare' })}
    >
      <form className="space-y-5 text-foreground" noValidate onSubmit={event => { event.preventDefault(); void save() }}>
        <Input label="Name" required value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="e.g. Work and home to the game servers" error={attempted && !name.trim() ? 'Give the comparison a name.' : undefined} />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Monitors</legend>
          <TargetChecklist targets={targets} groupOrders={groupOrders} selected={selected} onChange={setSelected} searchable maxHeight="20rem" />
        </fieldset>
        {summaries.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Probes</legend>
            <ProbeChecklist idPrefix="compare" probes={summaries} value={ticked} onChange={setProbes} />
          </fieldset>
        )}
        <p className={`text-xs ${attempted && problem ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
          {problem ?? `${lines.length} lines from ${chosen.length} monitors.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenPage(editing ? { kind: 'compare-view', id: editing } : { kind: 'compare' })}>Cancel</Button>
          <Button type="submit" loading={saving} aria-disabled={!!problem}>{editing ? 'Save' : 'Create comparison'}</Button>
        </div>
      </form>
    </PageFrame>
  )
}
