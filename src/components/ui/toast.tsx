'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Minimal toast system.
 *
 * Exists because every failure in this app used to end at `console.error`:
 * adding a target with an invalid host, a probe returning 500, a reorder that
 * did not save — all silent. A monitoring tool that fails quietly is worse
 * than most apps that do.
 */

type ToastTone = 'error' | 'success' | 'info'

interface Toast {
  id: number
  tone: ToastTone
  title: string
  detail?: string
}

interface ToastContextValue {
  notify: (toast: Omit<Toast, 'id'>) => void
  /** Convenience for the common case: report a caught error. */
  reportError: (title: string, error?: unknown) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const TONE_STYLES: Record<ToastTone, { icon: typeof Info; className: string }> = {
  error: { icon: AlertTriangle, className: 'border-destructive/40 text-destructive' },
  success: { icon: CheckCircle2, className: 'border-emerald-500/40 text-emerald-500' },
  info: { icon: Info, className: 'border-border text-foreground' },
}

const DISMISS_AFTER_MS = 6000

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts(current => current.filter(t => t.id !== id))
  }, [])

  const notify = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random()
      setToasts(current => [...current, { ...toast, id }])
      // Errors stay until dismissed; transient successes clear themselves.
      if (toast.tone !== 'error') {
        setTimeout(() => dismiss(id), DISMISS_AFTER_MS)
      }
    },
    [dismiss]
  )

  const reportError = useCallback(
    (title: string, error?: unknown) => {
      const detail =
        error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
      console.error(title, error)
      notify({ tone: 'error', title, detail })
    },
    [notify]
  )

  const value = useMemo(() => ({ notify, reportError }), [notify, reportError])

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        <AnimatePresence initial={false}>
          {toasts.map(toast => {
            const { icon: Icon, className } = TONE_STYLES[toast.tone]
            return (
              <motion.div
                key={toast.id}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.98 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className={cn(
                  'pointer-events-auto flex items-start gap-3 rounded-lg border bg-card p-3 shadow-lg',
                  className
                )}
                // Errors interrupt; the rest wait for a natural pause.
                role={toast.tone === 'error' ? 'alert' : 'status'}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{toast.title}</p>
                  {toast.detail && (
                    <p className="mt-0.5 text-xs break-words text-muted-foreground">{toast.detail}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside a ToastProvider')
  }
  return context
}
