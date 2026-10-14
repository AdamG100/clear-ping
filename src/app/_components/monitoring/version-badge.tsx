'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/arc/badge/badge'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
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

/** A name and a quieter second line, for a tooltip. */
function TwoLines({ name, detail }: { name: string; detail?: string }) {
  return (
    <span className="block max-w-64 space-y-0.5">
      <span className="block">{name}</span>
      {detail && <span className="block text-muted-foreground">{detail}</span>}
    </span>
  )
}

export function VersionBadge() {
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
      <Tooltip content={<TwoLines name={`Updated to ${label}`} detail="Reload to use the new version" />}>
        <button type="button" onClick={() => window.location.reload()} className="cursor-pointer">
          <Badge tone="success" size="sm">{label} · reload</Badge>
        </button>
      </Tooltip>
    )
  }

  if (updateAvailable && latest) {
    const newer = latest.version ? `v${latest.version}` : `commit ${latest.commit?.slice(0, 7)}`
    const release = latest.version && latest.source ? `${latest.source}/releases/tag/v${latest.version}` : undefined
    const Tag = release ? 'a' : 'span'
    return (
      <Tooltip content={<TwoLines name={`${newer} is available`} detail={`Running ${label}. Pull the latest image and recreate the container to update.`} />}>
        <Tag {...(release ? { href: release, target: '_blank', rel: 'noreferrer' } : { tabIndex: 0 })}>
          <Badge tone="warning" size="sm">
            {label}
            <span className="sr-only">, update available: {newer}</span>
          </Badge>
        </Tag>
      </Tooltip>
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
    <Tooltip content={<TwoLines name={tip} detail={detail} />}>
      <span tabIndex={0}>
        <Badge tone={updateAvailable === false ? 'success' : 'neutral'} size="sm">{label}</Badge>
      </span>
    </Tooltip>
  )
}
