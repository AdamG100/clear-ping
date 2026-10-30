'use client'

import { useCallback, useEffect, useState } from 'react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { useToast } from '@/components/notifications'
import { canAdminister, isRole, type Role } from '@/lib/security/roles'
import { notifySecurityChanged, SECURITY_CHANGED } from './security-changed'

interface AdviceStatus {
  adviseSignIn: boolean
  accountExists: boolean
  signedIn: { username: string; role: Role } | null
}

function readStatus(body: unknown): AdviceStatus | null {
  if (!body || typeof body !== 'object') return null
  const status = body as Record<string, unknown>
  const signed = status.signedIn
  let signedIn: AdviceStatus['signedIn'] = null
  if (signed && typeof signed === 'object') {
    const person = signed as Record<string, unknown>
    if (typeof person.username === 'string' && isRole(person.role)) {
      signedIn = { username: person.username, role: person.role }
    }
  }
  return {
    adviseSignIn: status.adviseSignIn === true,
    accountExists: status.accountExists === true,
    signedIn,
  }
}

async function loadStatus(): Promise<AdviceStatus | null> {
  const response = await fetch('/api/auth/status').catch(() => null)
  if (!response?.ok) return null
  return readStatus(await response.json().catch(() => null))
}

function copyFor(status: AdviceStatus, confirming: boolean): string {
  const open =
    'Anyone who can reach this address can use the dashboard, the API and assistants. On your own network that is fine. On a server the internet can reach, turn sign-in on.'
  if (confirming) {
    return 'Leave sign-in off only when this address is not reachable from the internet. Anyone who can open it can still use the dashboard, the API and assistants.'
  }
  if (!status.accountExists) {
    return `${open} Create the first account. It can turn sign-in on, and set up single sign-on with Authentik or any OpenID Connect provider.`
  }
  if (!status.signedIn) {
    return `${open} Sign in to turn sign-in on, or to set up single sign-on.`
  }
  if (canAdminister(status.signedIn.role)) {
    return `${open} Single sign-on with Authentik, or any OpenID Connect provider, is another way in once sign-in is on.`
  }
  return `${open} An admin has to turn sign-in on.`
}

/**
 * The first thing a new install asks: turn sign-in on, or set up single
 * sign-on. It sits above every page until sign-in is required, or an admin
 * says this stays on the network. A visitor cannot put it away.
 */
export function SetupAdvice({ pageKey, onSetupSso }: { pageKey: string; onSetupSso: () => void }) {
  const { reportError } = useToast()
  const [status, setStatus] = useState<AdviceStatus | null>(null)
  const [busy, setBusy] = useState<'signin' | 'dismiss' | null>(null)
  const [confirming, setConfirming] = useState(false)

  const refresh = useCallback(async () => {
    const next = await loadStatus()
    if (next) setStatus(next)
  }, [])

  useEffect(() => {
    let current = true
    void loadStatus().then(next => {
      if (current && next) setStatus(next)
    })
    return () => {
      current = false
    }
  }, [pageKey])

  useEffect(() => {
    const onChange = () => {
      void refresh()
    }
    window.addEventListener(SECURITY_CHANGED, onChange)
    return () => window.removeEventListener(SECURITY_CHANGED, onChange)
  }, [refresh])

  if (!status?.adviseSignIn) return null

  const admin = status.signedIn !== null && canAdminister(status.signedIn.role)

  const goToSignIn = () => {
    const here = `${window.location.pathname}${window.location.search}`
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- the sign-in page is its own app shell; a full load, as signing in is
    window.location.href = `/login?next=${encodeURIComponent(here)}`
  }

  const turnOn = async () => {
    setBusy('signin')
    try {
      const response = await fetch('/api/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginRequired: true }),
      })
      const body: { error?: unknown } = await response.json().catch(() => ({}))
      if (!response.ok) {
        reportError('Could not turn sign-in on', typeof body.error === 'string' ? body.error : undefined)
        return
      }
      setStatus(current => (current ? { ...current, adviseSignIn: false } : current))
      notifySecurityChanged()
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async () => {
    setBusy('dismiss')
    try {
      const response = await fetch('/api/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupAdviceDismissed: true }),
      })
      const body: { error?: unknown } = await response.json().catch(() => ({}))
      if (!response.ok) {
        reportError('Could not save that choice', typeof body.error === 'string' ? body.error : undefined)
        return
      }
      setStatus(current => (current ? { ...current, adviseSignIn: false } : current))
      notifySecurityChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="px-4 pt-4 @2xl/main:px-6 @2xl/main:pt-6">
      <div className="max-w-3xl space-y-3">
        <Alert tone="warning" title="Sign-in is off">
          {copyFor(status, admin && confirming)}
        </Alert>
        {admin ? (
          <div className="flex flex-wrap items-center gap-2">
            {confirming ? (
              <>
                <Button type="button" variant="danger" loading={busy === 'dismiss'} disabled={busy !== null} onClick={() => { void dismiss() }}>
                  Leave sign-in off
                </Button>
                <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setConfirming(false)}>
                  Back
                </Button>
              </>
            ) : (
              <>
                <Button type="button" loading={busy === 'signin'} disabled={busy !== null} onClick={() => { void turnOn() }}>
                  Turn on sign-in
                </Button>
                <Button type="button" variant="secondary" disabled={busy !== null} onClick={onSetupSso}>
                  Set up single sign-on
                </Button>
                <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>
                  This stays on my network
                </Button>
              </>
            )}
          </div>
        ) : status.signedIn === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={goToSignIn}>
              {status.accountExists ? 'Sign in' : 'Create an account'}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
