import type { ReactNode } from 'react'
import { getPacketLossLabel, getPacketLossVar, isMeaningfulLoss } from '@/lib/charts/packet-loss-colors'
import { cn } from '@/lib/utils'

/**
 * A share lost, the way every table and card shows one: the figure in the
 * text colour, beside a dot in its band's colour. Below the noise floor it
 * has no dot and is muted: a reading, not a problem.
 *
 * `children` replaces the figure where it is said another way ("3 of 4",
 * "no reply"); `loss` still decides the colour.
 */
export function LossFigure({ loss, children, className }: { loss: number; children?: ReactNode; className?: string }) {
  const marked = isMeaningfulLoss(loss)
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono', marked ? 'text-foreground' : 'text-muted-foreground', className)}>
      {marked && (
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: getPacketLossVar(loss) }} aria-hidden="true" />
      )}
      {children ?? `${loss.toFixed(loss > 0 && loss < 10 ? 1 : 0)}%`}
      {marked && <span className="sr-only"> ({getPacketLossLabel(loss)} loss)</span>}
    </span>
  )
}
