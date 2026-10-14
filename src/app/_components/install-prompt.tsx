'use client'

import type { ReactNode } from 'react'
import { Share, SquarePlus, X } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import type { InstallOffer } from '@/types/pwa'
import { BrandMark } from './monitoring/brand-mark'
import { useInstallPrompt } from './use-install-prompt'

/**
 * The offer to install ClearPing, shown along the bottom of a phone's screen
 * until it is taken up or turned down.
 *
 * It sits under the sidebar drawer and under dialogs and notifications: it is
 * an offer, and must never be what stands between someone and a failing path.
 */

const STEP_ICON = 'mx-0.5 inline h-3.5 w-3.5 -translate-y-px text-foreground'

const COPY: Record<InstallOffer, { title: string; body: ReactNode }> = {
  prompt: {
    title: 'Install ClearPing',
    body: 'Add it to your home screen and it opens in a window of its own, like any other app.',
  },
  ios: {
    title: 'Install ClearPing',
    body: (
      <>
        Tap <Share className={STEP_ICON} aria-hidden="true" /> <strong className="font-medium text-foreground">Share</strong>{' '}
        in the browser&apos;s toolbar, then{' '}
        <SquarePlus className={STEP_ICON} aria-hidden="true" />{' '}
        <strong className="font-medium text-foreground">Add to Home Screen</strong>.
      </>
    ),
  },
  'needs-https': {
    title: 'Installing needs HTTPS',
    body: (
      <>
        Android only installs an app from a secure address. Open ClearPing at an{' '}
        <span className="font-mono">https://</span> address and it will offer to install; at this one the browser can
        only add a shortcut.
      </>
    ),
  },
}

export function InstallPrompt() {
  const { offer, install, dismiss } = useInstallPrompt()
  if (!offer) return null

  const { title, body } = COPY[offer]

  return (
    <section
      aria-label={title}
      className="animate-in fade-in slide-in-from-bottom-4 fixed bottom-[calc(0.75rem+var(--safe-bottom))] left-[calc(0.75rem+var(--safe-left))] right-[calc(0.75rem+var(--safe-right))] z-20 mx-auto max-w-md rounded-3xl border border-border bg-popover p-4 shadow-floating duration-300"
    >
      <div className="flex items-start gap-3">
        <BrandMark className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-card-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{body}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss the offer to install">
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>

      {/* Only where there is something the page can do: elsewhere the text
          above is the whole of it, and the cross puts it away. */}
      {offer === 'prompt' && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" className="flex-1" onClick={install}>
            Install ClearPing
          </Button>
          <Button size="sm" variant="secondary" className="flex-1" onClick={dismiss}>
            Not now
          </Button>
        </div>
      )}
    </section>
  )
}
