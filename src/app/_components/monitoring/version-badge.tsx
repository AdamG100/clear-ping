'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { VersionStatus } from '@/lib/version'

/**
 * The version this server is running, and whether a newer one is out.
 *
 * Asked again every hour, so a page left open says when an update has been
 * published, and says to reload once the server it is talking to has been
 * updated underneath it.
 */

const ASK_EVERY_MS = 60 * 60 * 1000

function when(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** One line about where this build came from: when, and from which commit. */
function provenance(build: { builtAt: string | null; commit: string | null }): string | undefined {
  const parts = [when(build.builtAt) && `Built ${when(build.builtAt)}`, build.commit && `commit ${build.commit.slice(0, 7)}`]
  return parts.filter(Boolean).join(' · ') || undefined
}

const CHIP =
  'inline-flex items-center gap-1 rounded border px-1 py-px font-mono text-[10px] leading-none tracking-normal normal-case'

export function VersionBadge({ className }: { className?: string }) {
  const [status, setStatus] = useState<VersionStatus | null>(null)
  // The version the server was on when this page loaded: the one its scripts are from.
  const [loadedWith, setLoadedWith] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    const ask = () =>
      fetch('/api/version')
        .then(response => (response.ok ? response.json() : null))
        .then((told: VersionStatus | null) => {
          if (!current || !told) return
          setLoadedWith(first => first ?? told.current.version)
          setStatus(told)
        })
        .catch(() => {})

    ask()
    const timer = setInterval(ask, ASK_EVERY_MS)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [])

  if (!status) return null
  const { current, latest, updateAvailable } = status
  const label = `v${current.version}`

  if (loadedWith && loadedWith !== current.version) {
    return (
      <button
        type="button"
        onClick={() => window.location.reload()}
        className={cn(CHIP, 'cursor-pointer border-signal-perfect/50 text-signal-perfect hover:bg-sidebar-accent', className)}
        data-tip={`Updated to ${label}`}
        data-tip-detail="Reload to use the new version"
      >
        {label} · reload
      </button>
    )
  }

  if (updateAvailable && latest) {
    const newer = latest.version ? `v${latest.version}` : `commit ${latest.commit?.slice(0, 7)}`
    const release = latest.version && latest.source ? `${latest.source}/releases/tag/v${latest.version}` : undefined
    const Tag = release ? 'a' : 'span'
    return (
      <Tag
        {...(release ? { href: release, target: '_blank', rel: 'noreferrer' } : {})}
        className={cn(CHIP, 'border-signal-minor/50 text-signal-minor', release && 'hover:bg-sidebar-accent', className)}
        data-tip={`${newer} is available`}
        data-tip-detail={`Running ${label}. Pull the latest image and recreate the container to update.`}
      >
        <span className="size-1.5 rounded-full bg-signal-minor" aria-hidden="true" />
        {label}
        <span className="sr-only">, update available: {newer}</span>
      </Tag>
    )
  }

  const tip = current.development
    ? 'Development build'
    : updateAvailable === false
      ? `${label}, the latest version`
      : label
  const detail = current.development
    ? 'Not a published version, so there is nothing to compare it with'
    : updateAvailable === false
      ? provenance(current)
      : [provenance(current), status.latestUnknownBecause].filter(Boolean).join('. ')

  return (
    <span className={cn(CHIP, 'border-sidebar-border text-muted-foreground', className)} data-tip={tip} data-tip-detail={detail}>
      {updateAvailable === false && (
        <span className="size-1.5 rounded-full bg-signal-perfect" aria-hidden="true" />
      )}
      {label}
    </span>
  )
}
