'use client'

import { useEffect, useState } from 'react'
import { ArrowUpCircle, ChevronRight, RotateCw } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import type { VersionStatus } from '@/lib/version'
import { inDisplayZone } from '@/lib/time-zone'

/**
 * The version this server is running, and whether a newer one is out.
 *
 * Asked again every quarter of an hour, and whenever the page comes back into
 * view after a while away, so a page left open in a tab says when an update
 * has been published, and says to reload once the server it is talking to
 * has been updated underneath it.
 */

const ASK_EVERY_MS = 15 * 60 * 1000
/** Coming back to the page asks again, unless it was asked this recently. */
const ASK_AGAIN_AFTER_MS = 60 * 1000

export interface VersionState {
  status: VersionStatus | null
  /** The version the server was on when this page loaded: the one its scripts are from. */
  loadedWith: string | null
}

export function useVersionStatus(): VersionState {
  const [state, setState] = useState<VersionState>({ status: null, loadedWith: null })

  useEffect(() => {
    let current = true
    let askedAt = 0
    const ask = () => {
      askedAt = Date.now()
      fetch('/api/version', { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : null))
        .then((told: VersionStatus | null) => {
          if (!current || !told) return
          setState(was => ({ status: told, loadedWith: was.loadedWith ?? told.current.version }))
        })
        .catch(() => {})
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - askedAt > ASK_AGAIN_AFTER_MS) ask()
    }

    ask()
    const timer = setInterval(ask, ASK_EVERY_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return state
}

/** Whether the server has been updated since this page loaded. */
function reloadWanted({ status, loadedWith }: VersionState): boolean {
  return Boolean(status && loadedWith && loadedWith !== status.current.version)
}

/** What the newest published build is called. */
function newerName(status: VersionStatus): string | null {
  const { latest } = status
  if (!status.updateAvailable || !latest) return null
  return latest.version ? `v${latest.version}` : latest.commit ? `commit ${latest.commit.slice(0, 7)}` : null
}

function when(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, inDisplayZone({ dateStyle: 'medium', timeStyle: 'short' }))
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

/**
 * The version, beside the name. Quiet: an update or a reload is said by the
 * notice under it, which this would only repeat. `onOpen` opens the patch
 * notes.
 */
export function VersionBadge({ version, onOpen }: { version: VersionState; onOpen?: () => void }) {
  const { status } = version
  if (!status) return null
  const { current, updateAvailable } = status
  const label = `v${current.version}`
  const newer = newerName(status)

  const tip = current.development
    ? 'Development build'
    : reloadWanted(version)
      ? `Updated to ${label}`
      : newer
        ? `${newer} is available`
        : updateAvailable === false
          ? `${label}, the latest version`
          : label
  const detail = current.development
    ? 'Not a published version, so there is nothing to compare it with'
    : updateAvailable === null
      ? [provenance(current), status.latestUnknownBecause].filter(Boolean).join('. ')
      : provenance(current)

  return (
    <Tooltip content={<TwoLines name={tip} detail={[detail, 'Click for the patch notes'].filter(Boolean).join('. ')} />}>
      <button type="button" onClick={onOpen} className="flex shrink-0 cursor-pointer">
        <Badge tone={newer ? 'warning' : updateAvailable === false ? 'success' : 'neutral'} size="sm">
          {label}
          <span className="sr-only">. Patch notes</span>
        </Badge>
      </button>
    </Tooltip>
  )
}

const NOTICE =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors'

/**
 * An update, said where it cannot be missed: a newer version published, or
 * this server updated under a page that is still running the old one. Nothing
 * at all otherwise.
 */
export function UpdateNotice({ version, onOpen }: { version: VersionState; onOpen?: () => void }) {
  const { status } = version
  if (!status) return null

  if (reloadWanted(version)) {
    return (
      <button
        type="button"
        onClick={() => window.location.reload()}
        className={`${NOTICE} border-success/40 bg-success/10 hover:bg-success/15`}
      >
        <RotateCw size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-success" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-sidebar-foreground">Updated to v{status.current.version}</span>
          <span className="block text-xs text-muted-foreground">Reload to use the new version</span>
        </span>
      </button>
    )
  }

  const newer = newerName(status)
  if (!newer) return null
  return (
    <button type="button" onClick={onOpen} className={`${NOTICE} border-warning/40 bg-warning/10 hover:bg-warning/15`}>
      <ArrowUpCircle size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-sidebar-foreground">{newer} is available</span>
        <span className="block truncate text-xs text-muted-foreground">Running v{status.current.version} · Patch notes</span>
      </span>
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted-foreground" />
    </button>
  )
}
