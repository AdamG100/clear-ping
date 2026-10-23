'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'
import type { Release } from '@/lib/release-notes'
import type { VersionStatus } from '@/lib/version'
import { inDisplayZone } from '@/lib/time-zone'
import { cn } from '@/lib/utils'
import { PANE, PANE_HEADER, PANE_TITLE } from './pane-layout'
import { TraceSkeleton } from './skeleton'

/**
 * The patch notes page, opened from the version badge: what changed in each
 * version, newest first, as the Markdown the GitHub release has. The notes
 * are the ones this build was made with (src/lib/release-notes.ts), so they
 * run up to the version it is on; a newer one is only named, since its notes
 * come with it.
 */

function day(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, inDisplayZone({ dateStyle: 'long' }))
}

function InlineText({ content }: { content: Inline[] }) {
  return content.map((part, index) =>
    part.kind === 'code' ? (
      <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{part.text}</code>
    ) : part.kind === 'strong' ? (
      <strong key={index} className="font-medium text-foreground">{part.text}</strong>
    ) : part.kind === 'link' ? (
      <a key={index} href={part.href} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">{part.text}</a>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    )
  )
}

/**
 * A release's Markdown, read as a page. Its sections (`##`) are the small
 * headings, its entries (`###`) what each says changed; the version above
 * them is the page's own heading.
 */
function Notes({ blocks }: { blocks: Block[] }) {
  return (
    <div className="text-sm leading-relaxed text-muted-foreground">
      {blocks.map((block, index) => {
        if (block.kind === 'heading' && block.level <= 2) {
          const text = block.content.map(part => part.text).join('')
          return (
            <h3
              key={index}
              className={cn(
                'mb-3 mt-8 border-b border-border pb-2 text-xs font-medium first:mt-0',
                text === 'Before you update' ? 'text-warning' : 'text-muted-foreground'
              )}
            >
              <InlineText content={block.content} />
            </h3>
          )
        }
        if (block.kind === 'heading') {
          return (
            <h4 key={index} className="mb-1.5 mt-5 text-base font-medium text-foreground">
              <InlineText content={block.content} />
            </h4>
          )
        }
        if (block.kind === 'list') {
          return (
            <ul key={index} className="mt-2 list-disc space-y-1 pl-5">
              {block.items.map((item, at) => (
                <li key={at}><InlineText content={item} /></li>
              ))}
            </ul>
          )
        }
        return (
          <p key={index} className="mt-2">
            <InlineText content={block.content} />
          </p>
        )
      })}
    </div>
  )
}

function ReleaseCard({ release, running }: { release: Release; running: boolean }) {
  const blocks = useMemo(() => parseMarkdown(release.markdown), [release.markdown])
  return (
    <article className="rounded-3xl border border-border bg-card p-5 @2xl/main:p-7">
      <header className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-lg font-medium text-foreground">v{release.version}</h2>
        {running && <Badge size="sm" tone="success">Running</Badge>}
        <span className="text-xs text-muted-foreground">{day(release.date)}</span>
      </header>
      <Notes blocks={blocks} />
    </article>
  )
}

export function PatchNotesPage() {
  const [releases, setReleases] = useState<Release[] | null>(null)
  const [status, setStatus] = useState<VersionStatus | null>(null)

  // Asked for once: the notes cannot change without the server being
  // replaced, and the page reloads then.
  useEffect(() => {
    let live = true
    fetch('/api/release-notes')
      .then(response => (response.ok ? response.json() : { releases: [] }))
      .then((body: { releases: Release[] }) => { if (live) setReleases(body.releases) })
      .catch(() => { if (live) setReleases([]) })
    fetch('/api/version')
      .then(response => (response.ok ? response.json() : null))
      .then((told: VersionStatus | null) => { if (live) setStatus(told) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const current = status?.current.version
  const newer = status?.updateAvailable && status.latest?.version ? status.latest.version : null

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Patch notes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What changed in each version, newest first.{current ? ` This server runs v${current}.` : ''}
          </p>
        </div>
      </header>

      <div className="max-w-3xl space-y-4 @2xl/main:space-y-6">
        {newer && (
          <Alert tone="info" title={`v${newer} is available`}>
            Its notes come with it: pull the latest image and recreate the container to update, and they are here.
          </Alert>
        )}
        {releases === null ? (
          <TraceSkeleton />
        ) : releases.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={20} strokeWidth={1.75} />}
            title="No patch notes in this build"
            description="Each published version carries the notes up to it. A build made from source has none, unless they are written with npm run release-notes."
          />
        ) : (
          releases.map(release => <ReleaseCard key={release.version} release={release} running={release.version === current} />)
        )}
      </div>
    </div>
  )
}
