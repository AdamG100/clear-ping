'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { maskAddress, maskText } from '@/lib/privacy/mask'

/**
 * Whether this page hides addresses, and the functions that hide them.
 *
 * Hidden when Settings → Privacy hides them from this account, or when this
 * browser has been told to (for sharing a screen, without changing it for
 * anyone else). Both are remembered here, so a page that loads with them
 * hidden never shows them while it asks the server again.
 *
 * It is what is shown that changes, not what is sent: anyone signed in can
 * still read the addresses through the API.
 */

const HERE = 'clearping.privacy.hide-here'
const SERVER = 'clearping.privacy.hidden'
const CHANGED = 'clearping:privacy-changed'

const read = (key: string) => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const write = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Not kept past this page: it still applies while it is open.
  }
}

let state: { server: boolean; here: boolean } | null = null
let asked = false
const listeners = new Set<() => void>()

function current() {
  return (state ??= { server: read(SERVER), here: read(HERE) })
}

function set(next: Partial<{ server: boolean; here: boolean }>) {
  state = { ...current(), ...next }
  for (const listener of listeners) listener()
}

async function ask() {
  try {
    const response = await fetch('/api/privacy', { cache: 'no-store' })
    if (!response.ok) return
    const { hideAddresses } = (await response.json()) as { hideAddresses: boolean }
    write(SERVER, hideAddresses)
    set({ server: hideAddresses })
  } catch {
    // Kept as it was last known.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!asked) {
    asked = true
    void ask()
    window.addEventListener(CHANGED, () => void ask())
  }
  return () => listeners.delete(listener)
}

/** Ask again, after the settings have been changed. */
export function announcePrivacyChanged(): void {
  window.dispatchEvent(new Event(CHANGED))
}

/** Hide addresses in this browser only, or stop. */
export function setHiddenHere(on: boolean): void {
  write(HERE, on)
  set({ here: on })
}

export function useHiddenHere(): boolean {
  return useSyncExternalStore(subscribe, () => current().here, () => false)
}

/** Whether addresses are hidden on this page. */
export function useAddressesHidden(): boolean {
  return useSyncExternalStore(subscribe, () => current().server || current().here, () => false)
}

const shown = (text: string) => text

/**
 * `address` for an address on its own (a target's host, a hop, a probe
 * agent's); `text` for anything that may have one inside it, such as a name
 * given as an IP address. Both leave everything as it is while addresses are
 * shown.
 */
export function useMask(): { hidden: boolean; address: (value: string) => string; text: (value: string) => string } {
  const hidden = useAddressesHidden()
  return useMemo(
    () =>
      hidden
        ? { hidden, address: maskAddress, text: (value: string) => maskText(value, { names: true }) }
        : { hidden, address: shown, text: shown },
    [hidden]
  )
}
