'use client'

import { ArrowRight, LogOut } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { SignInFactors, useMyFactors } from '../_components/settings/sign-in-factors'
import { BrandMark } from '../_components/shell/brand-mark'

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

export function SecuritySetup({ next }: { next: string }) {
  const { mine, error, reload } = useMyFactors()

  const signOut = async () => {
    const answer = await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
    const body = await answer?.json().catch(() => ({}))
    const providerSignOut = typeof body?.redirect === 'string' && /^https?:\/\//.test(body.redirect) ? body.redirect : null
    window.location.href = providerSignOut ?? new URL('/login', window.location.href).href
  }

  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-10">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <div>
              <p className="text-sm font-medium text-foreground">ClearPing</p>
              <p className="text-xs text-muted-foreground">Path monitor</p>
            </div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={signOut}>
            <LogOut {...ICON} />
            Sign out
          </Button>
        </div>

        <section className="space-y-6 rounded-3xl border border-border bg-card p-6 text-card-foreground">
          <div className="space-y-1">
            <h1 className="text-lg font-medium">Secure your account</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {mine ? `Signed in as ${mine.username}. ` : ''}Add what is asked for below, and ClearPing opens as usual.
            </p>
          </div>

          {error && <Alert tone="danger" title="Could not load your account">{error}</Alert>}
          {!mine && !error && <Skeleton label="Loading your account" lines={4} />}
          {mine && <SignInFactors mine={mine} reload={reload} />}

          {mine && !mine.owes && (
            <div className="space-y-3 border-t border-border pt-5">
              <Alert tone="success" title="All set">Your account has what is required.</Alert>
              {/* A full load: the dashboard starts again as an account that may use it. */}
              <Button type="button" onClick={() => window.location.assign(next)}>
                Open ClearPing
                <ArrowRight {...ICON} />
              </Button>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

