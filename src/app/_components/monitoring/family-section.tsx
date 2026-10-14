'use client'

import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { ExpandableCard } from '@/components/arc/expandable-card/expandable-card'
import { cn } from '@/lib/utils'
import { FAMILY_LABEL } from '@/lib/host'
import { resolversThatDiffer } from '@/lib/dns-resolver-series'
import type { AddressFamily, FamilyReading } from '@/types/probe'

/**
 * One address family's part of a page that compares the two.
 *
 * A DNS target on both families has a table and a chart for each of them, and
 * laid end to end under the comparison they were four boxes with nothing to
 * say which went with which. Here each family is one box with its name on it,
 * folded away until it is wanted: the heading says how that family's latest
 * probe went, which is often all that was being looked for.
 */

/** Where it is remembered which families were left open. */
const OPEN_FAMILIES_KEY = 'openFamilySections'

function readOpenFamilies(): AddressFamily[] {
  if (typeof window === 'undefined') return []
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(OPEN_FAMILIES_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((family): family is AddressFamily => family === 4 || family === 6) : []
  } catch {
    return []
  }
}

function saveOpen(family: AddressFamily, open: boolean) {
  try {
    const others = readOpenFamilies().filter(each => each !== family)
    localStorage.setItem(OPEN_FAMILIES_KEY, JSON.stringify(open ? [...others, family] : others))
  } catch {
    // Not remembered for next time; it still changes now.
  }
}

/** How a family's latest probe went, in the few words there is room for beside its name. */
function summaryOf(latest: FamilyReading | undefined) {
  if (!latest) return null

  const readings = latest.details?.resolvers ?? []
  // Out of how many, where every reading kept that; as a share where one did not.
  const counted = readings.length > 0 && readings.every(reading => reading.sent)
  const sent = readings.reduce((sum, reading) => sum + (reading.sent ?? 0), 0)
  const answered = readings.reduce((sum, reading) => sum + Math.round((reading.sent ?? 0) * (1 - reading.loss / 100)), 0)

  return {
    latency: latest.latency,
    answered: counted ? `${answered} of ${sent} queries answered` : `${(100 - latest.packetLoss).toFixed(0)}% of queries answered`,
    silent: readings.filter(reading => reading.latency === null).length,
    differing: resolversThatDiffer(readings).size > 0,
    // The family's state at a glance, in the colours the target list uses.
    tone: !latest.success ? 'bg-destructive' : latest.packetLoss > 0 ? 'bg-signal-moderate' : 'bg-signal-perfect',
  }
}

interface FamilySectionProps {
  family: AddressFamily
  /** What is looked up over this family: "A record". */
  detail?: string
  latest: FamilyReading | undefined
  children: ReactNode
}

/** The state of a family in one line, as the card's summary: the worst news first. */
function describe(summary: ReturnType<typeof summaryOf>): string {
  if (!summary) return 'No reading yet'
  return [
    summary.latency === null ? 'No answer' : `${summary.latency.toFixed(1)} ms`,
    summary.answered,
    summary.silent > 0 && `${summary.silent} resolver${summary.silent === 1 ? '' : 's'} not answering`,
    summary.differing && 'answers differ',
  ]
    .filter(Boolean)
    .join(' · ')
}

export function FamilySection({ family, detail, latest, children }: FamilySectionProps) {
  const summary = summaryOf(latest)
  // Read once, from what was left last time.
  const [startOpen] = useState(() => readOpenFamilies().includes(family))

  // The card opens and folds itself; this only remembers which way it was left.
  const remember = (event: MouseEvent<HTMLElement>) => {
    const trigger = (event.target as HTMLElement).closest('button[aria-expanded]')
    if (!trigger || trigger.parentElement !== event.currentTarget) return
    saveOpen(family, trigger.getAttribute('aria-expanded') !== 'true')
  }

  return (
    <ExpandableCard
      title={detail ? `${FAMILY_LABEL[family]}: ${detail}` : FAMILY_LABEL[family]}
      description={describe(summary)}
      leading={<span className={cn('size-2.5 shrink-0 rounded-full', summary?.tone ?? 'bg-muted-foreground/40')} aria-hidden="true" />}
      defaultExpanded={startOpen}
      onClickCapture={remember}
    >
      <div className="space-y-3 border-t border-border p-3 @2xl/main:space-y-4 @2xl/main:p-4">{children}</div>
    </ExpandableCard>
  )
}
