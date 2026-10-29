'use client'

import { useState, type FormEvent } from 'react'
import { UserPlus, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { motionTokens } from '@/components/arc/lib/motion-tokens'
import { PasswordField } from '@/components/arc/password-field/password-field'
import { RadioGroup } from '@/components/arc/radio-group/radio-group'
import { useToast } from '@/components/notifications'
import { SegmentedField } from '@/components/segmented-field'
import { DEFAULT_NEW_ROLE, ROLE_DETAIL, ROLE_LABEL, ROLES, type Role } from '@/lib/security/roles'
import { HINT, ICON, LinkReady, PASSWORD_WAYS, send, type PasswordLink, type PasswordWay } from './password-dialog'

/**
 * The Accounts heading, with Add account beside it, which opens the form for
 * a new account below and closes it again. The admin either sets
 * its password and passes it on, or gets a one-time link with which its owner
 * chooses their own, so the admin never knows it (password-dialog.tsx).
 */
export function AddAccount({ onAdded }: { onAdded: () => void }) {
  const { notify, reportError } = useToast()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [way, setWay] = useState<PasswordWay>('link')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>(DEFAULT_NEW_ROLE)
  const [busy, setBusy] = useState(false)
  // The account just made with a link, and the link, until "Add another".
  const [made, setMade] = useState<{ username: string; link: PasswordLink } | null>(null)

  const add = async (event: FormEvent) => {
    event.preventDefault()
    const name = username.trim()
    setBusy(true)
    const { ok, body } = await send('/api/security/users', 'POST', way === 'link' ? { username: name, role, link: true } : { username: name, password, role })
    setBusy(false)
    if (!ok) return reportError('Could not add the account', body.error)
    notify({ tone: 'success', title: `Added ${name}`, detail: `As ${ROLE_LABEL[role]}` })
    if (way === 'link') setMade({ username: name, link: body.link as PasswordLink })
    setUsername('')
    setPassword('')
    setRole(DEFAULT_NEW_ROLE)
    onAdded()
  }

  const close = () => {
    setOpen(false)
    setMade(null)
    setUsername('')
    setPassword('')
    setWay('link')
    setRole(DEFAULT_NEW_ROLE)
  }

  const content = made ? (
    <div className="space-y-4 text-foreground">
      <Alert tone="success" title={`${made.username} is added. Now send them their link`}>
        Until they use it, the account has no password anyone knows, so nobody can sign in to it.
      </Alert>
      <LinkReady username={made.username} link={made.link} />
      {/* Each on a line of its own: buttons are inline. */}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={close}>Done</Button>
        <Button type="button" variant="secondary" onClick={() => setMade(null)}>
          <UserPlus {...ICON} />
          Add another
        </Button>
      </div>
    </div>
  ) : (
    <form noValidate onSubmit={add} className="space-y-4 text-foreground">
      <Input label="Username" required autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} />
      <SegmentedField label="Their password" value={way} onValueChange={value => setWay(value as PasswordWay)} options={PASSWORD_WAYS} />
      {way === 'link' ? (
        <p className={HINT}>
          You get a one-time link to send them, and they choose their own password with it, so you never know it. It
          works for 48 hours.
        </p>
      ) : (
        <PasswordField
          label="Password"
          required
          description="10 characters or more. Pass it on to them yourself."
          autoComplete="new-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
        />
      )}
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
      <Button type="submit" loading={busy} disabled={busy || !username.trim() || (way === 'password' && !password)}>
        <UserPlus {...ICON} />
        {way === 'link' ? 'Add account and make link' : 'Add account'}
      </Button>
    </form>
  )

  return (
    <div className="space-y-4">
      {/* The way to add one where the eye starts. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className={`${HINT} min-w-0 max-w-xl pt-1`}>
          Add someone, choose their role, and send them a link to set their own password.
        </p>
        <Button
          type="button"
          variant={open ? 'secondary' : 'primary'}
          aria-expanded={open}
          aria-controls="add-account-panel"
          onClick={() => (open ? close() : setOpen(true))}
        >
          {open ? <X {...ICON} /> : <UserPlus {...ICON} />}
          {open ? 'Cancel' : 'Add account'}
        </Button>
      </div>

      {/* Opens from under the button that asked for it, and folds back into it. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.section
            id="add-account-panel"
            aria-labelledby="add-account-title"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}
            className="overflow-hidden"
          >
            <div className="space-y-4 rounded-2xl border border-border bg-muted/40 p-4 @2xl/main:p-5">
              <p id="add-account-title" className="text-sm font-medium text-card-foreground">New account</p>
              {content}
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
