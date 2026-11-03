'use client'

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Bot, EyeOff, Fingerprint, History, KeyRound, LogIn, LogOut, Network, RadioTower, RefreshCw, ShieldAlert, ShieldCheck, Trash2, User, Users, Wrench, type LucideIcon } from 'lucide-react'
import { Accordion } from '@/components/arc/accordion/accordion'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Input } from '@/components/arc/input/input'
import { PasswordField } from '@/components/arc/password-field/password-field'
import { SegmentedField } from '@/components/segmented-field'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { Switch } from '@/components/arc/switch/switch'
import { TagInput } from '@/components/arc/tag-input/tag-input'
import { Timeline } from '@/components/arc/timeline/timeline'
import { useToast } from '@/components/notifications'
import type { SettingsSection } from '@/lib/dashboard-pages'
import { describeTimeLeft, KEY_LIFETIMES } from '@/lib/security/key-lifetime'
import { canAdminister, maxKeyAccess, ROLE_DETAIL, ROLE_LABEL, ROLES, type Role } from '@/lib/security/roles'
import type { FactorPolicy } from '@/lib/security/factors'
import { cn } from '@/lib/utils'
import { FactorPolicyForm, SignInFactors, useMyFactors } from './sign-in-factors'
import { MaintenanceTab } from './maintenance-tab'
import { PrivacyTab } from './privacy-tab'
import { ProbeAgentsTab } from './probe-agents-tab'
import { RoutingTab } from './routing-tab'
import { AddAccount } from './add-account'
import { PasswordDialog } from './password-dialog'
import { AssistantSettings, CopyField, PAGE_CARD } from './mcp-setup'
import { notifySecurityChanged } from '../dashboard/security-changed'
import { PANE, PANE_ACTIONS, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import { displayLocale, displayTimeZone, inDisplayZone } from '@/lib/time-zone'

/**
 * Who may use this ClearPing, and what they have done.
 *
 * Sign-in for the dashboard and its API, keys for scripts and AI assistants
 * (one each, able to read or to read and write), the accounts, and the
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
  expiresAt: number | null
  expiresInDays: number | null
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
  /** The first account, which owns the install: always an admin, never removed, its password its own. */
  primary: boolean
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
  settings: { loginRequired: boolean; mcpKeyRequired: boolean; passwordLogin: boolean; changesNeedSignIn: boolean; corsOrigins: string[] }
  factorPolicy: FactorPolicy
  sso: SsoSettings
  inForce: { loginRequired: boolean; mcpKeyRequired: boolean; changesNeedSignIn: boolean }
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
  return ms ? new Date(ms).toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' })) : 'never'
}

/** Past the time it was made to stop, and not already revoked. */
function keyExpired(key: ApiKey): boolean {
  return key.revokedAt === null && key.expiresAt !== null && key.expiresAt <= Date.now()
}

function keyQuiet(key: ApiKey): boolean {
  return key.revokedAt !== null || keyExpired(key)
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
    <div className="relative w-36 [&_label]:sr-only">
      <Select label={label} value={value} disabled={disabled} onValueChange={next => onChange(next as Role)} options={ROLE_OPTIONS} />
    </div>
  )
}

/**
 * The websites whose pages may call the API from a browser. A list that is
 * saved as a whole, since half an address is not one the server will take.
 */
function CorsOrigins({ saved, reload }: { saved: string[]; reload: () => void }) {
  const { notify, reportError } = useToast()
  const [origins, setOrigins] = useState(saved)
  const [busy, setBusy] = useState(false)
  const unchanged = origins.length === saved.length && origins.every((origin, index) => origin === saved[index])

  const save = async () => {
    setBusy(true)
    const { ok, body } = await send('/api/security', 'PUT', { corsOrigins: origins })
    setBusy(false)
    if (!ok) return reportError('Could not save the websites', body.error)
    setOrigins(Array.isArray(body.corsOrigins) ? (body.corsOrigins as string[]) : origins)
    notify({ tone: 'success', title: 'Saved' })
    reload()
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className={SECTION_TITLE}>Websites that may call the API</p>
        <p className={HINT}>
          A browser only lets a page read ClearPing&apos;s API if ClearPing says that page may. List the address of a web
          page of your own (such as <span className="font-mono">https://home.example.com</span>) that should be able to,
          and nothing else can. Such a page has to send a key: it is never taken for a signed-in account. Scripts and AI
          assistants are not browsers and need nothing here.
        </p>
      </div>
      <TagInput
        label="Allowed websites"
        value={origins}
        onValueChange={setOrigins}
        placeholder="https://home.example.com"
        description="Press Enter after each address. The site alone, with no path. No wildcards."
      />
      <div>
        <Button type="button" loading={busy} disabled={unchanged} onClick={save}>
          Save websites
        </Button>
      </div>
    </div>
  )
}

function AccessTab({ data, onChange, reload }: { data: Security; onChange: (changes: Partial<Security['settings']>) => void; reload: () => void }) {
  const { settings, inForce, environment } = data
  return (
    <div className="space-y-5">
      {environment.recovery && (
        <Alert tone="warning" title="CLEARPING_AUTH=off is set where ClearPing runs">
          Sign-in is off whatever the switch below says, and anyone can make an account from the sign-in page. Remove it
          once you are back in.
        </Alert>
      )}

      <SettingSwitch
        checked={settings.loginRequired}
        onChange={on => onChange({ loginRequired: on })}
        label="Require sign-in for the dashboard and API"
        detail={
          <>
            Everyone has to sign in to see ClearPing, and the API only answers someone signed in or a script with a key
            (<span className="font-mono">Authorization: Bearer &lt;key&gt;</span>), even to read. Leave it off if
            ClearPing is only reachable on your own network, or already sits behind a sign-in such as Authentik. The
            dashboard and the API are one: there is no way to hide the API&apos;s data and show it on the dashboard.
          </>
        }
      />

      <SettingSwitch
        checked={inForce.changesNeedSignIn}
        disabled={inForce.loginRequired}
        onChange={on => onChange({ changesNeedSignIn: on })}
        label="Require sign-in or a key to change anything"
        detail={
          inForce.loginRequired ? (
            'On, because sign-in is on.'
          ) : (
            <>
              Anyone can still look, but adding, editing, pausing, probing and deleting need an account that may change
              things, or a key that can write (<span className="font-mono">Authorization: Bearer &lt;key&gt;</span>).
              Off, anyone who can reach ClearPing can change it. Keys that only read never change anything either way.
            </>
          )
        }
      />

      <SettingSwitch
        checked={inForce.mcpKeyRequired}
        disabled={inForce.loginRequired || environment.legacyMcpToken}
        onChange={on => onChange({ mcpKeyRequired: on })}
        label="Require a key for AI assistants (MCP)"
        detail={
          inForce.loginRequired ? (
            'On, because sign-in is on: without a key, the MCP address would give away what sign-in protects.'
          ) : environment.legacyMcpToken ? (
            <>
              On, because <span className="font-mono">CLEARPING_MCP_TOKEN</span> is set where ClearPing runs. That
              token still works and can change things. Keys made here are better: one per assistant.
            </>
          ) : (
            'Off: assistants without a key can read but not change anything. On: every assistant needs a key, even to read.'
          )
        }
      />

      <CorsOrigins key={settings.corsOrigins.join(' ')} saved={settings.corsOrigins} reload={reload} />

      <Alert tone="info" title="Changing these always needs a sign-in">
        These settings, keys and accounts can only be changed signed in, even while the dashboard itself is open to
        everyone. Locked out? Start ClearPing with CLEARPING_AUTH=off, which turns sign-in off so you can make a new account.
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

/** Re-roll and Revoke. The row only opens a dialog, so the question never has to fit in the cell. */
function KeyActions({ apiKey, onAsk }: { apiKey: ApiKey; onAsk: (action: 'reroll' | 'revoke') => void }) {
  if (apiKey.revokedAt) return <span className="text-xs text-muted-foreground">Revoked {when(apiKey.revokedAt)}</span>
  return (
    <span className="flex items-center justify-end gap-1">
      <Button type="button" variant="ghost" size="sm" onClick={() => onAsk('reroll')}>
        <RefreshCw {...ICON} />
        Re-roll
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onAsk('revoke')}>
        <Trash2 {...ICON} />
        Revoke
      </Button>
    </span>
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
  // How long it lasts, as the days in the list or 'never'.
  const [lasts, setLasts] = useState('never')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<{ key: string; name: string; expiresAt: number | null; rerolled: boolean } | null>(null)
  const [ask, setAsk] = useState<{ key: ApiKey; action: 'reroll' | 'revoke' } | null>(null)
  // Kept after close so the dialog can finish leaving with the same question.
  const [held, setHeld] = useState(ask)
  if (ask && ask !== held) setHeld(ask)
  const view = ask ?? held
  const [acting, setActing] = useState(false)

  const make = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { ok, body } = await send('/api/security/keys', 'POST', {
      name: name.trim(),
      access,
      expiresInDays: lasts === 'never' ? null : Number(lasts),
    })
    setBusy(false)
    if (!ok) return reportError('Could not create the key', body.error)
    setMade({ key: String(body.key), name: name.trim(), expiresAt: (body.record as ApiKey).expiresAt, rerolled: false })
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

  // A new key in place of this one, lasting as long as it was made to; this one stops at once.
  const reroll = async (key: ApiKey) => {
    const { ok, body } = await send(`/api/security/keys/${key.id}/reroll`, 'POST')
    if (!ok) {
      reportError('Could not re-roll the key', body.error)
      throw new Error(String(body.error ?? 'Could not re-roll the key'))
    }
    setMade({ key: String(body.key), name: key.name, expiresAt: (body.record as ApiKey).expiresAt, rerolled: true })
    reload()
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin

  const rows = data.keys.map(key => ({ ...key, key }))

  return (
    <div className="space-y-6">
      {made && (
        <div className="space-y-3">
          <Alert tone="success" title={`${made.rerolled ? 'The new key for' : 'The key for'} ${made.name}`}>
            Copy it now: it is not kept, and cannot be shown again.
            {made.rerolled && ' The key it replaces has stopped working, so update whatever used it.'}
            {made.expiresAt ? ` It works until ${when(made.expiresAt)}.` : ' It does not expire.'}
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

      <form noValidate onSubmit={make} className="space-y-3">
        <div className="space-y-1">
          <p className={SECTION_TITLE}>Create a key</p>
          <p className={HINT}>
            Make one per script or assistant, so you can revoke each on its own and Activity shows which did what. Choose
            how long it lasts. Re-roll replaces one and shows the new key once; the old one stops at once. A key can
            never do more than your account can: if your role changes, so do your keys.
          </p>
        </div>
        <Input
          label="Name"
          required
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
              { value: 'write', label: 'Read and write' },
            ]}
          />
        ) : (
          <p className={HINT}>Your account is a {ROLE_LABEL[data.me.role]}, so its keys can only read.</p>
        )}
        <div className="relative max-w-xs">
          <Select
            label="Expires"
            value={lasts}
            onValueChange={setLasts}
            options={KEY_LIFETIMES.map(each => ({ value: each.days === null ? 'never' : String(each.days), label: each.label }))}
          />
        </div>
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
              <span className={cn('flex flex-col gap-1', keyQuiet(key) && 'opacity-60')}>
                <span className="font-medium">{key.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{key.prefix}…</span>
              </span>
            ),
          },
          {
            key: 'access',
            label: 'Access',
            render: (_, { key }) => {
              const makerRole = roleOf(key.ownerId)
              const expired = keyExpired(key)
              const capped = key.access === 'write' && !key.revokedAt && !expired && makerRole && maxKeyAccess(makerRole) === 'read'
              return (
                <span className="flex flex-col items-start gap-1">
                  <Badge tone={key.revokedAt || expired ? 'danger' : key.access === 'write' ? 'warning' : 'neutral'} size="sm">
                    {key.revokedAt ? 'Revoked' : expired ? 'Expired' : key.access === 'write' ? 'Read and write' : 'Read only'}
                  </Badge>
                  {expired && (
                    <span className="text-xs text-muted-foreground">Was {key.access === 'write' ? 'read and write' : 'read only'}</span>
                  )}
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
            label: 'Created',
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
            key: 'expiresAt',
            label: 'Expires',
            numeric: false,
            render: (_, { key }) => {
              if (!key.expiresAt) return <span className="text-muted-foreground">{key.revokedAt ? '—' : 'No expiry'}</span>
              const over = key.expiresAt <= Date.now()
              return (
                <span className="flex flex-col gap-0.5">
                  <span className={over && !key.revokedAt ? 'text-destructive' : 'text-muted-foreground'}>{when(key.expiresAt)}</span>
                  {!key.revokedAt && <span className="text-xs text-muted-foreground">{describeTimeLeft(key.expiresAt)}</span>}
                </span>
              )
            },
          },
          {
            key: 'actions',
            label: 'Actions',
            sortable: false,
            render: (_, { key }) => <KeyActions apiKey={key} onAsk={action => setAsk({ key, action })} />,
          },
        ]}
      />
      <Dialog open={ask !== null} onOpenChange={open => { if (!open && !acting) setAsk(null) }}>
        {view && (
          <DialogContent
            title={view.action === 'reroll' ? `Re-roll ${view.key.name}?` : `Revoke ${view.key.name}?`}
            description={
              view.action === 'reroll'
                ? 'A new key is shown once, with the same name, level and lifetime. This one stops working at once.'
                : 'It stops working at once. It stays in the list, marked revoked, so past activity still names it.'
            }
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="secondary" disabled={acting} onClick={() => setAsk(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant={view.action === 'revoke' ? 'danger' : 'primary'}
                loading={acting}
                onClick={() => {
                  const pending = view
                  setActing(true)
                  void (async () => {
                    try {
                      if (pending.action === 'reroll') await reroll(pending.key)
                      else await revoke(pending.key)
                      setAsk(null)
                    } catch {
                      // Already reported. The dialog stays open.
                    } finally {
                      setActing(false)
                    }
                  })()
                }}
              >
                {view.action === 'reroll' ? <RefreshCw {...ICON} /> : <Trash2 {...ICON} />}
                {view.action === 'reroll' ? 'Re-roll' : 'Revoke'}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

function AccountsTab({ data, reload }: { data: Security; reload: () => void }) {
  const { reportError } = useToast()
  const [busy, setBusy] = useState<'password' | 'role' | null>(null)
  // The account whose password an admin is seeing to, while the dialog is open.
  const [passwordFor, setPasswordFor] = useState<Account | null>(null)
  const admin = canAdminister(data.me.role)

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
      <AddAccount onAdded={reload} />

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
                {account.primary && <Badge size="sm" tone="info">Primary</Badge>}
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
                <span className="text-muted-foreground">{account.hasPassword ? 'None' : `Through ${data.sso.label}`}</span>
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
            render: (_, { account }) =>
              // The primary account is always an admin: there is nothing to choose.
              account.primary ? (
                <span className="text-muted-foreground">{ROLE_LABEL.admin}</span>
              ) : (
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
            // Not your own account, and never the primary one: its owner looks after it.
            render: (_, { account }) =>
              account.id === data.me.id || account.primary ? null : (
                <span className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setPasswordFor(account)}>
                    <KeyRound {...ICON} />
                    Password
                  </Button>
                  <ConfirmMorph
                    label="Remove"
                    icon={<Trash2 {...ICON} />}
                    prompt={`Remove ${account.username}?`}
                    confirmLabel="Remove"
                    doneLabel="Removed"
                    onConfirm={() => remove(account)}
                  />
                </span>
              ),
          },
        ]}
      />
      <p className={HINT}>
        <span className="font-medium text-card-foreground">Primary</span> is the first account made: always an admin,
        never removed, and only its owner changes its password (if lost, the sign-in page resets it with a code from the
        server log). For anyone else, use Password to set a new one or send them a link to choose their own. Roles only
        apply while sign-in is on under Access.
      </p>
      <PasswordDialog account={passwordFor} onClose={() => setPasswordFor(null)} onDone={reload} />

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
    <form noValidate onSubmit={changePassword} className="space-y-4">
      <p className={SECTION_TITLE}>Change your password</p>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <PasswordField label="Current password" required autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} />
        <PasswordField label="New password" required autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} />
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

  const label = form.label || 'Authentik'
  const guides = [
    {
      title: 'Authentik',
      content: (
        <ol className="space-y-5">
          <Step number={1} title="Start with the application">
            <p className={STEP_TEXT}>
              In Authentik admin, open <Path>Applications → Applications</Path> and click <Path>New Application</Path>.
              If the button has a menu, choose <Path>with New Provider</Path>. The wizard makes the application and the
              provider together.
            </p>
          </Step>
          <Step number={2} title="Name it">
            <p className={STEP_TEXT}>
              Name it ClearPing. The slug is the last part of the issuer, such as <span className="font-mono">clear-ping</span>.
              Continue.
            </p>
          </Step>
          <Step number={3} title="Choose OAuth2/OIDC">
            <p className={STEP_TEXT}>On <Path>Choose a Provider</Path>, pick <Path>OAuth2/OIDC</Path>.</p>
          </Step>
          <Step number={4} title="Configure the provider">
            <dl className="divide-y divide-border rounded-2xl border border-border">
              <ProviderSetting name="Client type">
                <span className="font-medium">Confidential</span>
              </ProviderSetting>
              <ProviderSetting name="Redirect URIs">
                <p className="text-sm">
                  Mode <span className="font-medium">Strict</span>, and the redirect URI from the form below. Open this
                  page at the address people use for ClearPing. That address is where the URI comes from.
                </p>
              </ProviderSetting>
              <ProviderSetting name="Signing key">
                <p className="text-sm">Any key, such as <span className="font-medium">authentik Self-signed Certificate</span>.</p>
                <p className={HINT}>Required. Without one, Authentik signs with the client secret and ClearPing refuses the sign-in.</p>
              </ProviderSetting>
              <ProviderSetting name="Scopes">
                <p className="flex flex-wrap gap-1.5">
                  <Scope>openid</Scope>
                  <Scope>email</Scope>
                  <Scope>profile</Scope>
                </p>
                <p className={HINT}>Leave the defaults. <Scope>profile</Scope> carries the username and the groups.</p>
              </ProviderSetting>
            </dl>
            <p className={STEP_TEXT}>
              On <Path>Configure Bindings</Path>, add nothing unless only some people should see ClearPing on their
              Authentik home page.
            </p>
          </Step>
          <Step number={5} title="Copy three values into the form below">
            <p className={STEP_TEXT}>
              Submit the wizard, then open the provider it created. Copy <Path>Client ID</Path>, <Path>Client secret</Path>,
              and <Path>OpenID Configuration Issuer</Path>.
            </p>
            <p className={HINT}>
              The client ID is the long value on the provider. The slug is not the client ID. Authentik says the client
              identifier is missing or invalid when those are mixed up. The issuer ends in{' '}
              <span className="font-mono">/application/o/&lt;slug&gt;/</span>. That is the issuer, not the OpenID
              Configuration URL.
            </p>
          </Step>
        </ol>
      ),
    },
    {
      title: 'Other OpenID Connect providers',
      content: (
        <ol className="space-y-5">
          <Step number={1} title="Create a confidential client">
            <p className={STEP_TEXT}>
              In Keycloak, Entra ID, Google, or another OpenID Connect provider, create a confidential client for ClearPing.
            </p>
          </Step>
          <Step number={2} title="Set the redirect URI">
            <p className={STEP_TEXT}>
              Use the redirect URI from the form below, as an exact match. Open this page at the address people use for
              ClearPing.
            </p>
          </Step>
          <Step number={3} title="Sign tokens with a key">
            <p className={STEP_TEXT}>
              ID tokens must be signed with a key (<Scope>RS256</Scope> or <Scope>ES256</Scope>), not with the client secret.
            </p>
          </Step>
          <Step number={4} title="Ask for the usual scopes">
            <p className="flex flex-wrap gap-1.5">
              <Scope>openid</Scope>
              <Scope>email</Scope>
              <Scope>profile</Scope>
            </p>
            <p className={HINT}>
              Add a <Scope>groups</Scope> claim only if roles in ClearPing should follow the provider&apos;s groups.
            </p>
          </Step>
          <Step number={5} title="Paste the issuer, client ID, and secret">
            <p className={STEP_TEXT}>
              The issuer is the address that serves <span className="font-mono">/.well-known/openid-configuration</span>,
              without that ending.
            </p>
          </Step>
        </ol>
      ),
    },
  ]
  const optional = [
    {
      title: 'Who can sign in',
      content: (
        <div className="space-y-4">
          <Input
            label="Only members of this group"
            placeholder="clearping-users"
            description={`Optional. A group name at ${label}. Empty: anyone ${label} lets into the application can sign in.`}
            value={form.allowedGroup}
            onChange={event => set('allowedGroup')(event.target.value)}
          />
          <SettingSwitch
            checked={form.autoCreate}
            onChange={on => set('autoCreate')(on)}
            label="Create an account at first sign-in"
            detail="Someone new gets an account under their provider username. Off: only accounts already linked can sign in this way."
          />
          <p className={HINT}>
            Optional. Name a group for a role and each sign-in sets it: admin group, admin; editor group, editor; neither,
            viewer. Leave both empty to set roles in Accounts. The last admin is never demoted this way.
          </p>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Input label="Admin group" placeholder="clearping-admins" value={form.adminGroup} onChange={event => set('adminGroup')(event.target.value)} />
            <Input label="Editor group" placeholder="clearping-editors" value={form.editorGroup} onChange={event => set('editorGroup')(event.target.value)} />
          </div>
          <div className="max-w-sm">
            <Select
              label="New accounts start as"
              description={groupsDecide ? 'Set by their groups instead.' : undefined}
              value={form.newAccountRole}
              disabled={groupsDecide}
              onValueChange={value => setForm(previous => ({ ...previous, newAccountRole: value as Role }))}
              options={ROLE_OPTIONS}
            />
          </div>
        </div>
      ),
    },
    {
      title: 'Signing out',
      content: (
        <div className="space-y-4">
          <SettingSwitch
            checked={form.signOutAtProvider}
            onChange={on => set('signOutAtProvider')(on)}
            label={`Signing out of ClearPing signs out of ${label} too`}
            detail="Ends ClearPing's session at the provider. In Authentik, set the provider's invalidation flow to default-invalidation-flow to log out of Authentik itself."
          />
          <p className={STEP_TEXT}>
            To be signed out here when you sign out at Authentik (2025.8 or later), set <Path>Logout Method</Path> to{' '}
            <span className="font-medium">Back-channel</span> and use these addresses:
          </p>
          <CopyField id="sso-logout" label="Logout URI" value={logoutUri} />
          <CopyField id="sso-after-logout" label="Post logout redirect URI" value={afterLogoutUri} />
        </div>
      ),
    },
  ]

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        void save(form, 'save')
      }}
    >
      <Accordion items={guides} defaultOpen={configured ? -1 : 0} />

      <div className="space-y-4">
        <h2 className={SECTION_TITLE}>Connection</h2>
        <CopyField id="sso-redirect" label="Redirect URI, matching Strict" value={redirectUri} />
        <p className={HINT}>Taken from the address this page is open at.</p>
        {savedElsewhere && (
          <p className="text-xs text-warning">
            Saved from another address ({saved.redirectUri}). Saving here switches to the one above, so the provider
            needs that one.
          </p>
        )}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input
              label="Issuer"
              required
              placeholder="https://auth.example.com/application/o/clear-ping/"
              value={form.issuer}
              onChange={event => set('issuer')(event.target.value)}
            />
          </div>
          <Input label="Client ID" required autoComplete="off" value={form.clientId} onChange={event => set('clientId')(event.target.value)} />
          <PasswordField
            label="Client secret"
            required={!saved.clientSecretSet}
            autoComplete="new-password"
            description={saved.clientSecretSet ? 'Saved. Leave it empty to keep it.' : undefined}
            value={form.clientSecret}
            onChange={event => set('clientSecret')(event.target.value)}
          />
          <Input
            label="Button name"
            placeholder="Authentik"
            description={`The sign-in page shows "Sign in with ${label}".`}
            value={form.label}
            maxLength={40}
            onChange={event => set('label')(event.target.value)}
          />
        </div>
        {tested && <Alert tone={tested.ok ? 'success' : 'danger'} title={tested.ok ? 'The issuer answered' : 'The issuer did not answer'}>{tested.text}</Alert>}
        <div>
          <Button type="button" variant="secondary" size="sm" loading={busy === 'test'} disabled={(busy !== null && busy !== 'test') || !form.issuer} onClick={test}>
            Check the issuer
          </Button>
        </div>
      </div>

      <Accordion items={optional} defaultOpen={-1} />

      <div>
        <Button type="submit" loading={busy === 'save'} disabled={busy !== null && busy !== 'save'}>
          Save single sign-on
        </Button>
      </div>

      <div className="space-y-4">
        <SettingSwitch
          checked={saved.enabled}
          disabled={busy !== null || (!saved.enabled && !configured)}
          onChange={on => save({ enabled: on }, 'toggle')}
          label={`Show "Sign in with ${saved.label}"`}
          detail={configured ? 'Adds the button to the sign-in page.' : 'Save the issuer, client ID and client secret first.'}
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
              : `Off: ${saved.label} is the only way in. If it ever fails, start ClearPing with CLEARPING_AUTH=off to get back in.`
          }
        />
      </div>
    </form>
  )
}

/** One numbered step of a setup, its number in a circle beside it. */
function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary"
        aria-hidden="true"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <h3 className="pt-0.5 text-sm font-medium text-card-foreground">
          <span className="sr-only">Step {number}: </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  )
}

/** A setting on the provider's page in Authentik, and what to set it to. */
function ProviderSetting({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="pt-0.5 text-xs font-medium text-muted-foreground">{name}</dt>
      <dd className="min-w-0 space-y-2">{children}</dd>
    </div>
  )
}

/** A menu path or field name in the provider's interface. */
function Path({ children }: { children: ReactNode }) {
  return <span className="font-medium text-card-foreground">{children}</span>
}

/** An OpenID Connect scope or claim, as it is written. */
function Scope({ children }: { children: ReactNode }) {
  return <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-card-foreground">{children}</code>
}

const STEP_TEXT = 'text-sm leading-relaxed text-muted-foreground'

const ACTIONS: Record<string, string> = {
  'target.add': 'added a monitor',
  'target.import': 'imported monitors',
  'target.change': 'changed a monitor',
  'target.pause': 'paused a monitor',
  'target.resume': 'resumed a monitor',
  'target.delete': 'deleted monitors',
  'group.add': 'made a group',
  'group.move': 'renamed a group',
  'group.delete': 'deleted a group',
  'alert.add': 'made an alert',
  'alert.change': 'changed an alert',
  'alert.delete': 'deleted an alert',
  'bgp.enable': 'turned on BGP monitoring',
  'bgp.disable': 'turned off BGP monitoring',
  'bgp.add': 'started watching a prefix',
  'bgp.change': 'changed a watched prefix',
  'bgp.accept': 'took a prefix’s routing as normal',
  'bgp.remove': 'stopped watching a prefix',
  'bgp.trace': 'traced the monitors in a watched prefix',
  'bgp.network': 'set their own network for Routing',
  'key.create': 'created a key',
  'key.revoke': 'revoked a key',
  'key.reroll': 're-rolled a key',
  'account.create': 'created the account',
  'account.add': 'added an account',
  'account.remove': 'removed an account',
  'account.password': 'changed their password',
  'account.password.reset': 'reset their password',
  'account.password.reset.asked': 'asked for a password reset code',
  'account.password.set': 'set the password of',
  'account.password.link': 'made a password link for',
  'account.2fa.enable': 'turned on their authenticator app',
  'account.2fa.disable': 'turned off their authenticator app',
  'account.2fa.codes': 'made new backup codes',
  'account.passkey.add': 'added a passkey',
  'account.passkey.remove': 'removed a passkey',
  'security.factors': 'changed the second factors required',
  'security.on': 'turned on',
  'security.off': 'turned off',
  'security.setup': 'left the first-run prompt',
  'sso.change': 'changed single sign-on',
  'account.sso.link': 'linked their account',
  'account.sso.unlink': 'unlinked their account',
  signin: 'signed in',
  'signin.failed': 'failed to sign in',
  signout: 'was signed out',
  'mcp.add_targets': 'added monitors',
  'mcp.update_target': 'changed a monitor',
  'mcp.set_target_paused': 'paused or resumed a monitor',
  'mcp.probe_now': 'probed a monitor',
  'mcp.run_traceroute': 'traced a route',
  'probe.rename': 'renamed the local probe',
  'target.merge': 'merged monitors',
  'group.probe': 'changed the probes of a group',
  'probe-agent.add': 'added a probe agent',
  'probe-agent.change': 'changed a probe agent',
  'probe-agent.remove': 'removed a probe agent',
  'probe-agent.pair': 'connected a probe agent',
  'probe-agent.trust': 'trusted a probe agent’s new certificate',
  'probe-agent.forget': 'forgot a probe agent’s certificate',
  'probe-agent.token': 'made a new token for a probe agent',
  'probe-agent.offline': 'lost touch with a probe agent',
  'probe-agent.online': 'reached a probe agent again',
  'maintenance.run': 'ran maintenance',
  'maintenance.settings': 'changed the maintenance schedule',
  'privacy.settings': 'changed the privacy settings',
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

  const timeZone = displayTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <div className="space-y-3">
      <Timeline
        label="Activity"
        now={now}
        timeZone={timeZone}
        locale={displayLocale()}
        maxHeight={560}
        scrollToNew={false}
        events={entries.map(entry => ({
          id: String(entry.id),
          at: entry.at,
          actor: entry.actor.kind === 'key' ? `Key ${entry.actor.name}` : entry.actor.name,
          title: `${ACTIONS[entry.action] ?? entry.action}${entry.detail ? `: ${entry.detail}` : ''}`,
          meta: VIA[entry.via] ?? entry.via,
          tone: entry.action === 'signin.failed' || entry.action === 'probe-agent.offline' ? 'danger' : 'neutral',
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
/** The groups the sections are listed under, in order. */
const GROUPS = ['Security', 'Monitoring', 'More'] as const

interface Section {
  value: SettingsSection
  label: string
  /** One line under the section's title: what it is for. */
  intro: string
  icon: LucideIcon
  group: (typeof GROUPS)[number]
  adminOnly?: boolean
}

const SECTIONS: Section[] = [
  { value: 'access', label: 'Access', intro: 'Whether people have to sign in to use ClearPing, and whether AI assistants need a key.', icon: ShieldCheck, group: 'Security', adminOnly: true },
  { value: 'sign-in', label: 'Sign-in', intro: 'Add a second step to signing in, with an authenticator app or a passkey.', icon: Fingerprint, group: 'Security' },
  { value: 'keys', label: 'Keys', intro: "Let scripts and AI assistants use ClearPing's API and MCP server without signing in.", icon: KeyRound, group: 'Security' },
  { value: 'sso', label: 'Single sign-on', intro: 'Let people sign in with Authentik or another OpenID Connect provider instead of a ClearPing password.', icon: LogIn, group: 'Security' },
  { value: 'accounts', label: 'Accounts', intro: 'Who can sign in, and what each person can do.', icon: Users, group: 'Security' },
  { value: 'privacy', label: 'Privacy', intro: 'What ClearPing shows on screen, hands to AI assistants, keeps in its records and asks of the internet.', icon: EyeOff, group: 'Security' },
  { value: 'probes', label: 'Probes', intro: 'Where readings are taken from: the local probe, which is this dashboard, and probe agents on other machines, such as a VPS abroad. Nothing to do with AI agents.', icon: RadioTower, group: 'Monitoring', adminOnly: true },
  { value: 'routing', label: 'Routing', intro: 'Watch how the rest of the internet reaches your own IP prefixes in BGP.', icon: Network, group: 'Monitoring', adminOnly: true },
  { value: 'maintenance', label: 'Maintenance', intro: 'Check the database for damage, clear out leftovers and old data, and keep the file tidy.', icon: Wrench, group: 'Monitoring', adminOnly: true },
  { value: 'activity', label: 'Activity', intro: 'Every change, sign-in and failed sign-in, with who did it and how. How long it is kept is under Privacy.', icon: History, group: 'More', adminOnly: true },
  { value: 'assistant', label: 'AI assistant', intro: 'Connect an assistant such as Claude over MCP, then ask it about your network in plain words.', icon: Bot, group: 'More' },
]

interface SettingsPageProps {
  /** The section on screen, which is part of the address: /settings/keys and so on. */
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  /** Go to the dashboard, listing only the targets probed from this probe agent. */
  onShowTargetsFrom?: (probeAgentId: string) => void
  /** Go to the Routing page. */
  onOpenRouting?: () => void
  /** The probes changed (the local probe renamed), so the rest of the dashboard catches up. */
  onProbesChanged?: () => void
}

/**
 * The dashboard's Settings page, at /settings: who may get in, keys,
 * single sign-on, accounts, the activity record, and connecting an AI
 * assistant, each a tab of its own.
 */
export function SettingsPage({ section, onSection, onShowTargetsFrom, onOpenRouting, onProbesChanged }: SettingsPageProps) {
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
    notifySecurityChanged()
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
  ).map(item =>
    item.value === 'accounts' && me && !canAdminister(me.role)
      ? { ...item, label: 'Your account', intro: 'Your role, and your password.' }
      : item.value === 'sign-in' && me && canAdminister(me.role)
        ? { ...item, intro: 'Add a second step to your own sign-in, and choose what every account must have.' }
        : item
  )
  const current = sections.find(item => item.value === section) ?? sections[0]

  return (
    // Wide enough for the tables in it (probe agents, accounts, activity) to
    // show every column without scrolling on a desktop; the text in it keeps
    // its own measure, so prose does not run the whole width. The whole page,
    // header and all, is kept to it, so the header lines up with the rest.
    <div className={cn(PANE, 'max-w-[96rem]')}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Settings</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Who can sign in and what they can do, where readings are taken from, and keeping ClearPing in good shape.
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

      {/* A list of sections down the side, as settings usually are: ten in a
          row of tabs ran off the side and had to be scrolled. On a phone,
          a choice of section above it instead. */}
      <div className="grid gap-6 @3xl/main:grid-cols-[13rem_minmax(0,1fr)] @3xl/main:items-start">
        <div className="@3xl/main:hidden">
          <Select
            id="settings-section"
            label="Section"
            value={current.value}
            onValueChange={value => onSection(value as SettingsSection)}
            options={sections.map(item => ({ value: item.value, label: `${item.group}: ${item.label}` }))}
          />
        </div>
        <nav aria-label="Settings" className="hidden space-y-5 @3xl/main:sticky @3xl/main:top-4 @3xl/main:block">
          {GROUPS.map(group => {
            const inGroup = sections.filter(item => item.group === group)
            if (inGroup.length === 0) return null
            return (
              <div key={group}>
                <p className="mb-1.5 px-3 text-xs font-medium text-muted-foreground">{group}</p>
                <ul className="space-y-0.5">
                  {inGroup.map(item => {
                    const Icon = item.icon
                    const here = item.value === current.value
                    return (
                      <li key={item.value}>
                        <button
                          type="button"
                          onClick={() => onSection(item.value)}
                          aria-current={here ? 'page' : undefined}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                            here ? 'bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                          )}
                        >
                          <Icon {...ICON} />
                          {item.label}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </nav>

        <section aria-labelledby="settings-section-title" className="min-w-0 space-y-4 text-foreground">
        <header>
          <h2 id="settings-section-title" className="text-lg font-medium text-foreground">{current.label}</h2>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{current.intro}</p>
        </header>
        {current.value === 'assistant' ? (
          <AssistantSettings onMakeKey={() => onSection('keys')} />
        ) : current.value === 'privacy' ? (
          // Open to everyone, signed in or not: hiding addresses in your own
          // browser needs no account. The rest needs an admin.
          <div className={PAGE_CARD}>
            <PrivacyTab
              canChange={loaded.state === 'ready' && canAdminister(loaded.data.me.role)}
              onOpenRouting={loaded.state === 'ready' && canAdminister(loaded.data.me.role) ? () => onSection('routing') : undefined}
            />
          </div>
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
                {current.value === 'access' && <AccessTab data={loaded.data} onChange={change} reload={reload} />}
                {current.value === 'sign-in' && <SignInTab data={loaded.data} reload={reload} />}
                {current.value === 'keys' && <KeysTab data={loaded.data} reload={reload} />}
                {current.value === 'sso' && <SsoTab data={loaded.data} reload={reload} />}
                {current.value === 'accounts' && <AccountsTab data={loaded.data} reload={reload} />}
                {current.value === 'activity' && <ActivityTab />}
                {current.value === 'maintenance' && <MaintenanceTab />}
                {current.value === 'probes' && <ProbeAgentsTab onShowTargets={onShowTargetsFrom} onProbesChanged={onProbesChanged} />}
                {current.value === 'routing' && <RoutingTab onOpenRouting={() => onOpenRouting?.()} />}
              </div>
            )}
          </>
        )}
        </section>
      </div>
    </div>
  )
}
