'use client'

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { UpgradeRecord } from '@/lib/db/upgrade-progress'
import { inDisplayZone } from '@/lib/time-zone'

const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} seconds` : `${Math.round(ms / 60_000)} minutes`)

/**
 * The upgrades the database has had: when each was, from which version to
 * which, and what it did. Shown so that after updating ClearPing you can see
 * that its database was brought up to date, and how.
 */
export function UpgradeHistory({ sectionTitle, hint }: { sectionTitle: string; hint: string }) {
  const [state, setState] = useState<{ schemaVersion: number; upgrades: UpgradeRecord[] } | null>(null)

  useEffect(() => {
    let current = true
    fetch('/api/upgrade/history')
      .then(response => (response.ok ? response.json() : null))
      .then(data => { if (current && data) setState(data) })
      .catch(() => {})
    return () => { current = false }
  }, [])

  if (!state) return null

  return (
    <section className="space-y-3">
      <div className="min-w-0 space-y-1">
        <h3 className={sectionTitle}>Database upgrades</h3>
        <p className={hint}>
          The database is at version {state.schemaVersion}, the newest this version of ClearPing knows. When an update needs it
          changed, that is done once as it starts, and listed here.
        </p>
      </div>
      {state.upgrades.length === 0 ? (
        <p className={hint}>No upgrades recorded yet: this database was made by a version that keeps no such record, or has needed none since.</p>
      ) : (
        <ul className="space-y-3">
          {state.upgrades.map(upgrade => (
            <li key={upgrade.at} className="space-y-1.5 rounded-2xl border border-border bg-card p-3 text-sm">
              <p className="text-foreground">
                {new Date(upgrade.at).toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' }))}
                {upgrade.from !== undefined && upgrade.to !== undefined && upgrade.from < upgrade.to ? `: version ${upgrade.from} to ${upgrade.to}` : ''}
                <span className="text-muted-foreground">, took {took(upgrade.tookMs)}</span>
              </p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {upgrade.steps.map((step, index) => (
                  <li key={index} className="flex items-start gap-1.5">
                    <Check size={12} strokeWidth={2} className="mt-0.5 shrink-0 text-success" aria-hidden />
                    <span>{step.label}{step.detail ? `: ${step.detail}` : ''}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
