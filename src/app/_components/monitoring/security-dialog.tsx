'use client'

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Bot, KeyRound, Loader2, LogOut, ShieldCheck, User, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { CopyField } from './mcp-dialog'

/**
 * Who may use this ClearPing, and what they have done.
 *
 * Sign-in for the dashboard and its API, keys for scripts and AI assistants
 * (one each, able to read or to read and change), the accounts, and the
 * record of every change and whose it was. Everything here is changed signed
 * in, whether or not the dashboard asks for it.
 */

type Access = 'read' | 'write'
type Tab = 'access' | 'keys' | 'sso' | 'accounts' | 'activity'

interface ApiKey {
  id: string
  name: string
  prefix: string
  access: Access
  createdAt: number
  createdBy: string | null
  lastUsedAt: number | null
  revokedAt: number | null
}

interface Account {
  id: string
  username: string
  createdAt: number
  lastLoginAt: number | null
  sso: boolean
  hasPassword: boolean
}

interface SsoSettings {
  enabled: boolean
  label: string
  issuer: string
  clientId: string
  clientSecretSet: boolean
  allowedGroup: string
  autoCreate: boolean
  redirectUri: string
}

interface Security {
  me: Account
  settings: { loginRequired: boolean; mcpKeyRequired: boolean; passwordLogin: boolean }
  sso: SsoSettings
  inForce: { loginRequired: boolean; mcpKeyRequired: boolean }
  environment: { recovery: boolean; legacyMcpToken: boolean }
  users: Account[]
  keys: ApiKey[]
}

interface ActivityEntry {
  id: number
  at: number
  actor: { kind: 'user' | 'key' | 'anonymous'; id: string | null; name: string }
  via: 'dashboard' | 'api' | 'mcp'
  action: string
  detail: string | null
}

type Loaded =
  | { state: 'loading' }
  | { state: 'needsAccount' }
  | { state: 'needsSignIn' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; data: Security }

const HINT = 'text-[11px] leading-relaxed text-muted-foreground'
const SECTION_TITLE = 'text-xs font-semibold text-card-foreground'

const TABS: { value: Tab; label: string }[] = [
  { value: 'access', label: 'Access' },
  { value: 'keys', label: 'Keys' },
  { value: 'sso', label: 'SSO' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'activity', label: 'Activity' },
]

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'
}

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: response.ok, body: await response.json().catch(() => ({})) }
}

/** On or off, said as a switch. */
function Toggle({
  checked,
  disabled,
  onChange,
  label,
  detail,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  label: string
  detail: ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
          checked ? 'border-primary bg-primary' : 'border-border bg-muted'
        )}
      >
        <span
          className={cn(
            'inline-block size-3.5 rounded-full bg-background shadow transition-transform',
            checked ? 'translate-x-4.5' : 'translate-x-0.5'
          )}
        />
      </button>
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-medium text-card-foreground">{label}</p>
        <div className={HINT}>{detail}</div>
      </div>
    </div>
  )
}

/** A button that asks to be pressed again before it does anything that cannot be undone. */
function ConfirmButton({ children, confirm, onConfirm }: { children: ReactNode; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const disarm = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(disarm)
  }, [armed])

  return (
    <Button
      type="button"
      size="sm"
      variant={armed ? 'destructive' : 'outline'}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
    >
      {armed ? confirm : children}
    </Button>
  )
}

function AccessTab({ data, onChange }: { data: Security; onChange: (changes: Partial<Security['settings']>) => void }) {
  const { settings, inForce, environment } = data
  return (
    <div className="space-y-5">
      {environment.recovery && (
        <p className="rounded-md border border-signal-minor/40 bg-signal-minor/10 px-3 py-2 text-xs leading-relaxed text-foreground">
          <span className="font-mono">CLEARPING_AUTH=off</span> is set where ClearPing runs, so sign-in is not asked
          for whatever the switch below says, and a new account can be made from the sign-in page. Remove it once you
          are back in.
        </p>
      )}

      <Toggle
        checked={settings.loginRequired}
        onChange={on => onChange({ loginRequired: on })}
        label="Require sign-in for the dashboard and API"
        detail={
          <>
            Anyone opening ClearPing has to sign in, and the API answers only to someone signed in or a script sending
            a key (<span className="font-mono">Authorization: Bearer &lt;key&gt;</span>). Leave it off if ClearPing is
            only on your own network, or already behind a sign-in such as Authentik.
          </>
        }
      />

      <Toggle
        checked={inForce.mcpKeyRequired}
        disabled={inForce.loginRequired || environment.legacyMcpToken}
        onChange={on => onChange({ mcpKeyRequired: on })}
        label="Require a key for AI assistants (MCP)"
        detail={
          inForce.loginRequired ? (
            'On, because sign-in is on: an open MCP address would hand out what sign-in protects.'
          ) : environment.legacyMcpToken ? (
            <>
              On, because <span className="font-mono">CLEARPING_MCP_TOKEN</span> is set where ClearPing runs. That
              token still works, as a key that can change things; keys made here are better, one per assistant.
            </>
          ) : (
            'Off: an assistant without a key can read, but never change anything. On: every assistant needs a key, even to read.'
          )
        }
      />

      <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
        <p className={HINT}>
          Changes to these settings, to keys and to accounts are always made signed in, even while the dashboard does
          not ask for it. Locked out? Start ClearPing with <span className="font-mono">CLEARPING_AUTH=off</span> to
          turn sign-in off and make a new account.
        </p>
      </div>
    </div>
  )
}

function KeysTab({ data, reload }: { data: Security; reload: () => void }) {
  const { reportError } = useToast()
  const [name, setName] = useState('')
  const [access, setAccess] = useState<Access>('read')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<{ key: string; name: string; access: Access } | null>(null)

  const make = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/keys', 'POST', { name: name.trim(), access })
    setBusy(false)
    if (!ok) return reportError('Could not make the key', body.error)
    setMade({ key: String(body.key), name: name.trim(), access })
    setName('')
    reload()
  }

  const revoke = async (key: ApiKey) => {
    const { ok, body } = await send(`/api/security/keys/${key.id}`, 'DELETE')
    if (!ok) return reportError('Could not revoke the key', body.error)
    reload()
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <div className="space-y-5">
      {made && (
        <div className="space-y-3 rounded-lg border border-signal-perfect/40 bg-signal-perfect/5 p-3">
          <p className="text-xs font-medium text-card-foreground">
            The key for {made.name}. Copy it now: it is not kept, and cannot be shown again.
          </p>
          <CopyField id="new-key" label="Key" value={made.key} />
          <CopyField
            id="new-key-mcp"
            label="For Claude Code"
            value={`claude mcp add --transport http clearping ${origin}/api/mcp --header "Authorization: Bearer ${made.key}"`}
          />
          <CopyField
            id="new-key-curl"
            label="For a script"
            value={`curl -H "Authorization: Bearer ${made.key}" ${origin}/api/targets`}
          />
          <Button type="button" size="sm" variant="outline" onClick={() => setMade(null)}>
            Done
          </Button>
        </div>
      )}

      <form onSubmit={make} className="space-y-3">
        <p className={SECTION_TITLE}>Make a key</p>
        <p className={HINT}>
          One for each script or assistant, so each can be cut off alone and the activity record says which did what.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="key-name" className="text-xs text-card-foreground">Name</Label>
            <Input
              id="key-name"
              placeholder="Claude, ChatGPT, Home Assistant…"
              value={name}
              maxLength={60}
              onChange={event => setName(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5" role="radiogroup" aria-label="What it may do">
            {(['read', 'write'] as const).map(option => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={access === option}
                onClick={() => setAccess(option)}
                className={cn(
                  'cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs outline-none transition-colors',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  access === option ? 'bg-primary font-medium text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {option === 'read' ? 'Read only' : 'Read and change'}
              </button>
            ))}
          </div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Make key
          </Button>
        </div>
      </form>

      <div className="space-y-2">
        <p className={SECTION_TITLE}>Keys</p>
        {data.keys.length === 0 ? (
          <p className={HINT}>None yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.keys.map(key => (
              <li key={key.id} className={cn('flex items-center gap-3 px-3 py-2.5', key.revokedAt && 'opacity-55')}>
                <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-card-foreground">
                    <span className="truncate">{key.name}</span>
                    <span
                      className={cn(
                        'rounded border px-1 py-px text-[10px] font-normal leading-none',
                        key.access === 'write' ? 'border-signal-minor/50 text-signal-minor' : 'border-border text-muted-foreground'
                      )}
                    >
                      {key.access === 'write' ? 'read and change' : 'read only'}
                    </span>
                    {key.revokedAt && <span className="text-[10px] font-normal text-destructive">revoked {when(key.revokedAt)}</span>}
                  </p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {key.prefix}… · made {when(key.createdAt)}
                    {key.createdBy ? ` by ${key.createdBy}` : ''} · last used {when(key.lastUsedAt)}
                  </p>
                </div>
                {!key.revokedAt && (
                  <ConfirmButton confirm="Revoke it" onConfirm={() => revoke(key)}>
                    Revoke
                  </ConfirmButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function AccountsTab({ data, reload }: { data: Security; reload: () => void }) {
  const { notify, reportError } = useToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState<'add' | 'password' | null>(null)

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('add')
    const { ok, body } = await send('/api/security/users', 'POST', { username: username.trim(), password })
    setBusy(null)
    if (!ok) return reportError('Could not add the account', body.error)
    notify({ tone: 'success', title: `Added ${username.trim()}` })
    setUsername('')
    setPassword('')
    reload()
  }

  const changePassword = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('password')
    const { ok, body } = await send('/api/security/password', 'PUT', { current, password: next })
    setBusy(null)
    if (!ok) return reportError('Could not change the password', body.error)
    notify({ tone: 'success', title: 'Password changed', detail: 'You have been signed out everywhere else.' })
    setCurrent('')
    setNext('')
  }

  const remove = async (account: Account) => {
    const { ok, body } = await send(`/api/security/users/${account.id}`, 'DELETE')
    if (!ok) return reportError('Could not remove the account', body.error)
    reload()
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className={SECTION_TITLE}>Accounts</p>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.users.map(account => (
            <li key={account.id} className="flex items-center gap-3 px-3 py-2.5">
              <User className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-card-foreground">
                  {account.username}
                  {account.id === data.me.id && <span className="font-normal text-muted-foreground"> (you)</span>}
                  {account.sso && (
                    <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] font-normal text-muted-foreground">
                      {data.sso.label}
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground">Last signed in {when(account.lastLoginAt)}</p>
              </div>
              {account.id !== data.me.id && (
                <ConfirmButton confirm="Remove it" onConfirm={() => remove(account)}>
                  Remove
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={add} className="space-y-2">
        <p className={SECTION_TITLE}>Add an account</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input aria-label="Username" placeholder="Username" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} />
          <Input aria-label="Password" placeholder="Password, 10 characters or more" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} />
          <Button type="submit" disabled={busy !== null || !username.trim() || !password}>
            {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Add
          </Button>
        </div>
        <p className={HINT}>Every account can do everything, these settings included.</p>
      </form>

      {data.me.hasPassword && <form onSubmit={changePassword} className="space-y-2">
        <p className={SECTION_TITLE}>Change your password</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input aria-label="Current password" placeholder="Current password" type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} />
          <Input aria-label="New password" placeholder="New password" type="password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} />
          <Button type="submit" variant="outline" disabled={busy !== null || !current || !next}>
            {busy === 'password' && <Loader2 className="h-4 w-4 animate-spin" />}
            Change
          </Button>
        </div>
      </form>}
    </div>
  )
}

const SSO_FIELD = 'space-y-1.5'

function SsoTab({ data, reload }: { data: Security; reload: () => void }) {
  const { notify, reportError } = useToast()
  const saved = data.sso
  const [form, setForm] = useState({
    label: saved.label,
    issuer: saved.issuer,
    clientId: saved.clientId,
    clientSecret: '',
    allowedGroup: saved.allowedGroup,
    autoCreate: saved.autoCreate,
  })
  const [busy, setBusy] = useState<'save' | 'test' | 'toggle' | null>(null)
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (field: keyof typeof form) => (value: string | boolean) => setForm(previous => ({ ...previous, [field]: value }))

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const redirectUri = `${origin}/api/auth/sso/callback`
  const configured = !!saved.issuer && !!saved.clientId && saved.clientSecretSet
  const usable = saved.enabled && configured
  const savedElsewhere = saved.redirectUri && saved.redirectUri !== redirectUri

  const save = async (changes: Record<string, unknown>, what: 'save' | 'toggle') => {
    setBusy(what)
    const { ok, body } = await send('/api/security/sso', 'PUT', changes)
    setBusy(null)
    if (!ok) return reportError('Could not save single sign-on', body.error)
    if (what === 'save') notify({ tone: 'success', title: 'Single sign-on saved' })
    setForm(previous => ({ ...previous, clientSecret: '' }))
    reload()
  }

  const test = async () => {
    setBusy('test')
    const { body } = await send('/api/security/sso/test', 'POST', { issuer: form.issuer })
    setBusy(null)
    setTested(body.ok ? { ok: true, text: `Found ${body.issuer}` } : { ok: false, text: String(body.error ?? 'Could not reach it') })
  }

  const unlink = async () => {
    const { ok, body } = await send('/api/security/sso/link', 'DELETE')
    if (!ok) return reportError('Could not unlink', body.error)
    reload()
  }

  const changePasswordLogin = async (on: boolean) => {
    const { ok, body } = await send('/api/security', 'PUT', { passwordLogin: on })
    if (!ok) return reportError('Could not change password sign-in', body.error)
    reload()
  }

  const passwordLocked = data.settings.passwordLogin && !(usable && data.me.sso)

  return (
    <div className="space-y-5">
      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
        <p className="text-xs leading-relaxed text-card-foreground">
          Sign in with Authentik, or any OpenID Connect provider. In Authentik:{' '}
          <span className="font-medium">Applications → Providers → Create → OAuth2/OpenID Provider</span>, client type{' '}
          <span className="font-medium">Confidential</span>, with this redirect URI; then an application for it. The
          issuer is on the provider&apos;s page: <span className="font-mono">https://&lt;authentik&gt;/application/o/&lt;slug&gt;/</span>.
        </p>
        <CopyField id="sso-redirect" label="Redirect URI" value={redirectUri} />
        {savedElsewhere && (
          <p className={HINT}>
            Saved from another address ({saved.redirectUri}). Saving here changes it to the one above, which then has to
            be the one in Authentik.
          </p>
        )}
      </div>

      <form
        onSubmit={event => {
          event.preventDefault()
          void save(form, 'save')
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={SSO_FIELD}>
            <Label htmlFor="sso-issuer" className="text-xs text-card-foreground">Issuer</Label>
            <Input
              id="sso-issuer"
              placeholder="https://auth.example.com/application/o/clearping/"
              value={form.issuer}
              onChange={event => set('issuer')(event.target.value)}
            />
          </div>
          <div className={SSO_FIELD}>
            <Label htmlFor="sso-label" className="text-xs text-card-foreground">Name on the button</Label>
            <Input id="sso-label" placeholder="Authentik" value={form.label} maxLength={40} onChange={event => set('label')(event.target.value)} />
          </div>
          <div className={SSO_FIELD}>
            <Label htmlFor="sso-client" className="text-xs text-card-foreground">Client ID</Label>
            <Input id="sso-client" autoComplete="off" value={form.clientId} onChange={event => set('clientId')(event.target.value)} />
          </div>
          <div className={SSO_FIELD}>
            <Label htmlFor="sso-secret" className="text-xs text-card-foreground">Client secret</Label>
            <Input
              id="sso-secret"
              type="password"
              autoComplete="new-password"
              placeholder={saved.clientSecretSet ? 'Saved; leave empty to keep it' : ''}
              value={form.clientSecret}
              onChange={event => set('clientSecret')(event.target.value)}
            />
          </div>
          <div className={cn(SSO_FIELD, 'sm:col-span-2')}>
            <Label htmlFor="sso-group" className="text-xs text-card-foreground">Only members of this group (optional)</Label>
            <Input id="sso-group" placeholder="clearping-users" value={form.allowedGroup} onChange={event => set('allowedGroup')(event.target.value)} />
            <p className={HINT}>
              Every account here can do everything, these settings included, so keep it to the people who should. Left
              empty, anyone the provider lets through to this application can sign in.
            </p>
          </div>
        </div>

        <Toggle
          checked={form.autoCreate}
          onChange={on => set('autoCreate')(on)}
          label="Make an account on first sign-in"
          detail="Off: only accounts already linked can sign in this way."
        />

        {tested && (
          <p className={cn('text-xs', tested.ok ? 'text-signal-perfect' : 'text-destructive')} role="status">
            {tested.text}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy !== null}>
            {busy === 'save' && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
          <Button type="button" variant="outline" disabled={busy !== null || !form.issuer} onClick={test}>
            {busy === 'test' && <Loader2 className="h-4 w-4 animate-spin" />}
            Test the issuer
          </Button>
        </div>
      </form>

      <div className="space-y-4 border-t border-border pt-4">
        <Toggle
          checked={saved.enabled}
          disabled={busy !== null || (!saved.enabled && !configured)}
          onChange={on => save({ enabled: on }, 'toggle')}
          label={`Sign in with ${saved.label}`}
          detail={configured ? 'Shows the button on the sign-in page.' : 'Save an issuer, client ID and client secret first.'}
        />

        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-xs text-card-foreground">
            {data.me.sso ? `Your account signs in with ${saved.label}.` : `Your account is not linked to ${saved.label} yet.`}
          </p>
          {data.me.sso
            ? data.me.hasPassword && (
                <ConfirmButton confirm="Unlink it" onConfirm={unlink}>
                  Unlink
                </ConfirmButton>
              )
            : usable && (
                <Button asChild size="sm" variant="outline">
                  <a href="/api/auth/sso/start?link=1">Link my account</a>
                </Button>
              )}
        </div>

        <Toggle
          checked={data.settings.passwordLogin}
          disabled={passwordLocked}
          onChange={changePasswordLogin}
          label="Allow signing in with a password"
          detail={
            passwordLocked
              ? `Can be turned off once ${saved.label} sign-in is on and your own account is linked to it.`
              : `Off: ${saved.label} is the only way in. CLEARPING_AUTH=off turns passwords back on if it ever fails.`
          }
        />
      </div>
    </div>
  )
}


const ACTIONS: Record<string, string> = {
  'target.add': 'added a target',
  'target.import': 'imported targets',
  'target.change': 'changed a target',
  'target.pause': 'paused a target',
  'target.resume': 'resumed a target',
  'target.delete': 'deleted targets',
  'group.add': 'made a group',
  'group.move': 'renamed a group',
  'group.delete': 'deleted a group',
  'alert.add': 'made an alert',
  'alert.change': 'changed an alert',
  'alert.delete': 'deleted an alert',
  'key.create': 'made a key',
  'key.revoke': 'revoked a key',
  'account.create': 'created the account',
  'account.add': 'added an account',
  'account.remove': 'removed an account',
  'account.password': 'changed their password',
  'security.on': 'turned on',
  'security.off': 'turned off',
  'sso.change': 'changed single sign-on',
  'account.sso.link': 'linked their account',
  'account.sso.unlink': 'unlinked their account',
  signin: 'signed in',
  'signin.failed': 'failed to sign in',
  'mcp.add_targets': 'added targets',
  'mcp.update_target': 'changed a target',
  'mcp.set_target_paused': 'paused or resumed a target',
  'mcp.probe_now': 'probed a target',
  'mcp.run_traceroute': 'traced a route',
}

const VIA: Record<ActivityEntry['via'], string> = { dashboard: 'dashboard', api: 'API', mcp: 'MCP' }

function ActivityTab() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [more, setMore] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (before?: number) => {
    const { ok, body } = await send(`/api/security/activity?limit=50${before ? `&before=${before}` : ''}`, 'GET')
    if (!ok) return setError(String(body.error ?? 'Could not load the activity'))
    const page = (body.entries as ActivityEntry[]) ?? []
    setEntries(previous => (before && previous ? [...previous, ...page] : page))
    setMore(page.length === 50)
  }, [])

  useEffect(() => {
    // Loaded when the tab opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (!entries) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  if (entries.length === 0) return <p className={HINT}>Nothing yet. Changes appear here as they are made.</p>

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {entries.map(entry => (
          <li key={entry.id} className="space-y-0.5 px-3 py-2">
            <p className="text-xs text-card-foreground">
              <span
                className={cn(
                  'font-medium',
                  entry.actor.kind === 'key' && 'text-primary',
                  entry.action === 'signin.failed' && 'text-destructive'
                )}
              >
                {entry.actor.kind === 'key' ? `🔑 ${entry.actor.name}` : entry.actor.name}
              </span>{' '}
              {ACTIONS[entry.action] ?? entry.action}
              {entry.detail && <span className="text-muted-foreground">: {entry.detail}</span>}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {when(entry.at)} · {VIA[entry.via] ?? entry.via}
            </p>
          </li>
        ))}
      </ul>
      {more && (
        <Button type="button" size="sm" variant="outline" onClick={() => load(entries.at(-1)?.id)}>
          Older
        </Button>
      )}
    </div>
  )
}

function SecurityBody({ initialTab }: { initialTab: Tab }) {
  const { reportError } = useToast()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })

  const reload = useCallback(async () => {
    const response = await fetch('/api/security').catch(() => null)
    const body = await response?.json().catch(() => ({}))
    if (response?.ok) setLoaded({ state: 'ready', data: body as Security })
    else if (body?.needsAccount) setLoaded({ state: 'needsAccount' })
    else if (body?.needsSignIn) setLoaded({ state: 'needsSignIn' })
    else setLoaded({ state: 'failed', error: body?.error ?? 'ClearPing could not be reached' })
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  const change = async (changes: Partial<Security['settings']>) => {
    const { ok, body } = await send('/api/security', 'PUT', changes)
    if (!ok) return reportError('Could not change the setting', body.error)
    await reload()
  }

  const signOut = async () => {
    await send('/api/auth/logout', 'POST')
    // A full load, not a client-side move: nothing the signed-in page held
    // in memory should outlive signing out.
    window.location.href = new URL('/login', window.location.href).href
  }

  const here = typeof window === 'undefined' ? '/' : window.location.pathname

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-card-foreground">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <ShieldCheck className="h-4 w-4 text-primary" />
          </div>
          Security
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          Who may open this ClearPing, keys for scripts and AI assistants, and a record of every change and who made it.
        </DialogDescription>
      </DialogHeader>

      {loaded.state === 'loading' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

      {loaded.state === 'failed' && <p className="text-xs text-destructive">{loaded.error}</p>}

      {(loaded.state === 'needsAccount' || loaded.state === 'needsSignIn') && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <p className="text-xs leading-relaxed text-card-foreground">
            {loaded.state === 'needsAccount'
              ? 'Security is set up with an account: it is what turns sign-in on, makes keys, and is the name changes are recorded under. There is none yet.'
              : 'Security settings are changed signed in.'}
          </p>
          <Button asChild size="sm">
            <a href={`/login?next=${encodeURIComponent(here)}`}>{loaded.state === 'needsAccount' ? 'Create an account' : 'Sign in'}</a>
          </Button>
        </div>
      )}

      {loaded.state === 'ready' && (
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
            <User className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 truncate text-xs text-card-foreground">
              Signed in as <span className="font-medium">{loaded.data.me.username}</span>
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={signOut}>
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>

          <div className="grid grid-cols-5 gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5" role="tablist" aria-label="Security">
            {TABS.map(option => (
              <button
                key={option.value}
                type="button"
                role="tab"
                id={`security-tab-${option.value}`}
                aria-selected={tab === option.value}
                aria-controls={`security-panel-${option.value}`}
                onClick={() => setTab(option.value)}
                className={cn(
                  'cursor-pointer rounded-md px-2 py-1.5 text-xs outline-none transition-colors touch:py-2.5',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  tab === option.value ? 'bg-primary font-medium text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`security-panel-${tab}`} aria-labelledby={`security-tab-${tab}`}>
            {tab === 'access' && <AccessTab data={loaded.data} onChange={change} />}
            {tab === 'keys' && <KeysTab data={loaded.data} reload={reload} />}
            {tab === 'sso' && <SsoTab data={loaded.data} reload={reload} />}
            {tab === 'accounts' && <AccountsTab data={loaded.data} reload={reload} />}
            {tab === 'activity' && <ActivityTab />}
          </div>
        </div>
      )}
    </>
  )
}

interface SecurityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which tab it opens on. */
  tab?: Tab
}

export function SecurityDialog({ open, onOpenChange, tab = 'access' }: SecurityDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto border-border bg-card sm:max-w-2xl" suppressHydrationWarning>
        <SecurityBody initialTab={tab} />
      </DialogContent>
    </Dialog>
  )
}
