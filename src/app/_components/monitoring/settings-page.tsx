'use client'

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Bot, Fingerprint, History, KeyRound, LogIn, LogOut, ShieldAlert, ShieldCheck, Trash2, User, UserPlus, Users, Wrench, type LucideIcon } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { PasswordField } from '@/components/arc/password-field/password-field'
import { RadioGroup } from '@/components/arc/radio-group/radio-group'
import { SegmentedField } from '@/components/segmented-field'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { Switch } from '@/components/arc/switch/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/arc/tabs/tabs'
import { Timeline } from '@/components/arc/timeline/timeline'
import { useToast } from '@/components/notifications'
import type { SettingsSection } from '@/lib/dashboard-pages'
import { canAdminister, DEFAULT_NEW_ROLE, maxKeyAccess, ROLE_DETAIL, ROLE_LABEL, ROLES, type Role } from '@/lib/security/roles'
import type { FactorPolicy } from '@/lib/security/factors'
import { cn } from '@/lib/utils'
import { FactorPolicyForm, SignInFactors, useMyFactors } from '../security/sign-in-factors'
import { MaintenanceTab } from './maintenance-tab'
import { AssistantSettings, CopyField, PAGE_CARD } from './mcp-setup'
import { PANE, PANE_ACTIONS, PANE_HEADER, PANE_TITLE } from './pane-layout'

/**
 * Who may use this ClearPing, and what they have done.
 *
 * Sign-in for the dashboard and its API, keys for scripts and AI assistants
 * (one each, able to read or to read and change), the accounts, and the
 * record of every change and whose it was. Everything here is changed signed
 * in, whether or not the dashboard asks for it.
 */

type Access = 'read' | 'write'

interface ApiKey {
  id: string
  name: string
  prefix: string
  access: Access
  createdAt: number
  createdBy: string | null
  ownerId: string | null
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
  role: Role
  twoFactor: boolean
  passkeys: number
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
  signOutAtProvider: boolean
  adminGroup: string
  editorGroup: string
  newAccountRole: Role
}

interface Security {
  me: Account
  settings: { loginRequired: boolean; mcpKeyRequired: boolean; passwordLogin: boolean }
  factorPolicy: FactorPolicy
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

const HINT = 'text-xs leading-relaxed text-muted-foreground'
const SECTION_TITLE = 'text-sm font-medium text-card-foreground'
const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

const ROLE_OPTIONS = ROLES.map(role => ({ value: role, label: ROLE_LABEL[role] }))

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

/** A setting that takes effect at once: its title and what it does, with the switch that says which way it is. */
function SettingSwitch({
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
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5 pt-2.5">
        <p id={`${id}-title`} className="text-sm font-medium text-card-foreground">{label}</p>
        <div id={`${id}-detail`} className={HINT}>{detail}</div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-detail`}
      />
    </div>
  )
}

/**
 * A role chosen in a table row. The column's heading is what the field is
 * called on screen; the field's own label, which names the account, is there
 * for a screen reader.
 */
function RowRoleSelect({ label, value, onChange, disabled }: { label: string; value: Role; onChange: (role: Role) => void; disabled?: boolean }) {
  return (
    <div className="w-36 [&_label]:sr-only">
      <Select label={label} value={value} disabled={disabled} onValueChange={next => onChange(next as Role)} options={ROLE_OPTIONS} />
    </div>
  )
}

function AccessTab({ data, onChange }: { data: Security; onChange: (changes: Partial<Security['settings']>) => void }) {
  const { settings, inForce, environment } = data
  return (
    <div className="space-y-5">
      {environment.recovery && (
        <Alert tone="warning" title="CLEARPING_AUTH=off is set where ClearPing runs">
          Sign-in is not asked for whatever the switch below says, and a new account can be made from the sign-in page.
          Remove it once you are back in.
        </Alert>
      )}

      <SettingSwitch
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

      <SettingSwitch
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

      <Alert tone="info" title="Changed signed in, always">
        Changes to these settings, to keys and to accounts are always made signed in, even while the dashboard does not
        ask for it. Locked out? Start ClearPing with CLEARPING_AUTH=off to turn sign-in off and make a new account.
      </Alert>
    </div>
  )
}

/**
 * Your second factors, and for an admin, which of them every account must
 * have. A rule that would apply to the admin setting it is only taken once
 * their own account meets it.
 */
function SignInTab({ data, reload }: { data: Security; reload: () => void }) {
  const { notify, reportError } = useToast()
  const { mine, error, reload: reloadMine } = useMyFactors()
  const [policy, setPolicy] = useState(data.factorPolicy)

  const changePolicy = async (next: FactorPolicy) => {
    const before = policy
    setPolicy(next)
    const { ok, body } = await send('/api/security', 'PUT', { factorPolicy: next })
    if (!ok) {
      setPolicy(before)
      return reportError('Could not change what is required', body.error)
    }
    notify({ tone: 'success', title: 'Saved', detail: 'Accounts without it are asked to add it the next time they open ClearPing.' })
    reload()
  }

  return (
    <div className="space-y-8">
      {error && <Alert tone="danger" title="Could not load your second factors">{error}</Alert>}
      {!mine && !error && <Skeleton label="Loading your second factors" lines={4} />}
      {mine && <SignInFactors mine={mine} reload={reloadMine} />}
      {canAdminister(data.me.role) && (
        <>
          <div className="border-t border-border" />
          <FactorPolicyForm policy={policy} onChange={changePolicy} />
        </>
      )}
    </div>
  )
}

function KeysTab({ data, reload }: { data: Security; reload: () => void }) {
  const { reportError } = useToast()
  const admin = canAdminister(data.me.role)
  // A key does no more than the account that made it may.
  const mayWrite = maxKeyAccess(data.me.role) === 'write'
  const roleOf = (id: string | null) => (id === data.me.id ? data.me.role : data.users.find(user => user.id === id)?.role)
  const [name, setName] = useState('')
  const [access, setAccess] = useState<Access>('read')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<{ key: string; name: string; access: Access } | null>(null)

  const make = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/keys', 'POST', { name: name.trim(), access })
    setBusy(false)
    if (!ok) return reportError('Could not create the key', body.error)
    setMade({ key: String(body.key), name: name.trim(), access })
    setName('')
    reload()
  }

  const revoke = async (key: ApiKey) => {
    const { ok, body } = await send(`/api/security/keys/${key.id}`, 'DELETE')
    if (!ok) {
      reportError('Could not revoke the key', body.error)
      throw new Error(String(body.error ?? 'Could not revoke the key'))
    }
    reload()
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin

  const rows = data.keys.map(key => ({ ...key, key }))

  return (
    <div className="space-y-6">
      {made && (
        <div className="space-y-3">
          <Alert tone="success" title={`The key for ${made.name}`}>
            Copy it now: it is not kept, and cannot be shown again.
          </Alert>
          <CopyField id="new-key" label="Key" value={made.key} />
          <CodeBlock
            filename="For Claude Code"
            language="bash"
            code={`claude mcp add --transport http clearping ${origin}/api/mcp --header "Authorization: Bearer ${made.key}"`}
          />
          <CodeBlock filename="For a script" language="bash" code={`curl -H "Authorization: Bearer ${made.key}" ${origin}/api/targets`} />
          <Button type="button" size="sm" variant="secondary" onClick={() => setMade(null)}>
            Done, I have copied it
          </Button>
        </div>
      )}

      <form onSubmit={make} className="space-y-3">
        <div className="space-y-1">
          <p className={SECTION_TITLE}>Create a key</p>
          <p className={HINT}>
            One for each script or assistant, so each can be cut off alone and the activity record says which did what.
            A key is yours, and never does more than your account may: if your role changes, so does what your keys can do.
          </p>
        </div>
        <Input
          label="Name"
          placeholder="Claude, ChatGPT, Home Assistant…"
          value={name}
          maxLength={60}
          onChange={event => setName(event.target.value)}
        />
        {mayWrite ? (
          <SegmentedField
            label="What it may do"
            value={access}
            onValueChange={value => setAccess(value as Access)}
            options={[
              { value: 'read', label: 'Read only' },
              { value: 'write', label: 'Read and change' },
            ]}
          />
        ) : (
          <p className={HINT}>Your account is a {ROLE_LABEL[data.me.role]}, so its keys can only read.</p>
        )}
        {/* On a line of its own: a button is inline, and sat beside the control above. */}
        <div>
          <Button type="submit" loading={busy} disabled={!name.trim()}>
            <KeyRound {...ICON} />
            Create key
          </Button>
        </div>
      </form>

      <SortableDataTable
        caption={admin ? 'Every key' : 'Your keys'}
        emptyMessage="No keys yet"
        itemName={{ one: 'key', other: 'keys' }}
        rows={rows}
        rowKey="id"
        defaultSort={{ key: 'createdAt', direction: 'desc' }}
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (_, { key }) => (
              <span className={cn('flex flex-col gap-1', key.revokedAt && 'opacity-60')}>
                <span className="font-medium">{key.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{key.prefix}…</span>
              </span>
            ),
          },
          {
            key: 'access',
            label: 'May',
            render: (_, { key }) => {
              const makerRole = roleOf(key.ownerId)
              const capped = key.access === 'write' && !key.revokedAt && makerRole && maxKeyAccess(makerRole) === 'read'
              return (
                <span className="flex flex-col items-start gap-1">
                  <Badge tone={key.revokedAt ? 'danger' : key.access === 'write' ? 'warning' : 'neutral'} size="sm">
                    {key.revokedAt ? 'Revoked' : key.access === 'write' ? 'Read and change' : 'Read only'}
                  </Badge>
                  {capped && (
                    <span className="text-xs text-muted-foreground">
                      Only reads while {key.createdBy ?? 'its maker'} is a {ROLE_LABEL[makerRole]}
                    </span>
                  )}
                </span>
              )
            },
          },
          {
            key: 'createdAt',
            label: 'Made',
            numeric: false,
            render: (_, { key }) => (
              <span className="text-muted-foreground">
                {when(key.createdAt)}
                {key.createdBy ? ` by ${key.createdBy}` : ''}
              </span>
            ),
          },
          {
            key: 'lastUsedAt',
            label: 'Last used',
            numeric: false,
            render: (_, { key }) => <span className="text-muted-foreground">{when(key.lastUsedAt)}</span>,
          },
          {
            key: 'actions',
            label: 'Actions',
            sortable: false,
            render: (_, { key }) =>
              key.revokedAt ? (
                <span className="text-xs text-muted-foreground">Revoked {when(key.revokedAt)}</span>
              ) : (
                <ConfirmMorph
                  label="Revoke"
                  icon={<Trash2 {...ICON} />}
                  prompt={`Revoke ${key.name}?`}
                  confirmLabel="Revoke"
                  doneLabel="Revoked"
                  onConfirm={() => revoke(key)}
                />
              ),
          },
        ]}
      />
    </div>
  )
}

function AccountsTab({ data, reload }: { data: Security; reload: () => void }) {
  const { notify, reportError } = useToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>(DEFAULT_NEW_ROLE)
  const [busy, setBusy] = useState<'add' | 'password' | 'role' | null>(null)
  const admin = canAdminister(data.me.role)

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('add')
    const { ok, body } = await send('/api/security/users', 'POST', { username: username.trim(), password, role })
    setBusy(null)
    if (!ok) return reportError('Could not add the account', body.error)
    notify({ tone: 'success', title: `Added ${username.trim()}`, detail: `As ${ROLE_LABEL[role]}` })
    setUsername('')
    setPassword('')
    setRole(DEFAULT_NEW_ROLE)
    reload()
  }

  const changeRole = async (account: Account, next: Role) => {
    setBusy('role')
    const { ok, body } = await send(`/api/security/users/${account.id}`, 'PATCH', { role: next })
    setBusy(null)
    if (!ok) return reportError(`Could not make ${account.username} a${next === 'admin' ? 'n' : ''} ${ROLE_LABEL[next]}`, body.error)
    // Your own role, changed: what this page may show you has changed with it.
    if (account.id === data.me.id && next !== 'admin') window.location.reload()
    else reload()
  }

  const remove = async (account: Account) => {
    const { ok, body } = await send(`/api/security/users/${account.id}`, 'DELETE')
    if (!ok) {
      reportError('Could not remove the account', body.error)
      throw new Error(String(body.error ?? 'Could not remove the account'))
    }
    reload()
  }

  if (!admin) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <p className={SECTION_TITLE}>Your account</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-card-foreground">
            <span className="font-medium">{data.me.username}</span>
            <Badge size="sm">{ROLE_LABEL[data.me.role]}</Badge>
          </p>
          <p className={HINT}>{ROLE_DETAIL[data.me.role]} An admin can change your role.</p>
        </div>
        {data.me.hasPassword && <PasswordForm busy={busy} setBusy={setBusy} />}
      </div>
    )
  }

  const rows = data.users.map(account => ({
    id: account.id,
    username: account.username,
    lastLoginAt: account.lastLoginAt ?? 0,
    role: account.role,
    account,
  }))

  return (
    <div className="space-y-8">
      <SortableDataTable
        caption="Accounts"
        itemName={{ one: 'account', other: 'accounts' }}
        rows={rows}
        rowKey="id"
        defaultSort={{ key: 'username', direction: 'asc' }}
        columns={[
          {
            key: 'username',
            label: 'Account',
            render: (_, { account }) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{account.username}</span>
                {account.id === data.me.id && <span className="text-muted-foreground">(you)</span>}
                {account.sso && <Badge size="sm">{data.sso.label}</Badge>}
              </span>
            ),
          },
          {
            key: 'factors',
            label: 'Second factors',
            sortable: false,
            render: (_, { account }) =>
              account.twoFactor || account.passkeys > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {account.twoFactor && <Badge size="sm" tone="success">App</Badge>}
                  {account.passkeys > 0 && (
                    <Badge size="sm" tone="success">{account.passkeys === 1 ? 'Passkey' : `${account.passkeys} passkeys`}</Badge>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">{account.hasPassword ? 'None' : 'Through the provider'}</span>
              ),
          },
          {
            key: 'lastLoginAt',
            label: 'Last signed in',
            numeric: false,
            render: (_, { account }) => <span className="text-muted-foreground">{when(account.lastLoginAt)}</span>,
          },
          {
            key: 'role',
            label: 'Role',
            render: (_, { account }) => (
              <RowRoleSelect
                label={`What ${account.username} may do`}
                value={account.role}
                disabled={busy !== null}
                onChange={next => changeRole(account, next)}
              />
            ),
          },
          {
            key: 'actions',
            label: 'Actions',
            sortable: false,
            render: (_, { account }) =>
              account.id === data.me.id ? null : (
                <ConfirmMorph
                  label="Remove"
                  icon={<Trash2 {...ICON} />}
                  prompt={`Remove ${account.username}?`}
                  confirmLabel="Remove"
                  doneLabel="Removed"
                  onConfirm={() => remove(account)}
                />
              ),
          },
        ]}
      />
      <p className={HINT}>
        There is always at least one admin: the last cannot be removed or made anything else. Roles matter once sign-in
        is on (Access): with it off, anyone who can reach ClearPing can change anything without signing in.
      </p>

      <form onSubmit={add} className="space-y-4">
        <p className={SECTION_TITLE}>Add an account</p>
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Input label="Username" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} />
          <PasswordField
            label="Password"
            description="10 characters or more"
            autoComplete="new-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
        </div>
        {/* In a box of its own: the group sets its own margin to none, which
            would take away the space the form puts under it. */}
        <div>
          <RadioGroup
            label="What the account may do"
            name="new-account-role"
            value={role}
            onValueChange={value => setRole(value as Role)}
            options={ROLES.map(option => ({ value: option, label: ROLE_LABEL[option], description: ROLE_DETAIL[option] }))}
          />
        </div>
        <Button type="submit" loading={busy === 'add'} disabled={busy !== null || !username.trim() || !password}>
          <UserPlus {...ICON} />
          Add account
        </Button>
      </form>

      {data.me.hasPassword && <PasswordForm busy={busy} setBusy={setBusy} />}
    </div>
  )
}

/** Changing your own password, which signs you out everywhere else. */
function PasswordForm<Busy extends string>({ busy, setBusy }: { busy: Busy | null; setBusy: (busy: Busy | 'password' | null) => void }) {
  const { notify, reportError } = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')

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

  return (
    <form onSubmit={changePassword} className="space-y-4">
      <p className={SECTION_TITLE}>Change your password</p>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} />
        <PasswordField label="New password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} />
      </div>
      <Button type="submit" variant="secondary" loading={busy === 'password'} disabled={(busy !== null && busy !== 'password') || !current || !next}>
        Change password
      </Button>
    </form>
  )
}

/** Linking your own account to the provider: all of single sign-on that is anyone's but an admin's. */
function SsoLink({ data, reload }: { data: Security; reload: () => void }) {
  const { reportError } = useToast()
  const unlink = async () => {
    const { ok, body } = await send('/api/security/sso/link', 'DELETE')
    if (!ok) {
      reportError('Could not unlink', body.error)
      throw new Error(String(body.error ?? 'Could not unlink'))
    }
    reload()
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-sm text-card-foreground">
        {data.me.sso ? `Your account signs in with ${data.sso.label}.` : `Your account is not linked to ${data.sso.label} yet.`}
      </p>
      {data.me.sso
        ? data.me.hasPassword && (
            <ConfirmMorph label="Unlink" prompt={`Unlink from ${data.sso.label}?`} confirmLabel="Unlink" doneLabel="Unlinked" onConfirm={unlink} />
          )
        : data.sso.enabled && (
            // A full load, not a fetch: linking goes out to the provider and back.
            <Button
              type="button"
              size="sm"
              variant="secondary"
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a route that redirects out to the provider, not a page
              onClick={() => { window.location.href = '/api/auth/sso/start?link=1' }}
            >
              Link my account
            </Button>
          )}
    </div>
  )
}

function SsoTab({ data, reload }: { data: Security; reload: () => void }) {
  if (!canAdminister(data.me.role)) {
    return (
      <div className="space-y-3">
        <p className={HINT}>Link your account to sign in to ClearPing through {data.sso.label} instead of with a password.</p>
        <SsoLink data={data} reload={reload} />
      </div>
    )
  }
  return <SsoSettingsForm data={data} reload={reload} />
}

function SsoSettingsForm({ data, reload }: { data: Security; reload: () => void }) {
  const { notify, reportError } = useToast()
  const saved = data.sso
  const [form, setForm] = useState({
    label: saved.label,
    issuer: saved.issuer,
    clientId: saved.clientId,
    clientSecret: '',
    allowedGroup: saved.allowedGroup,
    autoCreate: saved.autoCreate,
    signOutAtProvider: saved.signOutAtProvider,
    adminGroup: saved.adminGroup,
    editorGroup: saved.editorGroup,
    newAccountRole: saved.newAccountRole,
  })
  const [busy, setBusy] = useState<'save' | 'test' | 'toggle' | null>(null)
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (field: keyof typeof form) => (value: string | boolean) => setForm(previous => ({ ...previous, [field]: value }))

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const redirectUri = `${origin}/api/auth/sso/callback`
  const logoutUri = `${origin}/api/auth/sso/logout`
  const afterLogoutUri = `${origin}/login`
  const configured = !!saved.issuer && !!saved.clientId && saved.clientSecretSet
  const usable = saved.enabled && configured
  const savedElsewhere = saved.redirectUri && saved.redirectUri !== redirectUri
  const groupsDecide = !!(form.adminGroup.trim() || form.editorGroup.trim())

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

  const changePasswordLogin = async (on: boolean) => {
    const { ok, body } = await send('/api/security', 'PUT', { passwordLogin: on })
    if (!ok) return reportError('Could not change password sign-in', body.error)
    reload()
  }

  const passwordLocked = data.settings.passwordLogin && !(usable && data.me.sso)

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="text-sm leading-relaxed text-card-foreground">
          Sign in with Authentik, or any OpenID Connect provider. In Authentik:{' '}
          <span className="font-medium">Applications → Providers → Create → OAuth2/OpenID Provider</span>, client type{' '}
          <span className="font-medium">Confidential</span>, with this redirect URI and a{' '}
          <span className="font-medium">Signing Key</span> (the self-signed certificate will do: sign-in checks
          Authentik&apos;s signature with it); then an application for it. The issuer is on the provider&apos;s page:{' '}
          <span className="font-mono">https://&lt;authentik&gt;/application/o/&lt;slug&gt;/</span>.
        </p>
        <CopyField id="sso-redirect" label="Redirect URI" value={redirectUri} />
        {savedElsewhere && (
          <p className={HINT}>
            Saved from another address ({saved.redirectUri}). Saving here changes it to the one above, which then has to
            be the one in Authentik.
          </p>
        )}
        <p className="text-sm leading-relaxed text-card-foreground">
          To be signed out here when you sign out of Authentik, set the provider&apos;s{' '}
          <span className="font-medium">Logout URI</span> to this, with the logout method{' '}
          <span className="font-medium">Back-channel</span> (Authentik 2025.8 or later):
        </p>
        <CopyField id="sso-logout" label="Logout URI" value={logoutUri} />
        <p className="text-sm leading-relaxed text-card-foreground">
          And to come back to the sign-in page after signing out, add this to its{' '}
          <span className="font-medium">Post logout redirect URIs</span>:
        </p>
        <CopyField id="sso-after-logout" label="Post logout redirect URI" value={afterLogoutUri} />
      </div>

      <form
        onSubmit={event => {
          event.preventDefault()
          void save(form, 'save')
        }}
        className="space-y-6"
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Input
            label="Issuer"
            placeholder="https://auth.example.com/application/o/clearping/"
            value={form.issuer}
            onChange={event => set('issuer')(event.target.value)}
          />
          <Input label="Name on the button" placeholder="Authentik" value={form.label} maxLength={40} onChange={event => set('label')(event.target.value)} />
          <Input label="Client ID" autoComplete="off" value={form.clientId} onChange={event => set('clientId')(event.target.value)} />
          <PasswordField
            label="Client secret"
            autoComplete="new-password"
            description={saved.clientSecretSet ? 'Saved. Leave it empty to keep it.' : undefined}
            value={form.clientSecret}
            onChange={event => set('clientSecret')(event.target.value)}
          />
          <div className="sm:col-span-2">
            <Input
              label="Only members of this group (optional)"
              placeholder="clearping-users"
              description="Left empty, anyone the provider lets through to this application can sign in."
              value={form.allowedGroup}
              onChange={event => set('allowedGroup')(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <p className={SECTION_TITLE}>Roles from groups</p>
            <p className={HINT}>
              Name a group at {form.label || 'the provider'} for each role, and every sign-in through it sets the
              account&apos;s role from the person&apos;s groups: in the admin group, an admin; in the editor group, an
              editor; in neither, a viewer. Left empty, roles are set here, in Accounts. The last admin is never made
              anything else this way.
            </p>
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Input label="Admins: members of" placeholder="clearping-admins" value={form.adminGroup} onChange={event => set('adminGroup')(event.target.value)} />
            <Input label="Editors: members of" placeholder="clearping-editors" value={form.editorGroup} onChange={event => set('editorGroup')(event.target.value)} />
          </div>
          <div className="max-w-sm">
            <Select
              label="An account made at its first sign-in starts as"
              description={groupsDecide ? 'Its groups decide.' : undefined}
              value={form.newAccountRole}
              disabled={groupsDecide}
              onValueChange={value => setForm(previous => ({ ...previous, newAccountRole: value as Role }))}
              options={ROLE_OPTIONS}
            />
          </div>
        </div>

        <SettingSwitch
          checked={form.autoCreate}
          onChange={on => set('autoCreate')(on)}
          label="Make an account on first sign-in"
          detail="Off: only accounts already linked can sign in this way."
        />

        <SettingSwitch
          checked={form.signOutAtProvider}
          onChange={on => set('signOutAtProvider')(on)}
          label={`Signing out here signs out of ${form.label || 'the provider'} too`}
          detail="For sessions signed in through it. Whether that ends only this application's session there or the whole Authentik session is the provider's invalidation flow: default-invalidation-flow logs out of Authentik."
        />

        {tested && <Alert tone={tested.ok ? 'success' : 'danger'} title={tested.ok ? 'The issuer answered' : 'The issuer did not answer'}>{tested.text}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy === 'save'} disabled={busy !== null && busy !== 'save'}>
            Save single sign-on
          </Button>
          <Button type="button" variant="secondary" loading={busy === 'test'} disabled={(busy !== null && busy !== 'test') || !form.issuer} onClick={test}>
            Test the issuer
          </Button>
        </div>
      </form>

      <div className="space-y-5 border-t border-border pt-6">
        <SettingSwitch
          checked={saved.enabled}
          disabled={busy !== null || (!saved.enabled && !configured)}
          onChange={on => save({ enabled: on }, 'toggle')}
          label={`Sign in with ${saved.label}`}
          detail={configured ? 'Shows the button on the sign-in page.' : 'Save an issuer, client ID and client secret first.'}
        />

        <SsoLink data={{ ...data, sso: { ...data.sso, enabled: usable } }} reload={reload} />

        <SettingSwitch
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
  'key.create': 'created a key',
  'key.revoke': 'revoked a key',
  'account.create': 'created the account',
  'account.add': 'added an account',
  'account.remove': 'removed an account',
  'account.password': 'changed their password',
  'account.2fa.enable': 'turned on their authenticator app',
  'account.2fa.disable': 'turned off their authenticator app',
  'account.2fa.codes': 'made new backup codes',
  'account.passkey.add': 'added a passkey',
  'account.passkey.remove': 'removed a passkey',
  'security.factors': 'changed the second factors required',
  'security.on': 'turned on',
  'security.off': 'turned off',
  'sso.change': 'changed single sign-on',
  'account.sso.link': 'linked their account',
  'account.sso.unlink': 'unlinked their account',
  signin: 'signed in',
  'signin.failed': 'failed to sign in',
  signout: 'was signed out',
  'mcp.add_targets': 'added targets',
  'mcp.update_target': 'changed a target',
  'mcp.set_target_paused': 'paused or resumed a target',
  'mcp.probe_now': 'probed a target',
  'mcp.run_traceroute': 'traced a route',
  'maintenance.run': 'ran maintenance',
  'maintenance.settings': 'changed the maintenance schedule',
}

const VIA: Record<ActivityEntry['via'], string> = { dashboard: 'dashboard', api: 'API', mcp: 'MCP' }

function ActivityTab() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [more, setMore] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // What "today" and "2 hours ago" are counted from: when the record was read.
  const [now, setNow] = useState(0)

  const load = useCallback(async (before?: number) => {
    const { ok, body } = await send(`/api/security/activity?limit=50${before ? `&before=${before}` : ''}`, 'GET')
    if (!ok) return setError(String(body.error ?? 'Could not load the activity'))
    const page = (body.entries as ActivityEntry[]) ?? []
    setEntries(previous => (before && previous ? [...previous, ...page] : page))
    setMore(page.length === 50)
    setNow(Date.now())
  }, [])

  useEffect(() => {
    // Loaded when the tab opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (error) return <Alert tone="danger" title="Could not load the activity">{error}</Alert>
  if (!entries) return <Skeleton label="Loading the activity" lines={4} />
  if (entries.length === 0) {
    return <EmptyState icon={<History size={24} strokeWidth={1.75} />} title="Nothing yet" description="Changes appear here as they are made." />
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <div className="space-y-3">
      <Timeline
        label="Activity"
        now={now}
        timeZone={timeZone}
        locale={typeof navigator === 'undefined' ? 'en-US' : navigator.language}
        maxHeight={560}
        scrollToNew={false}
        events={entries.map(entry => ({
          id: String(entry.id),
          at: entry.at,
          actor: entry.actor.kind === 'key' ? `Key ${entry.actor.name}` : entry.actor.name,
          title: `${ACTIONS[entry.action] ?? entry.action}${entry.detail ? `: ${entry.detail}` : ''}`,
          meta: VIA[entry.via] ?? entry.via,
          tone: entry.action === 'signin.failed' ? 'danger' : 'neutral',
          icon: entry.action === 'signin.failed' ? <ShieldAlert {...ICON} /> : entry.actor.kind === 'key' ? <KeyRound {...ICON} /> : <User {...ICON} />,
        }))}
      />
      {more && (
        <Button type="button" size="sm" variant="secondary" onClick={() => load(entries.at(-1)?.id)}>
          Show older activity
        </Button>
      )}
    </div>
  )
}

/** The sections of Settings, Security's first. */
const SECTIONS: { value: SettingsSection; label: string; icon: LucideIcon; adminOnly?: boolean }[] = [
  { value: 'access', label: 'Access', icon: ShieldCheck, adminOnly: true },
  { value: 'sign-in', label: 'Sign-in', icon: Fingerprint },
  { value: 'keys', label: 'Keys', icon: KeyRound },
  { value: 'sso', label: 'Single sign-on', icon: LogIn },
  { value: 'accounts', label: 'Accounts', icon: Users },
  { value: 'activity', label: 'Activity', icon: History, adminOnly: true },
  { value: 'maintenance', label: 'Maintenance', icon: Wrench, adminOnly: true },
  { value: 'assistant', label: 'AI assistant', icon: Bot },
]

interface SettingsPageProps {
  /** The section on screen, which is part of the address: /settings/keys and so on. */
  section: SettingsSection
  onSection: (section: SettingsSection) => void
}

/**
 * The dashboard's Settings page, at /settings: who may get in, keys,
 * single sign-on, accounts, the activity record, and connecting an AI
 * assistant, each a tab of its own.
 */
export function SettingsPage({ section, onSection }: SettingsPageProps) {
  const { reportError } = useToast()
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
    const { body } = await send('/api/auth/logout', 'POST')
    // A full load, not a client-side move: nothing the signed-in page held
    // in memory should outlive signing out. Signed in through the identity
    // provider, on to sign out there too; it comes back to the sign-in page.
    const providerSignOut = typeof body?.redirect === 'string' && /^https?:\/\//.test(body.redirect) ? body.redirect : null
    window.location.href = providerSignOut ?? new URL('/login', window.location.href).href
  }

  const here = typeof window === 'undefined' ? '/' : window.location.pathname

  // An admin is shown every section. Anyone else, what is theirs: their keys,
  // their account, linking it to single sign-on where that is on, and the
  // assistant setup. Until it is known who this is, every section.
  const me = loaded.state === 'ready' ? loaded.data.me : null
  const sections = SECTIONS.filter(
    item =>
      !me ||
      canAdminister(me.role) ||
      (!item.adminOnly && (item.value !== 'sso' || (loaded.state === 'ready' && loaded.data.sso.enabled)))
  ).map(item => (item.value === 'accounts' && me && !canAdminister(me.role) ? { ...item, label: 'Your account' } : item))
  const current = sections.find(item => item.value === section) ?? sections[0]

  return (
    // Settings read best at the width of a form, not of a monitor: the whole
    // page, header and all, is kept to it, so the header lines up with the rest.
    <div className={cn(PANE, 'max-w-6xl')}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Settings</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Who may open this ClearPing, keys for scripts and AI assistants, and a record of every change and who made it.
          </p>
        </div>
        {loaded.state === 'ready' && (
          <div className={PANE_ACTIONS}>
            <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <span className="truncate">
                Signed in as <span className="font-medium text-foreground">{loaded.data.me.username}</span>
              </span>
              <Badge size="sm">{ROLE_LABEL[loaded.data.me.role]}</Badge>
            </p>
            <Button type="button" size="sm" variant="secondary" onClick={signOut}>
              <LogOut {...ICON} />
              Sign out
            </Button>
          </div>
        )}
      </header>

      <Tabs value={current.value} onValueChange={value => onSection(value as SettingsSection)}>
        <TabsList aria-label="Settings">
          {sections.map(item => {
            const Icon = item.icon
            return (
              <TabsTrigger key={item.value} value={item.value}>
                <span className="inline-flex items-center gap-2">
                  <Icon {...ICON} />
                  {item.label}
                </span>
              </TabsTrigger>
            )
          })}
        </TabsList>

        <TabsContent value={current.value}>
          {current.value === 'assistant' ? (
            <AssistantSettings onMakeKey={() => onSection('keys')} />
          ) : (
            <>
              {loaded.state === 'loading' && <Skeleton label="Loading the settings" lines={5} />}

              {loaded.state === 'failed' && <Alert tone="danger" title="Could not load the settings">{loaded.error}</Alert>}

              {(loaded.state === 'needsAccount' || loaded.state === 'needsSignIn') && (
                <EmptyState
                  icon={<ShieldCheck size={24} strokeWidth={1.75} />}
                  title={loaded.state === 'needsAccount' ? 'No account yet' : 'Sign in to change these'}
                  description={
                    loaded.state === 'needsAccount'
                      ? 'Security is set up with an account: it is what turns sign-in on, creates keys, and is the name changes are recorded under.'
                      : 'Security settings are changed signed in.'
                  }
                  action={
                    <Button
                      type="button"
                      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- the sign-in page is its own app shell; a full load, as signing in is
                      onClick={() => { window.location.href = `/login?next=${encodeURIComponent(here)}` }}
                    >
                      {loaded.state === 'needsAccount' ? 'Create an account' : 'Sign in'}
                    </Button>
                  }
                />
              )}

              {loaded.state === 'ready' && (
                <div className={PAGE_CARD}>
                  {current.value === 'access' && <AccessTab data={loaded.data} onChange={change} />}
                  {current.value === 'sign-in' && <SignInTab data={loaded.data} reload={reload} />}
                  {current.value === 'keys' && <KeysTab data={loaded.data} reload={reload} />}
                  {current.value === 'sso' && <SsoTab data={loaded.data} reload={reload} />}
                  {current.value === 'accounts' && <AccountsTab data={loaded.data} reload={reload} />}
                  {current.value === 'activity' && <ActivityTab />}
                  {current.value === 'maintenance' && <MaintenanceTab />}
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
