/**
 * The parts of installing a web app that TypeScript's own DOM types leave out,
 * because only some browsers have them.
 */

/**
 * Chromium's offer to install the app (Android, and desktop Chrome and Edge).
 * Held on to, it can be shown later, once, from a button of the page's own.
 */
export interface BeforeInstallPromptEvent extends Event {
  /** Shows the browser's own install dialog. */
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * What the page can do about being installed, on the device it is open on.
 *
 * - `prompt`: the browser has offered, and its install dialog can be shown.
 * - `ios`: there is nothing to show; it is added from the browser's Share menu.
 * - `needs-https`: Android, at an address browsers will not install from.
 */
export type InstallOffer = 'prompt' | 'ios' | 'needs-https'

declare global {
  interface Window {
    /**
     * The browser's offer to install, kept from the moment it is made by the
     * script in the document head (see layout.tsx). Null once it is used up.
     */
    __installPrompt?: BeforeInstallPromptEvent | null
  }

  interface Navigator {
    /** Safari on iOS: true when the page is running from the home screen. */
    readonly standalone?: boolean
  }
}
