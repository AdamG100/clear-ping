'use client'

import { useState, type FormEvent } from 'react'
import { KeyRound, Link2 } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { PasswordField } from '@/components/arc/password-field/password-field'
import { useToast } from '@/components/notifications'
import { SegmentedField } from '@/components/segmented-field'
import { inDisplayZone } from '@/lib/time-zone'
import { CopyField } from './mcp-setup'

/**
 * Another account's password, for an admin: for someone who has forgotten
 * theirs, or never used the link they were given. Either the admin sets one
 * and passes it on, or makes a one-time link (store.ts, makePasswordLink)
 * with which its owner chooses one, so the admin never knows it. Adding an
 * account offers the same two ways (add-account.tsx).
 */

export const HINT = 'text-xs leading-relaxed text-muted-foreground'
export const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

export type PasswordWay = 'link' | 'password'

export const PASSWORD_WAYS: { value: PasswordWay; label: string }[] = [
  { value: 'link', label: 'They choose it, with a link' },
  { value: 'password', label: 'I set it now' },
]

export interface PasswordLink {
  token: string
  expiresAt: number
}

export async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: response.ok, body: await response.json().catch(() => ({})) }
}

/**
 * The sign-in page's address with the link's token after the `#`: the part of
 * an address a browser never sends, so the token stays out of the server's
 * request logs and out of any Referer header.
 */
export function passwordLinkUrl(token: string, username: string): string {
  return `${window.location.origin}/login#password-link=${encodeURIComponent(token)}&user=${encodeURIComponent(username)}`
}

/** A link just made, ready to copy, with how long it lasts. Shown once: it is not kept anywhere it could be shown again. */
export function LinkReady({ username, link }: { username: string; link: PasswordLink }) {
  const until = new Date(link.expiresAt).toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' }))
  return (
    <div className="space-y-3">
      <CopyField id={`password-link-${username}`} label={`Password link for ${username}`} value={passwordLinkUrl(link.token, username)} />
      <p className={HINT}>
        Send it to {username} yourself, by chat or email. It opens the sign-in page, where they choose a password. It works
        once, until {until}. It is not shown again: if it is lost or runs out, make another with Password in the list of
        accounts.
      </p>
    </div>
  )
}

export function PasswordDialog({
  account,
  onClose,
  onDone,
}: {
  account: { id: string; username: string; twoFactor: boolean } | null
  onClose: () => void
  onDone: () => void
}) {
  const { notify, reportError } = useToast()
  const [way, setWay] = useState<PasswordWay>('link')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [link, setLink] = useState<PasswordLink | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = confirm !== '' && password !== confirm

  const close = () => {
    setWay('link')
    setPassword('')
    setConfirm('')
    setLink(null)
    onClose()
  }

  const makeLink = async () => {
    if (!account) return
    setBusy(true)
    const { ok, body } = await send(`/api/security/users/${account.id}/link`, 'POST')
    setBusy(false)
    if (!ok) return reportError(`Could not make a password link for ${account.username}`, body.error)
    setLink(body.link as PasswordLink)
  }

  const setNow = async (event: FormEvent) => {
    event.preventDefault()
    if (!account || password !== confirm) return
    setBusy(true)
    const { ok, body } = await send(`/api/security/users/${account.id}/password`, 'PUT', { password })
    setBusy(false)
    if (!ok) return reportError(`Could not set the password of ${account.username}`, body.error)
    notify({ tone: 'success', title: `Password set for ${account.username}`, detail: 'They have been signed out everywhere. Give them the new password.' })
    close()
    onDone()
  }

  return (
    <Dialog open={account !== null} onOpenChange={open => { if (!open) close() }}>
      <DialogContent
        title={account ? `A new password for ${account.username}` : 'A new password'}
        description="For someone who has forgotten theirs."
      >
        <div className="space-y-4 text-foreground">
          {link && account ? (
            <>
              <LinkReady username={account.username} link={link} />
              <div className="flex justify-end">
                <Button type="button" onClick={close}>Done</Button>
              </div>
            </>
          ) : (
            <>
              <SegmentedField label="Their new password" value={way} onValueChange={value => setWay(value as PasswordWay)} options={PASSWORD_WAYS} />
              {way === 'link' ? (
                <>
                  <p className={HINT}>
                    A one-time link for them to choose it, so you never know it. Their password goes on working until they
                    use it. Any link made for them before stops working.
                  </p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                    <Button type="button" loading={busy} onClick={() => void makeLink()}>
                      <Link2 {...ICON} />
                      Make the link
                    </Button>
                  </div>
                </>
              ) : (
                <form onSubmit={setNow} className="space-y-4" noValidate>
                  <PasswordField
                    label="New password"
                    required
                    description="10 characters or more. They are signed out everywhere, and sign in with this one."
                    autoComplete="new-password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                  />
                  <PasswordField
                    label="New password again"
                    required
                    autoComplete="new-password"
                    value={confirm}
                    onChange={event => setConfirm(event.target.value)}
                  />
                  {mismatch && <p className="text-xs text-destructive">The two passwords are not the same.</p>}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                    <Button type="submit" loading={busy} disabled={busy || !password || password !== confirm}>
                      <KeyRound {...ICON} />
                      Set password
                    </Button>
                  </div>
                </form>
              )}
              {account?.twoFactor && (
                <p className={HINT}>{account.username} still needs their authenticator app after the password.</p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
