'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { PasswordField } from '@/components/arc/password-field/password-field'
import { BrandMark } from '../_components/monitoring/brand-mark'

/**
 * Sign in, or make the first account.
 *
 * Which of the two is up to the server: an install with no account yet
 * offers to make one, and so does one started with CLEARPING_AUTH=off to get
 * back in after a lost password.
 */

interface Status {
  loginRequired: boolean
  accountExists: boolean
  registrationOpen: boolean
  recovery: boolean
  passwordLogin: boolean
  sso: { label: string } | null
  signedIn: { username: string } | null
}

const MIN_PASSWORD = 10

export function LoginForm({ next, initialError }: { next: string; initialError: string | null }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [mode, setMode] = useState<'signin' | 'register'>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(initialError)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/auth/status')
      .then(response => response.json())
      .then((told: Status) => {
        setStatus(told)
        setMode(told.accountExists ? 'signin' : 'register')
      })
      .catch(() => setError('ClearPing could not be reached. Try again in a moment.'))
  }, [])

  const registering = mode === 'register'
  // Single sign-on as the only way in: the form is not shown at all.
  const passwordForm = registering || status?.passwordLogin !== false
  const ssoHref = `/api/auth/sso/start?next=${encodeURIComponent(next)}`

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (registering && password !== confirm) {
      setError('The two passwords are not the same')
      return
    }
    setBusy(true)
    try {
      const response = await fetch(registering ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body.error ?? 'That did not work. Try again.')
        return
      }
      // A full load, so the dashboard starts from scratch as the signed-in user.
      window.location.assign(next)
    } catch {
      setError('ClearPing could not be reached. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }


  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <div>
            <p className="text-sm font-medium text-foreground">ClearPing</p>
            <p className="text-xs text-muted-foreground">Path monitor</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-5 rounded-3xl border border-border bg-card p-6" noValidate>
          <div className="space-y-1">
            <h1 className="text-lg font-medium text-card-foreground">
              {registering ? (status?.accountExists ? 'Make a new account' : 'Create your account') : 'Sign in'}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {registering
                ? status?.accountExists
                  ? 'CLEARPING_AUTH=off is set, so a new account can be made to get back in. Remove it once you are in.'
                  : 'The first account on this ClearPing. With it you can turn on sign-in and create keys for scripts and AI assistants.'
                : status && !status.loginRequired
                  ? 'Sign in to change security settings, create keys and see who changed what.'
                  : 'This ClearPing asks you to sign in.'}
            </p>
          </div>

          {status?.sso && !registering && (
            <>
              {/* A full load, not a fetch: the provider's sign-in is a page of its own. */}
              <Button
                type="button"
                className="w-full"
                variant={passwordForm ? 'secondary' : 'primary'}
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a route that redirects out to the provider, not a page
                onClick={() => { window.location.href = ssoHref }}
              >
                <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
                Sign in with {status.sso.label}
              </Button>
              {passwordForm && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
                  <span className="h-px flex-1 bg-border" />
                  or with a password
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
            </>
          )}

          {status?.recovery && !registering && (
            <Alert tone="warning" title="Sign-in is off for now">
              CLEARPING_AUTH=off is set where ClearPing runs.
            </Alert>
          )}

          {passwordForm && (
            <>
              <Input
                label="Username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={event => setUsername(event.target.value)}
                required
                autoFocus
              />
              <PasswordField
                label="Password"
                description={registering ? `At least ${MIN_PASSWORD} characters.` : undefined}
                autoComplete={registering ? 'new-password' : 'current-password'}
                value={password}
                onChange={event => setPassword(event.target.value)}
                required
                minLength={registering ? MIN_PASSWORD : undefined}
              />
              {registering && (
                <PasswordField
                  label="Password again"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={event => setConfirm(event.target.value)}
                  required
                />
              )}
            </>
          )}

          {error && (
            <Alert tone="danger" title={registering ? 'The account was not made' : 'You are not signed in'}>
              {error}
            </Alert>
          )}

          {passwordForm && (
            <Button type="submit" className="w-full" loading={busy} disabled={!status || !username || !password}>
              {registering ? 'Create account' : 'Sign in'}
            </Button>
          )}

          {status?.registrationOpen && status.accountExists && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => { setMode(registering ? 'signin' : 'register'); setError(null) }}
            >
              {registering ? 'Sign in with an existing account instead' : 'Make a new account instead'}
            </Button>
          )}
          {status && !status.loginRequired && !registering && (
            <a href={next} className="block text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Back to the dashboard
            </a>
          )}
        </form>
      </div>
    </main>
  )
}
