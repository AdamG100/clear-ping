'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import { ToastStack, ToastStackProvider, useToastStack } from '@/components/arc/toast-stack/toast-stack'

/**
 * Notifications, on Arc's toast stack.
 *
 * Exists because every failure in this app used to end at `console.error`:
 * adding a target with an invalid host, a probe returning 500, a reorder that
 * did not save — all silent. A monitoring tool that fails quietly is worse
 * than most apps that do. Errors stay until dismissed; the rest clear
 * themselves.
 */

/** `loading` spins until the same `id` is notified again with how it ended. */
type Tone = 'error' | 'success' | 'warning' | 'info' | 'loading'

interface Notification {
  /** Given, a later notification with the same id replaces this one in place. */
  id?: string
  tone: Tone
  title: string
  detail?: string
}

interface Notifier {
  notify: (notification: Notification) => void
  /** Convenience for the common case: report a caught error. */
  reportError: (title: string, error?: unknown) => void
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  return (
    <ToastStackProvider duration={6000}>
      {children}
      <ToastStack />
    </ToastStackProvider>
  )
}

export function useToast(): Notifier {
  const { toast } = useToastStack()

  const notify = useCallback(
    ({ id, tone, title, detail }: Notification) => {
      toast({ id, type: tone, title, description: detail, duration: tone === 'error' ? Infinity : undefined })
    },
    [toast]
  )

  const reportError = useCallback(
    (title: string, error?: unknown) => {
      const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
      console.error(title, error)
      notify({ tone: 'error', title, detail })
    },
    [notify]
  )

  return useMemo(() => ({ notify, reportError }), [notify, reportError])
}
