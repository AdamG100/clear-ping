'use client'

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { Fingerprint, KeyRound, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import QRCode from 'qrcode'
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Input } from '@/components/arc/input/input'
import { OtpInput } from '@/components/arc/otp-input/otp-input'
import { PasswordField } from '@/components/arc/password-field/password-field'
import { RadioGroup } from '@/components/arc/radio-group/radio-group'
import { SegmentedField } from '@/components/segmented-field'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { useToast } from '@/components/notifications'
import {
  describeOwed,
  FACTOR_REQUIREMENTS,
  REQUIREMENT_LABEL,
  type FactorPolicy,
  type FactorRequirement,
  type FactorScope,
  type FactorsOwed,
} from '@/lib/security/factors'
import type { Role } from '@/lib/security/roles'
import { inDisplayZone } from '@/lib/time-zone'
import { CopyField } from './mcp-setup'

/**
 * Your second factors: codes from an authenticator app, and passkeys. Shown
 * in Settings, and on the page an account is sent to when an admin requires
 * a factor it does not have yet.
 *
 * Better Auth does the work (its two-factor and passkey plugins, through
 * /api/security/me); this is the setting up, step by step.
 */

export interface MyFactors {
  username: string
  role: Role
  hasPassword: boolean
  sso: boolean
  viaSso: boolean
  twoFactor: boolean
  passkeys: { id: string; name: string; createdAt: number; synced: boolean }[]
  policy: FactorPolicy
  owes: FactorsOwed
  passkeysHere: boolean
}

const HINT = 'text-xs leading-relaxed text-muted-foreground'
const SECTION_TITLE = 'flex flex-wrap items-center gap-2 text-sm font-medium text-card-foreground'
const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: response.ok, body: await response.json().catch(() => ({})) }
}

/** Your factors as the server has them, and a way to read them again after a change. */
export function useMyFactors() {
  const [mine, setMine] = useState<MyFactors | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const { ok, body } = await send('/api/security/me', 'GET')
    if (ok) {
      setMine(body as unknown as MyFactors)
      setError(null)
    } else setError(String(body.error ?? 'ClearPing could not be reached'))
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetched on mount; state is set after the await
    void reload()
  }, [reload])
  return { mine, error, reload }
}

/** When something was added, as a date. */
function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, inDisplayZone({ dateStyle: 'medium' }))
}

/** The secret in an otpauth:// address, for typing into an app that cannot scan. */
function secretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? ''
  } catch {
    return ''
  }
}

// ─── An authenticator app ───────────────────────────────────────────────────

type AppStep =
  | { kind: 'idle' }
  | { kind: 'password'; then: 'enable' | 'disable' | 'backup-codes' }
  | { kind: 'scan'; totpURI: string; backupCodes: string[]; qr: string }
  | { kind: 'codes'; backupCodes: string[] }

function AuthenticatorApp({ mine, reload }: { mine: MyFactors; reload: () => Promise<void> }) {
  const { notify, reportError } = useToast()
  const [step, setStep] = useState<AppStep>({ kind: 'idle' })
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const withPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (step.kind !== 'password') return
    setBusy(true)
    const { ok, body } = await send('/api/security/me/two-factor', 'POST', { action: step.then, password })
    setBusy(false)
    if (!ok) return reportError('That did not work', body.error)
    setPassword('')
    if (step.then === 'enable') {
      const totpURI = String(body.totpURI)
      // Drawn here, from the address, so the secret in it never leaves this page.
      const qr = await QRCode.toString(totpURI, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      setStep({ kind: 'scan', totpURI, backupCodes: body.backupCodes as string[], qr })
    } else if (step.then === 'backup-codes') {
      setStep({ kind: 'codes', backupCodes: body.backupCodes as string[] })
    } else {
      setStep({ kind: 'idle' })
      notify({ tone: 'info', title: 'Authenticator app turned off', detail: 'Signing in asks for your password alone.' })
      await reload()
    }
  }

  const verify = async (typed: string) => {
    if (step.kind !== 'scan') return
    setBusy(true)
    const { ok, body } = await send('/api/security/me/two-factor', 'POST', { action: 'verify', code: typed })
    setBusy(false)
    if (!ok) {
      setCodeError(String(body.error ?? 'That code is not right'))
      setCode('')
      return
    }
    setCodeError(undefined)
    setCode('')
    // The backup codes work from now on: shown once, here.
    setStep({ kind: 'codes', backupCodes: step.backupCodes })
    notify({ tone: 'success', title: 'Authenticator app on', detail: 'Signing in asks for a code from it after your password.' })
    await reload()
  }

  const cancel = () => {
    setStep({ kind: 'idle' })
    setPassword('')
    setCode('')
    setCodeError(undefined)
  }

  return (
    <section className="space-y-3" aria-labelledby="factor-app">
      <h3 id="factor-app" className={SECTION_TITLE}>
        <Smartphone {...ICON} />
        Authenticator app
        <Badge size="sm" tone={mine.twoFactor ? 'success' : 'neutral'}>{mine.twoFactor ? 'On' : 'Off'}</Badge>
      </h3>
      <p className={HINT}>
        A six-digit code from an app such as 1Password, Google Authenticator or Authy, asked for after your password. Backup
        codes get you in if the phone is lost.
      </p>

      {step.kind === 'idle' && (
        <div className="flex flex-wrap gap-2">
          {mine.twoFactor ? (
            <>
              <Button type="button" size="sm" variant="secondary" onClick={() => setStep({ kind: 'password', then: 'backup-codes' })}>
                New backup codes
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setStep({ kind: 'password', then: 'disable' })}>
                Turn off
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" onClick={() => setStep({ kind: 'password', then: 'enable' })}>
              <ShieldCheck {...ICON} />
              Set up
            </Button>
          )}
        </div>
      )}

      {step.kind === 'password' && (
        <form onSubmit={withPassword} className="space-y-3">
          <div className="max-w-sm">
            <PasswordField
              label="Your password"
              description={
                step.then === 'enable'
                  ? 'To be sure it is you setting this up.'
                  : step.then === 'disable'
                    ? 'To be sure it is you turning this off.'
                    : 'The backup codes you have now stop working.'
              }
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={busy} disabled={!password}>
              {step.then === 'enable' ? 'Continue' : step.then === 'disable' ? 'Turn off' : 'Make new codes'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.kind === 'scan' && (
        <div className="space-y-4 rounded-2xl border border-border bg-background p-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-card-foreground">
            <li>Open your authenticator app and add an account.</li>
            <li>Scan this code, or type the key under it.</li>
            <li>Type the six digits the app shows.</li>
          </ol>
          <div className="flex flex-wrap items-start gap-5">
            {/* White behind it in either theme: a scanner reads dark on light. */}
            <div
              className="size-44 shrink-0 rounded-xl bg-white p-2 [&_svg]:size-full"
              role="img"
              aria-label="QR code to scan with an authenticator app"
              dangerouslySetInnerHTML={{ __html: step.qr }}
            />
            <div className="min-w-0 flex-1 space-y-4">
              <CopyField id="totp-secret" label="Key, for typing in" value={secretOf(step.totpURI)} />
              <OtpInput
                label="Code from the app"
                value={code}
                error={codeError}
                disabled={busy}
                autoFocus
                onChange={next => {
                  setCode(next)
                  if (next.length === 6) void verify(next)
                }}
              />
            </div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        </div>
      )}

      {step.kind === 'codes' && (
        <div className="space-y-3 rounded-2xl border border-border bg-background p-4">
          <Alert tone="warning" title="Keep these backup codes somewhere safe">
            Each gets you in once, in place of a code from the app. They are shown only now.
          </Alert>
          <CodeBlock code={step.backupCodes.join('\n')} filename="clearping-backup-codes.txt" language="text" />
          <Button type="button" size="sm" onClick={cancel}>
            I have kept them
          </Button>
        </div>
      )}
    </section>
  )
}

// ─── Passkeys ───────────────────────────────────────────────────────────────

function Passkeys({ mine, reload }: { mine: MyFactors; reload: () => Promise<void> }) {
  const { notify, reportError } = useToast()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const supported = typeof window !== 'undefined' && browserSupportsWebAuthn()

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const options = await send('/api/security/me/passkeys', 'POST', { step: 'options' })
      if (!options.ok) return reportError('Could not add a passkey', options.body.error)
      let response
      try {
        response = await startRegistration({ optionsJSON: options.body as never })
      } catch (error) {
        // Closing the browser's prompt is a choice, not a failure.
        if ((error as Error).name === 'NotAllowedError') return
        if ((error as Error).name === 'InvalidStateError') return reportError('This device already has a passkey for your account', '')
        return reportError('The passkey was not made', error)
      }
      const verified = await send('/api/security/me/passkeys', 'POST', { step: 'verify', response, name: name.trim() || undefined })
      if (!verified.ok) return reportError('The passkey was not added', verified.body.error)
      setName('')
      notify({ tone: 'success', title: 'Passkey added', detail: 'Use it on the sign-in page instead of your password.' })
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const { ok, body } = await send(`/api/security/me/passkeys?id=${encodeURIComponent(id)}`, 'DELETE')
    if (!ok) {
      reportError('Could not remove the passkey', body.error)
      throw new Error(String(body.error ?? 'Could not remove the passkey'))
    }
    await reload()
  }

  return (
    <section className="space-y-3" aria-labelledby="factor-passkeys">
      <h3 id="factor-passkeys" className={SECTION_TITLE}>
        <Fingerprint {...ICON} />
        Passkeys
        <Badge size="sm" tone={mine.passkeys.length > 0 ? 'success' : 'neutral'}>{mine.passkeys.length}</Badge>
      </h3>
      <p className={HINT}>
        Sign in with your fingerprint, face or device PIN, with no password or code to type. A passkey works at the
        address it was made at.
      </p>

      {mine.passkeys.length > 0 && (
        <SortableDataTable
          caption="Your passkeys"
          itemName={{ one: 'passkey', other: 'passkeys' }}
          rowKey="id"
          rows={mine.passkeys.map(each => ({ id: each.id, name: each.name, createdAt: each.createdAt, each }))}
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          columns={[
            {
              key: 'name',
              label: 'Passkey',
              render: (_, { each }) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{each.name}</span>
                  {each.synced && <Badge size="sm">Synced</Badge>}
                </span>
              ),
            },
            { key: 'createdAt', label: 'Added', render: (_, { each }) => <span className="text-muted-foreground">{when(each.createdAt)}</span> },
            {
              key: 'actions',
              label: 'Actions',
              sortable: false,
              render: (_, { each }) => (
                <ConfirmMorph
                  label="Remove"
                  icon={<Trash2 {...ICON} />}
                  prompt={`Remove ${each.name}?`}
                  confirmLabel="Remove"
                  doneLabel="Removed"
                  onConfirm={() => remove(each.id)}
                />
              ),
            },
          ]}
        />
      )}

      {!mine.passkeysHere ? (
        <Alert tone="info" title="Not at this address">
          Passkeys need ClearPing opened at a name over HTTPS, such as https://clearping.example.com, not at an address like
          192.168.1.10.
        </Alert>
      ) : !supported ? (
        <Alert tone="info" title="Not in this browser">This browser cannot make passkeys.</Alert>
      ) : (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-xs">
            <Input label="Name it (optional)" placeholder="Work laptop" value={name} onChange={event => setName(event.target.value)} />
          </div>
          {/* Lined up with the field, which is a size taller than the button. */}
          <div className="mb-1">
            <Button type="submit" size="sm" loading={busy}>
              <KeyRound {...ICON} />
              Add a passkey
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

// ─── Together ───────────────────────────────────────────────────────────────

/** Both factors, with what an admin requires said first if this account is short of it. */
export function SignInFactors({ mine, reload }: { mine: MyFactors; reload: () => Promise<void> }) {
  if (!mine.hasPassword) {
    return (
      <Alert tone="info" title="Your account signs in through single sign-on">
        Its second factor is the one your identity provider asks for, set up there.
      </Alert>
    )
  }
  return (
    <div className="space-y-8">
      {mine.owes && (
        <Alert tone="warning" title={`${describeOwed(mine.owes)} to go on`}>
          An admin requires {REQUIREMENT_LABEL[mine.policy.require].toLowerCase()} for accounts that sign in here.
        </Alert>
      )}
      <AuthenticatorApp mine={mine} reload={reload} />
      <div className="border-t border-border" />
      <Passkeys mine={mine} reload={reload} />
    </div>
  )
}

// ─── What an admin requires ─────────────────────────────────────────────────

const REQUIREMENT_DETAIL: Record<FactorRequirement, string> = {
  none: 'Second factors are each account’s own choice.',
  either: 'Each account adds whichever it prefers.',
  totp: 'A code after the password, every time.',
  passkey: 'Every account adds a passkey, which it can then sign in with on its own.',
  both: 'Both, for the most protection: the app’s code after a password, and a passkey.',
}

/** The rule an admin sets: which factors, and whose accounts. Saved as soon as it is changed. */
export function FactorPolicyForm({ policy, onChange }: { policy: FactorPolicy; onChange: (next: FactorPolicy) => void }) {
  const id = useId()
  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <div className="space-y-1">
        <h3 id={`${id}-title`} className={SECTION_TITLE}>
          <ShieldCheck {...ICON} />
          Required of accounts that sign in here
        </h3>
        <p className={HINT}>
          An account without what is required is sent to add it the next time it opens ClearPing, and can do nothing else
          until it has. Accounts signing in through single sign-on use their provider’s second factor instead.
        </p>
      </div>
      <div>
        <RadioGroup
          label="What every account must have"
          name={`${id}-require`}
          value={policy.require}
          onValueChange={value => onChange({ ...policy, require: value as FactorRequirement })}
          options={FACTOR_REQUIREMENTS.map(each => ({ value: each, label: REQUIREMENT_LABEL[each], description: REQUIREMENT_DETAIL[each] }))}
        />
      </div>
      {policy.require !== 'none' && (
        <SegmentedField
          label="Whose accounts"
          value={policy.appliesTo}
          onValueChange={value => onChange({ ...policy, appliesTo: value as FactorScope })}
          options={[
            { value: 'others', label: 'Editors and viewers' },
            { value: 'everyone', label: 'Everyone, admins too' },
          ]}
        />
      )}
    </section>
  )
}
