'use client'

import SegmentedControl from '@/components/arc/segmented-control/segmented-control'

/**
 * Arc's segmented control as a field in a form: its name shown above it, as
 * every other field's is. The control on its own only says its name to a
 * screen reader, and as an inline element it sat beside whatever came next.
 */
export function SegmentedField({
  label,
  value,
  onValueChange,
  options,
  disabled = false,
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
  /** Shown as it is, and not to be changed: a fieldset disables every button inside it. */
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-card-foreground" aria-hidden="true">{label}</p>
      <fieldset disabled={disabled} className="flex max-w-full disabled:opacity-60">
        <SegmentedControl label={label} value={value} onValueChange={onValueChange} options={options} />
      </fieldset>
    </div>
  )
}
