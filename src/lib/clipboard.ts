/**
 * Put text on the clipboard, in the browser.
 *
 * The Clipboard API is only there on a secure page: HTTPS, or localhost.
 * ClearPing is often opened by its address on the local network over plain
 * HTTP, where it is missing and every copy button said "Failed". There the
 * old way still works: select the text in a field and have the browser copy
 * the selection.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // Inside an open dialog, not at the end of the page: a dialog keeps focus
  // to itself, and would take it back from a field outside before the copy.
  const host = previous?.closest('[role="dialog"]') ?? document.body
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.setAttribute('aria-hidden', 'true')
  Object.assign(field.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' })
  host.appendChild(field)

  try {
    field.select()
    // Deprecated, and the only way left on a page that is not secure.
    if (!document.execCommand('copy')) throw new Error('The browser would not copy the text')
  } finally {
    field.remove()
    previous?.focus({ preventScroll: true })
  }
}
