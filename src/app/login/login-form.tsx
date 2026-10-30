'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Fingerprint, KeyRound } from 'lucide-react'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { Input } from '@/components/arc/input/input'
import { OtpInput } from '@/components/arc/otp-input/otp-input'
import { PasswordField } from '@/components/arc/password-field/password-field'
import { BrandMark } from '../_components/shell/brand-mark'

/**
 * Sign in, or make the first account.
 *
 * Which of the two is up to the server: an install with no account yet
 * offers to make one, and so does one started with CLEARPING_AUTH=off to get
 * back in after a lost password.
 *
 * An account with an authenticator app is asked for its code after the
 * password; one with a passkey can sign in with that alone. Both are Better
 * Auth's, through /api/auth/two-factor and /api/auth/passkey.
 *
 * A forgotten password is reset with a one-time code ClearPing writes to its
 * server log (/api/auth/password-reset). A password link an admin made
 * (Settings → Accounts) opens this page with the same kind of code after the
 * `#`, and asks only for the new password.
 */

interface Status {
  loginRequired: boolean
  changesNeedSignIn?: boolean
  accountExists: boolean
  registrationOpen: boolean
  setupCodeRequired: boolean
  recovery: boolean
  passwordLogin: boolean
  passkeys: boolean
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
  const [setupCode, setSetupCode] = useState('')
  const [error, setError] = useState<string | null>(initialError)
  const [busy, setBusy] = useState(false)
  // After a right password, for an account with an authenticator app.
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [code, setCode] = useState('')
  const [backup, setBackup] = useState(false)
  const [trustDevice, setTrustDevice] = useState(false)
  // A forgotten password: ask for a code, then type it with the new password.
  // Or a password link, which brings its code with it.
  const [reset, setReset] = useState<'ask' | 'enter' | 'link' | null>(null)
  const [resetCode, setResetCode] = useState('')
  const [notice, setNotice] = useState<{ title: string; detail: string } | null>(null)

  // A password link: its code and username are after the `#`, which the
  // browser never sends to the server. Taken out of the address at once, so it
  // is not left in the history or on the screen.
  useEffect(() => {
    const told = new URLSearchParams(window.location.hash.slice(1))
    const token = told.get('password-link')
    if (!token) return
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    // Read once, from the address, after the first render.
    /* eslint-disable react-hooks/set-state-in-effect */
    setResetCode(token)
    setUsername(told.get('user') ?? '')
    setReset('link')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

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
        body: JSON.stringify(registering ? { username, password, setupCode } : { username, password }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body.error ?? 'That did not work. Try again.')
        return
      }
      if (body.twoFactor) {
        setStep('code')
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


  const sendCode = async (typed: string) => {
    setError(null)
    setBusy(true)
    try {
      const response = await fetch('/api/auth/two-factor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: typed, backup, trustDevice }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body.error ?? 'That code is not right')
        setCode('')
        if (body.restart) {
          setStep('password')
          setPassword('')
        }
        return
      }
      window.location.assign(next)
    } catch {
      setError('ClearPing could not be reached. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const withPasskey = async () => {
    setError(null)
    setBusy(true)
    try {
      const post = (body: unknown) =>
        fetch('/api/auth/passkey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const options = await post({ step: 'options' })
      const optionsJSON = await options.json().catch(() => ({}))
      if (!options.ok) {
        setError(optionsJSON.error ?? 'Could not start signing in with a passkey')
        return
      }
      let response
      try {
        response = await startAuthentication({ optionsJSON })
      } catch (problem) {
        // Closing the browser's prompt is a choice, not a failure.
        if ((problem as Error).name !== 'NotAllowedError') setError('The passkey could not be used. Try again, or sign in with your password.')
        return
      }
      const verified = await post({ step: 'verify', response })
      const body = await verified.json().catch(() => ({}))
      if (!verified.ok) {
        setError(body.error ?? 'That passkey was not accepted')
        return
      }
      window.location.assign(next)
    } catch {
      setError('ClearPing could not be reached. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const passkeyOffered = !registering && step === 'password' && !!status?.passkeys && typeof window !== 'undefined' && browserSupportsWebAuthn()

  const sendReset = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (reset !== 'ask' && password !== confirm) {
      setError('The two passwords are not the same')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/auth/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reset === 'ask' ? { step: 'ask', username } : { step: 'reset', code: resetCode, password }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        // The code is the link's own: there is no code to retype, only a new link to ask for.
        const linkSpent = reset === 'link' && /code/i.test(String(body.error ?? ''))
        setError(linkSpent ? 'This link has been used, or it has run out. Ask an admin for a new one.' : body.error ?? 'That did not work. Try again.')
        return
      }
      if (reset === 'ask') {
        setReset('enter')
        setPassword('')
        setConfirm('')
        return
      }
      setReset(null)
      setPassword('')
      setConfirm('')
      setResetCode('')
      setNotice(reset === 'link'
        ? { title: 'Password set', detail: 'Your password is set. Sign in with it.' }
        : { title: 'Password reset', detail: 'Your password is changed. Sign in with the new one.' })
    } catch {
      setError('ClearPing could not be reached. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const leaveReset = () => {
    setReset(null)
    setResetCode('')
    setPassword('')
    setConfirm('')
    setError(null)
  }

  if (reset) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <div>
              <p className="text-sm font-medium text-foreground">ClearPing</p>
              <p className="text-xs text-muted-foreground">Network monitor</p>
            </div>
          </div>
          <form onSubmit={sendReset} className="space-y-5 rounded-3xl border border-border bg-card p-6" noValidate>
            <div className="space-y-1">
              <h1 className="text-lg font-medium text-card-foreground">{reset === 'link' ? 'Choose your password' : 'Reset your password'}</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {reset === 'link'
                  ? `For ${username || 'your account'}: the password you will sign in with. This link works once.`
                  : reset === 'ask'
                  ? 'For the primary account, the first one made: ClearPing writes a one-time code to its server log, which only whoever runs the server can read. Any other account, ask an admin to set a new password for you.'
                  : `If ${username.trim()} is the primary account, its code is in the server log now. It works once, for 15 minutes.`}
              </p>
            </div>

            {reset === 'ask' ? (
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
            ) : (
              <>
                {reset === 'enter' && (
                  <>
                    {/* Where to find it, ready to copy. */}
                    <CodeBlock code={'docker logs clear_ping 2>&1 | grep "reset code"'} filename="On the server" language="bash" />
                    <Input
                      label="Code from the log"
                      autoComplete="one-time-code"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={resetCode}
                      onChange={event => setResetCode(event.target.value)}
                      required
                      autoFocus
                      style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
                    />
                  </>
                )}
                {/* For the password manager: which account this password is for. */}
                {reset === 'link' && username && (
                  <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
                )}
                <PasswordField
                  label="New password"
                  autoFocus={reset === 'link'}
                  description={`At least ${MIN_PASSWORD} characters.`}
                  autoComplete="new-password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  required
                  minLength={MIN_PASSWORD}
                />
                <PasswordField
                  label="New password again"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={event => setConfirm(event.target.value)}
                  required
                />
              </>
            )}

            {error && <Alert tone="danger" title={reset === 'link' ? 'The password was not set' : 'The password was not reset'}>{error}</Alert>}

            <Button
              type="submit"
              className="w-full"
              loading={busy}
              disabled={reset === 'ask' ? !username.trim() : !resetCode.trim() || !password || !confirm}
            >
              {reset === 'ask' ? 'Write a code to the log' : reset === 'link' ? 'Set my password' : 'Set the new password'}
            </Button>
            <div className="space-y-1">
              {reset === 'enter' && (
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setReset('ask'); setError(null) }}>
                  Ask for another code
                </Button>
              )}
              <Button type="button" variant="ghost" className="w-full" onClick={leaveReset}>
                Back to sign in
              </Button>
            </div>
          </form>
        </div>
      </main>
    )
  }

  if (step === 'code') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <div>
              <p className="text-sm font-medium text-foreground">ClearPing</p>
              <p className="text-xs text-muted-foreground">Network monitor</p>
            </div>
          </div>
          <form
            onSubmit={event => { event.preventDefault(); void sendCode(code) }}
            className="space-y-5 rounded-3xl border border-border bg-card p-6"
            noValidate
          >
            <div className="space-y-1">
              <h1 className="text-lg font-medium text-card-foreground">{backup ? 'Use a backup code' : 'Type your code'}</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {backup
                  ? 'One of the codes you kept when you set up your authenticator app. Each works once.'
                  : 'The six digits your authenticator app shows for ClearPing.'}
              </p>
            </div>
            {backup ? (
              <Input
                label="Backup code"
                required
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                value={code}
                onChange={event => setCode(event.target.value)}
                style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
              />
            ) : (
              <OtpInput
                label="Code from the app"
                value={code}
                disabled={busy}
                autoFocus
                onChange={typed => {
                  setCode(typed)
                  if (typed.length === 6) void sendCode(typed)
                }}
              />
            )}
            <Checkbox
              label="Trust this browser for 30 days"
              description="It will not ask for a code here again until then."
              checked={trustDevice}
              onCheckedChange={checked => setTrustDevice(checked === true)}
            />
            {error && <Alert tone="danger" title="You are not signed in">{error}</Alert>}
            <Button type="submit" className="w-full" loading={busy} disabled={!code}>
              Sign in
            </Button>
            {/* The two ways out of this step, kept together under the one way on. */}
            <div className="space-y-1">
              <Button type="button" variant="ghost" className="w-full" onClick={() => { setBackup(!backup); setCode(''); setError(null) }}>
                {backup ? 'Use a code from the app instead' : 'Use a backup code instead'}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => { setStep('password'); setPassword(''); setCode(''); setError(null) }}>
                Back
              </Button>
            </div>
          </form>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <div>
            <p className="text-sm font-medium text-foreground">ClearPing</p>
            <p className="text-xs text-muted-foreground">Network monitor</p>
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
                  ? status.changesNeedSignIn
                    ? 'Sign in to change what is monitored, as well as security settings and keys.'
                    : 'Sign in to change security settings, create keys and see who changed what.'
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
              {registering && status?.setupCodeRequired && (
                <Input
                  label="Setup code"
                  description="Printed in the ClearPing server log when it started: docker logs clear_ping"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={setupCode}
                  onChange={event => setSetupCode(event.target.value)}
                  required
                />
              )}
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

          {notice && !error && <Alert tone="success" title={notice.title}>{notice.detail}</Alert>}

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

          {passkeyOffered && (
            <Button type="button" variant="secondary" className="w-full" onClick={withPasskey} disabled={busy}>
              <Fingerprint size={16} strokeWidth={1.75} aria-hidden="true" />
              Sign in with a passkey
            </Button>
          )}

          {passwordForm && !registering && status?.accountExists && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => { setReset('ask'); setPassword(''); setError(null); setNotice(null) }}
            >
              Forgot your password?
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
