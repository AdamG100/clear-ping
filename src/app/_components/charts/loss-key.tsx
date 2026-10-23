import { PACKET_LOSS_BANDS } from '@/lib/charts/packet-loss-colors'

/**
 * What the loss colours mean: a swatch and the range of each band, as items
 * for the caller's own row of key entries. `withClear` false leaves out the
 * band below the noise floor, for a chart that does not draw it.
 */
export function LossKey({ withClear = true }: { withClear?: boolean }) {
  return (
    <>
      {PACKET_LOSS_BANDS.slice(withClear ? 0 : 1).map(band => (
        <span key={band.label} className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm" style={{ backgroundColor: band.cssVar }} aria-hidden="true" />
          <span className="text-muted-foreground">
            {band.label} <span className="font-mono">{band.range}</span>
          </span>
        </span>
      ))}
    </>
  )
}
