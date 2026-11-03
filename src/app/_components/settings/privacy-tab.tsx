'use client'

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Select } from '@/components/arc/select/select'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Switch } from '@/components/arc/switch/switch'
import { SegmentedField } from '@/components/segmented-field'
import { useToast } from '@/components/notifications'
import type { HideAddresses, PrivacySettings } from '@/lib/privacy/current'
import { maskAddress } from '@/lib/privacy/mask'
import { announcePrivacyChanged, setHiddenHere, useHiddenHere } from '../privacy/use-privacy'

/**
 * Settings → Privacy: what ClearPing shows on screen, hands to AI assistants,
 * keeps in its records and asks of the internet. Everyone can hide addresses
 * in their own browser; the rest is an admin's.
 */

interface Overview {
  settings: PrivacySettings
  readingsKeptDays: number | null
}

const HINT = 'text-xs leading-relaxed text-muted-foreground'
const SECTION = 'space-y-5 border-t border-border pt-6 first:border-t-0 first:pt-0'
const SECTION_TITLE = 'text-sm font-medium text-card-foreground'

const HIDE: { value: HideAddresses; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'viewers', label: 'From viewers' },
  { value: 'everyone', label: 'From everyone' },
]

const KEEP_ACTIVITY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
]

function SwitchRow({
  checked,
  onChange,
  disabled,
  label,
  detail,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  label: string
  detail: ReactNode
}) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5 pt-2.5">
        <p id={`${id}-title`} className={SECTION_TITLE}>{label}</p>
        <div id={`${id}-detail`} className={HINT}>{detail}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} />
    </div>
  )
}

export function PrivacyTab({ canChange, onOpenRouting }: { canChange: boolean; onOpenRouting?: () => void }) {
  const { notify, reportError } = useToast()
  const hiddenHere = useHiddenHere()
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/privacy', { cache: 'no-store' }).catch(() => null)
    if (!response?.ok) return setError('Could not load the privacy settings')
    setData((await response.json()) as Overview)
  }, [])

  useEffect(() => {
    // Loaded when the section opens, which is after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const change = async (changes: Partial<PrivacySettings>) => {
    if (!data) return
    const response = await fetch('/api/privacy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data.settings, ...changes }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) return reportError('Could not save the privacy settings', body.error)
    setData(body as Overview)
    announcePrivacyChanged()
    notify({ tone: 'success', title: 'Saved' })
  }

  const hereSwitch = (
    <SwitchRow
      checked={hiddenHere}
      onChange={setHiddenHere}
      label="Hide addresses in this browser"
      detail="For sharing your screen or taking screenshots. Only this browser, until you turn it off here."
    />
  )

  if (error) {
    return (
      <div className="space-y-6">
        {hereSwitch}
        <Alert tone="danger" title="Could not load the privacy settings">{error}</Alert>
      </div>
    )
  }
  if (!data) return <Skeleton label="Loading the privacy settings" lines={6} />

  const { settings } = data
  const locked = !canChange

  return (
    <div className="space-y-6">
      {locked && <p className={HINT}>Only an admin can change the settings for everyone. Hiding addresses in this browser is up to you.</p>}

      <section className={SECTION} aria-labelledby="privacy-screen">
        <div className="space-y-1">
          <h3 id="privacy-screen" className={SECTION_TITLE}>On screen</h3>
          <p className={HINT}>
            Hidden addresses show as dots: {'203.0.113.10'} becomes <span className="font-mono">{maskAddress('203.0.113.10')}</span>, and{' '}
            {'vps1.example.net'} becomes <span className="font-mono">{maskAddress('vps1.example.net')}</span>. That covers the addresses of monitors,
            routes and probe agents, and monitor names that are addresses. Names you gave stay, so monitors can still be told apart.
            Routing&apos;s prefixes and AS numbers are public in BGP, so they stay too.
          </p>
        </div>
        <SegmentedField
          label="Hide addresses for everyone"
          value={settings.hideAddresses}
          onValueChange={value => void change({ hideAddresses: value as HideAddresses })}
          options={HIDE}
          disabled={locked}
        />
        <p className={HINT}>
          From viewers: viewers, and anyone using ClearPing without signing in. Admins and editors still see them. This changes what is
          shown, not what is sent: anyone signed in can still read addresses through the API.
        </p>
        {hereSwitch}
      </section>

      <section className={SECTION} aria-labelledby="privacy-assistants">
        <h3 id="privacy-assistants" className="sr-only">AI assistants</h3>
        <SwitchRow
          checked={settings.hideFromAssistants}
          disabled={locked}
          onChange={on => void change({ hideFromAssistants: on })}
          label="Hide addresses from AI assistants"
          detail="Everything ClearPing gives an assistant over MCP has its addresses hidden, so they never reach the company that runs it. The assistant can still name, compare and explain your monitors."
        />
      </section>

      <section className={SECTION} aria-labelledby="privacy-records">
        <h3 id="privacy-records" className={SECTION_TITLE}>Records</h3>
        <SwitchRow
          checked={settings.recordSignInAddresses}
          disabled={locked}
          onChange={on => void change({ recordSignInAddresses: on })}
          label="Record sign-in addresses"
          detail="Activity notes the IP address every sign-in and failed sign-in came from. Off, it only notes that they happened. The server log keeps failed sign-ins' addresses either way, to help spot someone guessing passwords."
        />
        <div className="max-w-xs space-y-1">
          <Select
            label="Keep Activity for"
            value={String(settings.keepActivityDays)}
            disabled={locked}
            onValueChange={value => void change({ keepActivityDays: Number(value) })}
            options={KEEP_ACTIVITY}
          />
          <p className={HINT}>Older entries are deleted as new ones arrive.</p>
        </div>
        <p className={HINT}>
          {data.readingsKeptDays === null
            ? 'Readings and saved routes are kept for good: CLEARPING_RETENTION_DAYS is 0 where ClearPing runs.'
            : `Readings and saved routes are kept for ${data.readingsKeptDays} days, set by CLEARPING_RETENTION_DAYS where ClearPing runs.`}
        </p>
      </section>

      <section className={SECTION} aria-labelledby="privacy-outside">
        <h3 id="privacy-outside" className={SECTION_TITLE}>Connections to the internet</h3>
        <SwitchRow
          checked={settings.checkForUpdates}
          disabled={locked}
          onChange={on => void change({ checkForUpdates: on })}
          label="Check for updates"
          detail="Asks GitHub's container registry every 15 minutes whether a newer version is out. Off, ClearPing never contacts it, and the sidebar stops saying when an update is available."
        />
        <SwitchRow
          checked={settings.lookUpNetworks}
          disabled={locked}
          onChange={on => void change({ lookUpNetworks: on })}
          label="Look up who runs each address"
          detail="A monitor's page shows which network holds its address, such as AS64500 and its name, by asking RIPE NCC. It sends only that public address, and never a private one. Off, the page says nothing about who runs it."
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={`${HINT} min-w-0 max-w-xl`}>
            Routing, while it is on, also connects out: to RIPE for routes and to PeeringDB for internet exchanges. Probes only reach
            the monitors you add.
          </p>
          {onOpenRouting && (
            <Button type="button" size="sm" variant="secondary" onClick={onOpenRouting}>
              Routing settings
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}
