'use client'

import { useMask } from './use-privacy'

/**
 * An address, or text that may hold one (a target named by its IP address,
 * a probe's label), hidden while Settings → Privacy or this browser hides
 * addresses. `text` for the second: an address inside it is found and hidden,
 * and the rest left alone.
 */
export function Masked({ value, text = false }: { value: string; text?: boolean }) {
  const mask = useMask()
  return <>{text ? mask.text(value) : mask.address(value)}</>
}
