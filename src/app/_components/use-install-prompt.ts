'use client'

import { useCallback, useSyncExternalStore } from 'react'
import type { InstallOffer } from '@/types/pwa'

/**
 * Whether to offer installing the app, and how, on the device it is open on.
 *
 * Phones and tablets only. A desktop browser makes its own offer in the
 * address bar, where a banner across the dashboard would only be in the way.
 *
 * There is no one way to install a web app:
 *
 * - Chromium (Android) tells the page when the app can be installed and lets
 *   it show the install dialog. The offer is caught by a script in the
 *   document head, since it can be made before this code has loaded.
 * - iOS tells the page nothing and gives it nothing to call. All there is to
 *   do is say where *Add to Home Screen* is.
 * - Android at a plain `http://` address is never offered an install at all,
 *   which from the outside looks like the app simply not being installable.
 */

/** Fired by the script in the document head whenever the browser's offer changes. */
export const INSTALL_PROMPT_CHANGE = 'installpromptchange'

const DISMISSED_KEY = 'installPromptDismissed'

/** Turned down since the page was loaded, for where that cannot be stored. */
let dismissedThisVisit = false

function isDismissed() {
  if (dismissedThisVisit) return true
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null
  } catch {
    // Storage is unavailable (private mode, blocked). Offering again on the
    // next visit is better than never offering.
    return false
  }
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
}

function isTouchDevice() {
  return window.matchMedia('(hover: none), (pointer: coarse)').matches
}

function isIos() {
  // An iPad says it is a Mac. A Mac with a touchscreen does not exist.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function currentOffer(): InstallOffer | null {
  if (isInstalled() || isDismissed() || !isTouchDevice()) return null
  if (window.__installPrompt) return 'prompt'
  if (isIos()) return 'ios'
  if (/Android/.test(navigator.userAgent) && !window.isSecureContext) return 'needs-https'
  return null
}

function subscribe(onChange: () => void) {
  window.addEventListener(INSTALL_PROMPT_CHANGE, onChange)
  return () => window.removeEventListener(INSTALL_PROMPT_CHANGE, onChange)
}

const announceChange = () => window.dispatchEvent(new Event(INSTALL_PROMPT_CHANGE))

export function useInstallPrompt() {
  // Nothing on the server, which does not know what it is being opened on.
  const offer = useSyncExternalStore(subscribe, currentOffer, () => null)

  /** Not offered again on this device. The browser's own menu still installs it. */
  const dismiss = useCallback(() => {
    dismissedThisVisit = true
    try {
      localStorage.setItem(DISMISSED_KEY, new Date().toISOString())
    } catch {
      // Nowhere to remember it; it is at least gone until the page is reloaded.
    }
    announceChange()
  }, [])

  /** Show the browser's install dialog. Only does anything while the offer is `prompt`. */
  const install = useCallback(async () => {
    const prompt = window.__installPrompt
    if (!prompt) return

    // The browser's offer can be shown once.
    window.__installPrompt = null
    await prompt.prompt()
    const { outcome } = await prompt.userChoice
    // Turned down in the browser's dialog is turned down here as well.
    if (outcome === 'dismissed') dismiss()
    else announceChange()
  }, [dismiss])

  return { offer, install, dismiss }
}
