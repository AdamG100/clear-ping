'use client'

import { CopyButton } from '@/components/arc/copy-button/copy-button'
import { Tooltip } from '@/components/arc/tooltip/tooltip'

/**
 * A button beside an address that copies it: a domain or IP is usually wanted
 * somewhere else (a terminal, a ticket, a firewall rule), and selecting a
 * long IPv6 address by hand tends to miss a few characters at one end.
 */
export function CopyAddress({ value }: { value: string }) {
  return (
    <Tooltip content={`Copy ${value}`}>
      {/* Held into the line of text it sits in: Arc's button is a control's
          full height, and set in the line it pushed the line apart. */}
      <span className="-my-1.5 inline-flex shrink-0">
        <CopyButton value={value} label={`Copy ${value}`} iconOnly variant="plain" />
      </span>
    </Tooltip>
  )
}
