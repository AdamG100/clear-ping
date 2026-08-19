'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, BellOff, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import type { AlertMetric, AlertRule } from '@/types/probe'
import { ALERT_METRIC_LABELS } from '@/types/probe'

/**
 * Alert rules for one target.
 *
 * Adding a rule used to mean filling in a four-field form every time, even
 * though nearly every rule anyone wants is one of three things. Those three are
 * one-click presets now, and the form is the exception rather than the toll
 * gate.
 */

interface AlertsPanelProps {
  targetId: string
  targetName: string
}

interface RuleResponse extends Omit<AlertRule, 'createdAt' | 'lastFiredAt' | 'lastResolvedAt'> {
  createdAt: string
  lastFiredAt: string | null
  lastResolvedAt: string | null
}

interface Preset {
  id: string
  label: string
  metric: AlertMetric
  threshold: number
  consecutiveProbes: number
}

/**
 * Thresholds match the severity bands: 5% loss is one dropped packet in a
 * 20-packet probe, and 200ms is where interactive traffic starts to suffer.
 */
const PRESETS: Preset[] = [
  { id: 'unreachable', label: 'Stops responding', metric: 'unreachable', threshold: 0, consecutiveProbes: 3 },
  { id: 'loss', label: 'Loss above 5%', metric: 'packetLoss', threshold: 5, consecutiveProbes: 3 },
  { id: 'latency', label: 'Latency above 200ms', metric: 'latency', threshold: 200, consecutiveProbes: 3 },
]

function ruleSummary(rule: RuleResponse) {
  const { label, unit } = ALERT_METRIC_LABELS[rule.metric]
  return rule.metric === 'unreachable' ? 'Stops responding' : `${label} above ${rule.threshold}${unit}`
}

export function AlertsPanel({ targetId, targetName }: AlertsPanelProps) {
  const { notify, reportError } = useToast()
  const [rules, setRules] = useState<RuleResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [showCustom, setShowCustom] = useState(false)
  const [metric, setMetric] = useState<AlertMetric>('packetLoss')
  const [threshold, setThreshold] = useState('5')
  const [consecutiveProbes, setConsecutiveProbes] = useState('3')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/targets/${targetId}/alerts`)
      if (!response.ok) {
        reportError('Could not load alerts', `Server responded ${response.status}`)
        return
      }
      const data = await response.json()
      setRules(data.rules ?? [])
    } catch (error) {
      reportError('Could not load alerts', error)
    } finally {
      setLoading(false)
    }
  }, [targetId, reportError])

  // No state reset here: the dashboard gives this component a key of the
  // target id, so switching targets remounts it with fresh state. Resetting
  // inside an effect only re-created that behaviour a render too late.
  useEffect(() => {
    // The callback is async and awaits its fetch before touching state, so
    // nothing is set synchronously here; the rule cannot see across the
    // await. Fetching on mount is the intended use of an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const create = useCallback(
    async (input: { metric: AlertMetric; threshold: number; consecutiveProbes: number; webhookUrl?: string }) => {
      const response = await fetch(`/api/targets/${targetId}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })

      if (!response.ok) {
        const { error } = await response.json().catch(() => ({ error: `Server responded ${response.status}` }))
        reportError('Could not add alert', error)
        return false
      }

      await load()
      return true
    },
    [targetId, load, reportError]
  )

  // A preset already in use is not offered again, so the row cannot fill up
  // with duplicates of the same rule.
  const availablePresets = useMemo(
    () =>
      PRESETS.filter(
        preset => !rules.some(r => r.metric === preset.metric && r.threshold === preset.threshold)
      ),
    [rules]
  )

  const addPreset = async (preset: Preset) => {
    setBusyId(preset.id)
    try {
      const ok = await create({
        metric: preset.metric,
        threshold: preset.threshold,
        consecutiveProbes: preset.consecutiveProbes,
      })
      if (ok) notify({ tone: 'success', title: `Alerting on ${targetName}`, detail: preset.label })
    } catch (error) {
      reportError('Could not add alert', error)
    } finally {
      setBusyId(null)
    }
  }

  const addCustom = async () => {
    setSaving(true)
    try {
      const ok = await create({
        metric,
        threshold: Number(threshold),
        consecutiveProbes: Number(consecutiveProbes),
        webhookUrl: webhookUrl.trim() || undefined,
      })
      if (ok) {
        notify({ tone: 'success', title: `Alerting on ${targetName}` })
        setShowCustom(false)
        setWebhookUrl('')
      }
    } catch (error) {
      reportError('Could not add alert', error)
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (rule: RuleResponse) => {
    setBusyId(rule.id)
    try {
      const response = await fetch(`/api/alerts/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      })
      if (!response.ok) reportError('Could not update alert', `Server responded ${response.status}`)
      else await load()
    } catch (error) {
      reportError('Could not update alert', error)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (rule: RuleResponse) => {
    setBusyId(rule.id)
    try {
      const response = await fetch(`/api/alerts/${rule.id}`, { method: 'DELETE' })
      if (!response.ok) reportError('Could not remove alert', `Server responded ${response.status}`)
      else await load()
    } catch (error) {
      reportError('Could not remove alert', error)
    } finally {
      setBusyId(null)
    }
  }

  const firing = rules.filter(r => r.enabled && r.state === 'firing')

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
        <h2 className="text-sm font-medium text-foreground">Alerts</h2>
        {firing.length > 0 && (
          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
            {firing.length} firing
          </span>
        )}
        <p className="text-xs text-muted-foreground">
          {rules.length === 0
            ? 'Get told when this path breaks, instead of finding out here.'
            : `Fires only after the condition holds for several probes in a row.`}
        </p>
      </div>

      <div className="px-5 pb-4 pt-3">
        {loading ? (
          <div className="h-8 w-56 animate-pulse rounded bg-muted/50" />
        ) : (
          <>
            {/* Existing rules read as compact chips, not table rows. */}
            {rules.length > 0 && (
              <ul className="mb-3 flex flex-wrap gap-2">
                <AnimatePresence initial={false}>
                  {rules.map(rule => {
                    const isFiring = rule.enabled && rule.state === 'firing'
                    return (
                      <motion.li
                        key={rule.id}
                        layout
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                        className={cn(
                          'group flex items-center gap-2 rounded-full border py-1 pl-3 pr-1.5 text-xs',
                          isFiring
                            ? 'border-destructive/50 bg-destructive/10'
                            : 'border-border bg-background',
                          !rule.enabled && 'opacity-55'
                        )}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            isFiring
                              ? 'bg-destructive'
                              : rule.enabled
                                ? 'bg-signal-perfect'
                                : 'bg-muted-foreground'
                          )}
                          aria-hidden="true"
                        />
                        <span className="text-foreground">{ruleSummary(rule)}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          ×{rule.consecutiveProbes}
                          {rule.webhookUrl ? ' · hook' : ''}
                        </span>

                        <span className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => toggle(rule)}
                            disabled={busyId === rule.id}
                            className="cursor-pointer rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                            aria-label={rule.enabled ? `Mute ${ruleSummary(rule)}` : `Unmute ${ruleSummary(rule)}`}
                          >
                            {rule.enabled ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(rule)}
                            disabled={busyId === rule.id}
                            className="cursor-pointer rounded-full p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-40"
                            aria-label={`Remove ${ruleSummary(rule)}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </span>
                      </motion.li>
                    )
                  })}
                </AnimatePresence>
              </ul>
            )}

            {/* One click covers the common cases; the form is for the rest. */}
            <div className="flex flex-wrap items-center gap-2">
              {availablePresets.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => addPreset(preset)}
                  disabled={busyId === preset.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" />
                  {preset.label}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setShowCustom(v => !v)}
                className="cursor-pointer rounded-full px-2 py-1 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                {showCustom ? 'Cancel' : 'Custom…'}
              </button>
            </div>

            <AnimatePresence initial={false}>
              {showCustom && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-background/60 p-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="alert-metric" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        When
                      </Label>
                      <Select
                        value={metric}
                        onValueChange={v => {
                          const next = v as AlertMetric
                          setMetric(next)
                          setThreshold(next === 'latency' ? '200' : next === 'jitter' ? '50' : '5')
                        }}
                      >
                        <SelectTrigger id="alert-metric" className="h-8 w-40 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(ALERT_METRIC_LABELS) as AlertMetric[]).map(m => (
                            <SelectItem key={m} value={m}>
                              {ALERT_METRIC_LABELS[m].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {metric !== 'unreachable' && (
                      <div className="space-y-1.5">
                        <Label htmlFor="alert-threshold" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Above ({ALERT_METRIC_LABELS[metric].unit})
                        </Label>
                        <Input
                          id="alert-threshold"
                          type="number"
                          min={0}
                          value={threshold}
                          onChange={e => setThreshold(e.target.value)}
                          className="h-8 w-24 text-xs"
                        />
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="alert-consecutive" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        For (probes)
                      </Label>
                      <Input
                        id="alert-consecutive"
                        type="number"
                        min={1}
                        max={100}
                        value={consecutiveProbes}
                        onChange={e => setConsecutiveProbes(e.target.value)}
                        className="h-8 w-20 text-xs"
                      />
                    </div>

                    <div className="min-w-48 flex-1 space-y-1.5">
                      <Label htmlFor="alert-webhook" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Webhook (optional)
                      </Label>
                      <Input
                        id="alert-webhook"
                        placeholder="https://hooks.example.com/…"
                        value={webhookUrl}
                        onChange={e => setWebhookUrl(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>

                    <Button onClick={addCustom} disabled={saving} size="sm" className="h-8">
                      {saving ? 'Adding…' : 'Add alert'}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setShowCustom(false)}
                      className="cursor-pointer rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="Close custom alert form"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </section>
  )
}
