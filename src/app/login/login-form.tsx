'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound, Loader2, LockKeyhole } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
            <h1 className="text-sm font-semibold tracking-tight text-foreground">ClearPing</h1>
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Path monitor</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm" noValidate>
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-base font-semibold text-card-foreground">
              <LockKeyhole className="h-4 w-4 text-muted-foreground" />
              {registering ? (status?.accountExists ? 'Make a new account' : 'Create your account') : 'Sign in'}
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {registering
                ? status?.accountExists
                  ? 'CLEARPING_AUTH=off is set, so a new account can be made to get back in. Remove it once you are in.'
                  : 'The first account on this ClearPing. With it you can turn on sign-in and make keys for scripts and AI assistants.'
                : status && !status.loginRequired
                  ? 'Sign in to change security settings, make keys and see who changed what.'
                  : 'This ClearPing asks you to sign in.'}
            </p>
          </div>

          {status?.sso && !registering && (
            <>
              {/* A link, not a fetch: the provider's sign-in is a page of its own. */}
              <Button asChild className="w-full" variant={passwordForm ? 'outline' : 'default'}>
                <a href={ssoHref}>
                  <KeyRound className="h-4 w-4" />
                  Sign in with {status.sso.label}
                </a>
              </Button>
              {passwordForm && (
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground" aria-hidden="true">
                  <span className="h-px flex-1 bg-border" />
                  or with a password
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
            </>
          )}

          {status?.recovery && !registering && (
            <p className="rounded-md border border-signal-minor/40 bg-signal-minor/10 px-3 py-2 text-xs leading-relaxed text-foreground">
              CLEARPING_AUTH=off is set: sign-in is not being asked for right now.
            </p>
          )}

          {passwordForm && (<>
          <div className="space-y-1.5">
            <Label htmlFor="username" className="text-xs text-card-foreground">Username</Label>
            <Input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={event => setUsername(event.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs text-card-foreground">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={registering ? 'new-password' : 'current-password'}
              value={password}
              onChange={event => setPassword(event.target.value)}
              required
              minLength={registering ? MIN_PASSWORD : undefined}
            />
            {registering && <p className="text-[11px] text-muted-foreground">At least {MIN_PASSWORD} characters.</p>}
          </div>
          {registering && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm" className="text-xs text-card-foreground">Password again</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={event => setConfirm(event.target.value)}
                required
              />
            </div>
          )}

          </>)}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="alert">
              {error}
            </p>
          )}

          {passwordForm && (
            <Button type="submit" className="w-full" disabled={busy || !status || !username || !password}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {registering ? 'Create account' : 'Sign in'}
            </Button>
          )}

          {status?.registrationOpen && status.accountExists && (
            <button
              type="button"
              onClick={() => { setMode(registering ? 'signin' : 'register'); setError(null) }}
              className="w-full cursor-pointer text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {registering ? 'Sign in with an existing account instead' : 'Make a new account instead'}
            </button>
          )}
          {status && !status.loginRequired && !registering && (
            <a href={next} className="block text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Back to the dashboard
            </a>
          )}
        </form>
      </div>
    </main>
  )
}
