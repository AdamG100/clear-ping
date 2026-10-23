import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { getPacketLossVar, isMeaningfulLoss, NO_DATA_COLOR, NO_REPLY_COLOR } from '@/lib/charts/packet-loss-colors'

/**
 * Status dot: online (coloured by packet loss), offline, awaiting its first
 * measurement, or paused.
 *
 * `isOnline` is `undefined` — not `false` — when nothing has been measured yet.
 * Collapsing those two cases showed a brand new target as though it were down.
 *
 * A paused target is grey whatever its last reading was. That reading is from
 * before it was paused, and a green or red light would be a claim about now.
 */
export function StatusIndicator({
  isOnline,
  packetLoss,
  note,
  paused = false,
  onHold,
  bare = false,
}: {
  isOnline?: boolean
  packetLoss?: number
  /** Replaces the description: how each address family of a dual-stack target is doing. */
  note?: string
  paused?: boolean
  /**
   * Why no readings are being taken although the target is not paused: its
   * probe agent cannot be reached. Grey, as paused is, with this as its
   * description: the last reading says nothing about now.
   */
  onHold?: string
  /** No tooltip of its own, for where what it sits on already says the same. */
  bare?: boolean
}) {
  const pending = isOnline === undefined

  let statusColor: string
  let label: string

  if (paused) {
    statusColor = NO_DATA_COLOR
    label = 'Paused'
  } else if (onHold) {
    statusColor = NO_DATA_COLOR
    label = onHold
  } else if (pending) {
    statusColor = NO_DATA_COLOR
    label = 'Waiting for first measurement'
  } else if (isOnline) {
    statusColor = getPacketLossVar(packetLoss ?? 0)
    label = isMeaningfulLoss(packetLoss)
      ? `Online (${packetLoss!.toFixed(1)}% packet loss)`
      : 'Online'
  } else {
    statusColor = NO_REPLY_COLOR
    label = 'Offline'
  }

  if (note && !pending && !paused && !onHold) label = note

  const dot = (
    <span className="relative inline-flex shrink-0">
      {/* The pulse only runs for a live target; a steady dot for offline and
          pending states stops a dead target from looking like active traffic. */}
      {isOnline && !paused && !onHold && (
        <span
          className="absolute inline-flex h-2.5 w-2.5 rounded-full custom-ping"
          style={{ backgroundColor: statusColor }}
          aria-hidden="true"
        />
      )}
      <span
        className="relative inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: statusColor }}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  )

  // Bare where something around it already says what it means.
  return bare ? dot : <Tooltip content={label}>{dot}</Tooltip>
}
