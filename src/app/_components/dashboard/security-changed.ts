/** The first-run prompt listens for this after a security switch changes. */
export const SECURITY_CHANGED = 'clearping:security'

export function notifySecurityChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(SECURITY_CHANGED))
}
