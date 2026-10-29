'use client'

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpCircle, CircleCheck, ScrollText, Sparkles, TriangleAlert, Wrench } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { SearchField } from '@/components/arc/search-field/search-field'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { SearchResults } from '@/components/search-results'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'
import type { Release } from '@/lib/release-notes'
import type { VersionStatus } from '@/lib/version'
import { inDisplayZone } from '@/lib/time-zone'
import { cn } from '@/lib/utils'
import { PANE, PANE_HEADER, PANE_TITLE } from './pane-layout'

/**
 * The patch notes page, opened from the version in the sidebar: what changed
 * in each version, newest first, from the same Markdown as the GitHub release.
 * The notes are the ones this build was made with (src/lib/release-notes.ts),
 * so they run up to the version it is on; a newer one is only named, since its
 * notes are in the newer build.
 *
 * Read as a timeline: where this server stands at the top, then each release
 * with what it changed sorted by kind, the newest few open and the rest a
 * button away. It can be searched, and narrowed to one kind of change.
 */

/** Releases shown before "Show older versions". */
const SHOWN_AT_FIRST = 4

const UPDATE_COMMAND = 'docker compose pull && docker compose up -d'

// ─── The notes, as entries ──────────────────────────────────────────────────

type Kind = 'action' | 'new' | 'improved'

/** The sections a release's Markdown is written in (scripts/release-notes.mjs), by their headings. */
const KIND_OF_SECTION: Record<string, Kind> = {
  'Before you update': 'action',
  New: 'new',
  'Fixes and improvements': 'improved',
}

const KIND: Record<Kind, { label: string; plural: (count: number) => string; icon: ReactNode; tone: string }> = {
  action: {
    label: 'Before you update',
    plural: count => `${count} to act on`,
    icon: <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />,
    tone: 'bg-warning/15 text-warning',
  },
  new: {
    label: 'New',
    plural: count => `${count} new`,
    icon: <Sparkles size={14} strokeWidth={1.75} aria-hidden />,
    tone: 'bg-primary/15 text-primary',
  },
  improved: {
    label: 'Fixes and improvements',
    plural: count => `${count} ${count === 1 ? 'fix' : 'fixes'}`,
    icon: <Wrench size={14} strokeWidth={1.75} aria-hidden />,
    tone: 'bg-muted text-muted-foreground',
  },
}

const KINDS: Kind[] = ['action', 'new', 'improved']

/** One change: its heading, and what is said under it. */
interface Entry {
  kind: Kind
  title: Inline[]
  body: Block[]
  /** Everything in it as plain text, for searching. */
  text: string
}

interface Notes {
  release: Release
  entries: Entry[]
}

const plain = (content: Inline[]) => content.map(part => part.text).join('')

function blockText(block: Block): string {
  if (block.kind === 'list') return block.items.map(plain).join(' ')
  return plain(block.content)
}

/** A release's Markdown as its entries: each `###` under the `##` section it is in. */
export function entriesOf(markdown: string): Entry[] {
  const entries: Entry[] = []
  let kind: Kind = 'improved'
  let current: Entry | null = null
  for (const block of parseMarkdown(markdown)) {
    if (block.kind === 'heading' && block.level <= 2) {
      kind = KIND_OF_SECTION[plain(block.content)] ?? 'improved'
      current = null
    } else if (block.kind === 'heading') {
      current = { kind, title: block.content, body: [], text: plain(block.content) }
      entries.push(current)
    } else if (current) {
      current.body.push(block)
      current.text += ` ${blockText(block)}`
    } else {
      // Text under a section with no entry heading of its own.
      current = { kind, title: [], body: [block], text: blockText(block) }
      entries.push(current)
    }
  }
  return entries
}

// ─── Drawing them ───────────────────────────────────────────────────────────

function day(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, inDisplayZone({ dateStyle: 'medium' }))
}

/** How long ago, in days: what matters about a release is roughly how old it is. */
function age(iso: string, now: number): string | null {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return null
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)
  return months < 12 ? `${months} month${months === 1 ? '' : 's'} ago` : `${Math.round(days / 365)} year${days < 730 ? '' : 's'} ago`
}

/** Text with whatever was searched for picked out. */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (words.length === 0) return <>{text}</>
  const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-warning/25 px-0.5 text-foreground">{part}</mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        )
      )}
    </>
  )
}

function InlineText({ content, words }: { content: Inline[]; words: string[] }) {
  return content.map((part, index) =>
    part.kind === 'code' ? (
      <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{part.text}</code>
    ) : part.kind === 'strong' ? (
      <strong key={index} className="font-medium text-foreground"><Marked text={part.text} words={words} /></strong>
    ) : part.kind === 'link' ? (
      <a key={index} href={part.href} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">{part.text}</a>
    ) : (
      <Marked key={index} text={part.text} words={words} />
    )
  )
}

function EntryView({ entry, words }: { entry: Entry; words: string[] }) {
  const kind = KIND[entry.kind]
  return (
    <li className={cn('flex gap-3 rounded-2xl p-3 @2xl/main:p-4', entry.kind === 'action' ? 'border border-warning/40 bg-warning/5' : 'bg-muted/40')}>
      <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg', kind.tone)} title={kind.label}>
        {kind.icon}
        <span className="sr-only">{kind.label}</span>
      </span>
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-muted-foreground">
        {entry.title.length > 0 && (
          <h4 className="font-medium text-foreground">
            <InlineText content={entry.title} words={words} />
          </h4>
        )}
        {entry.body.map((block, index) =>
          block.kind === 'list' ? (
            <ul key={index} className="mt-2 list-disc space-y-1.5 pl-5 marker:text-border">
              {block.items.map((item, at) => (
                <li key={at}><InlineText content={item} words={words} /></li>
              ))}
            </ul>
          ) : (
            <p key={index} className="mt-1.5">
              <InlineText content={block.content} words={words} />
            </p>
          )
        )}
      </div>
    </li>
  )
}

function ReleaseView({ notes, running, words, now }: { notes: Notes; running: boolean; words: string[]; now: number }) {
  const { release, entries } = notes
  const counts = KINDS.map(kind => [kind, entries.filter(entry => entry.kind === kind).length] as const).filter(([, count]) => count > 0)
  const when = [day(release.date), age(release.date, now)].filter(Boolean).join(' · ')

  return (
    <article id={`v${release.version}`} className="relative scroll-mt-6 pl-7">
      {/* Its point on the line down the left. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-1.5 size-3.5 rounded-full border-2 border-background',
          running ? 'bg-success ring-4 ring-success/20' : 'bg-border'
        )}
      />
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="font-display text-xl font-medium tracking-tight text-foreground">v{release.version}</h2>
        {running && <Badge size="sm" tone="success">You are on this</Badge>}
        <span className="text-xs text-muted-foreground">{when}</span>
        <span className="flex flex-wrap gap-1.5 @2xl/main:ml-auto">
          {counts.map(([kind, count]) => (
            <Badge key={kind} size="sm" tone={kind === 'action' ? 'warning' : kind === 'new' ? 'info' : 'neutral'}>
              {KIND[kind].plural(count)}
            </Badge>
          ))}
        </span>
      </header>
      {entries.length > 0 ? (
        <ul className="space-y-2">
          {entries.map((entry, index) => (
            <EntryView key={index} entry={entry} words={words} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing written for this one.</p>
      )}
    </article>
  )
}

/** Where this server stands: up to date, behind, or not known. */
function Standing({ status, releases }: { status: VersionStatus | null; releases: Release[] }) {
  if (!status) return <div className="h-[88px] animate-pulse rounded-3xl bg-muted motion-reduce:animate-none" aria-hidden="true" />
  const current = status.current.version
  const newer = status.updateAvailable && status.latest?.version ? status.latest.version : null

  if (newer) {
    return (
      <section className="space-y-3 rounded-3xl border border-warning/40 bg-warning/5 p-4 @2xl/main:p-6">
        <div className="flex items-start gap-3">
          <ArrowUpCircle size={20} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <h2 className="font-medium text-foreground">v{newer} is available</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              This server runs v{current}. Update it to read what changed: pull the new image and recreate the container.
            </p>
          </div>
        </div>
        <CodeBlock code={UPDATE_COMMAND} language="bash" filename="With Docker Compose" />
      </section>
    )
  }

  const latest = status.updateAvailable === false
  const built = releases.find(release => release.version === current)
  return (
    <section className="flex items-start gap-3 rounded-3xl border border-border bg-card p-4 @2xl/main:p-6">
      <CircleCheck size={20} strokeWidth={1.75} aria-hidden className={cn('mt-0.5 shrink-0', latest ? 'text-success' : 'text-muted-foreground')} />
      <div className="min-w-0">
        <h2 className="font-medium text-foreground">
          {status.current.development ? `A development build (v${current})` : latest ? `You are on the latest version, v${current}` : `This server runs v${current}`}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {status.current.development
            ? 'Not a published version, so there is nothing to compare it with.'
            : latest
              ? `Released ${built ? day(built.date) : 'recently'}. A newer version is looked for every quarter of an hour.`
              : status.latestUnknownBecause ?? 'Whether a newer one is out is not known.'}
        </p>
      </div>
    </section>
  )
}

/** The versions down the side, to jump to one. */
function VersionIndex({ notes, current, onJump }: { notes: Notes[]; current?: string; onJump: (version: string) => void }) {
  return (
    <nav aria-label="Versions" className="sticky top-6 hidden max-h-[calc(100vh-3rem)] overflow-y-auto pr-1 @5xl/main:block">
      <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">Versions</p>
      <ul className="space-y-0.5">
        {notes.map(({ release, entries }) => (
          <li key={release.version}>
            <button
              type="button"
              onClick={() => onJump(release.version)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
            >
              <span className={cn('font-mono text-xs', release.version === current ? 'text-success' : 'text-foreground')}>v{release.version}</span>
              {entries.some(entry => entry.kind === 'action') && <span className="size-1.5 rounded-full bg-warning" title="Something to do before updating" />}
              {entries.some(entry => entry.kind === 'new') && <span className="size-1.5 rounded-full bg-primary" title="Something new" />}
              <span className="ml-auto text-[11px] text-muted-foreground">{day(release.date)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

type Show = 'all' | Kind

export function PatchNotesPage() {
  const [releases, setReleases] = useState<Release[] | null>(null)
  const [status, setStatus] = useState<VersionStatus | null>(null)
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [allShown, setAllShown] = useState(false)
  const [now] = useState(() => Date.now())

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

  const all = useMemo(() => (releases ?? []).map(release => ({ release, entries: entriesOf(release.markdown) })), [releases])
  const counts = useMemo(() => {
    const total = { all: 0, action: 0, new: 0, improved: 0 }
    for (const { entries } of all) for (const entry of entries) { total.all++; total[entry.kind]++ }
    return total
  }, [all])

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const narrowed = words.length > 0 || show !== 'all'
  const listed = all
    .map(({ release, entries }) => {
      // A version searched for by its number shows the whole of it.
      const byVersion = words.length > 0 && words.every(word => `v${release.version}`.includes(word))
      return {
        release,
        entries: entries.filter(
          entry =>
            (show === 'all' || entry.kind === show) &&
            (byVersion || words.every(word => entry.text.toLowerCase().includes(word)))
        ),
      }
    })
    .filter(notes => !narrowed || notes.entries.length > 0)
  const shown = narrowed || allShown ? listed : listed.slice(0, SHOWN_AT_FIRST)
  const current = status?.current.version

  const jump = (version: string) => {
    if (!shown.some(notes => notes.release.version === version)) setAllShown(true)
    requestAnimationFrame(() => document.getElementById(`v${version}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Patch notes</h1>
          <p className="mt-1 text-sm text-muted-foreground">What changed in each version of ClearPing, newest first.</p>
        </div>
      </header>

      <div className="grid gap-6 @5xl/main:grid-cols-[minmax(0,48rem)_14rem] @5xl/main:gap-10">
        <div className="min-w-0 space-y-6">
          <Standing status={status} releases={releases ?? []} />

          {releases === null ? (
            <div className="space-y-3" aria-hidden="true">
              {[0, 1, 2].map(row => (
                <div key={row} className="h-24 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
              ))}
            </div>
          ) : releases.length === 0 ? (
            <EmptyState
              icon={<ScrollText size={20} strokeWidth={1.75} />}
              title="No patch notes in this build"
              description="Each published version carries the notes up to it. A build made from source has none, unless they are written with npm run release-notes."
            />
          ) : (
            <>
              <div className="flex flex-col gap-2 @3xl/main:flex-row @3xl/main:items-center">
                <div className="relative min-w-0 flex-1 [&_label]:sr-only">
                  <SearchField label="Search the patch notes" placeholder="Search the notes or a version" value={query} onValueChange={setQuery} />
                </div>
                <SegmentedControl
                  label="Which changes"
                  value={show}
                  onValueChange={value => setShow(value as Show)}
                  options={[
                    { value: 'all', label: `All ${counts.all}` },
                    { value: 'new', label: `New ${counts.new}` },
                    { value: 'improved', label: `Fixes ${counts.improved}` },
                    ...(counts.action > 0 ? [{ value: 'action', label: `Before you update ${counts.action}` }] : []),
                  ]}
                />
              </div>

              <SearchResults query={`${show}|${words.join(' ')}|${allShown}`}>
                {shown.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    Nothing in the notes matches.
                  </p>
                ) : (
                  // The line the releases hang from.
                  <div className="relative space-y-8 before:absolute before:bottom-2 before:left-[6px] before:top-2 before:w-0.5 before:rounded-full before:bg-border">
                    {shown.map(notes => (
                      <ReleaseView key={notes.release.version} notes={notes} running={notes.release.version === current} words={words} now={now} />
                    ))}
                  </div>
                )}
              </SearchResults>

              {!narrowed && listed.length > SHOWN_AT_FIRST && (
                <div className="pl-7">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setAllShown(value => !value)}>
                    {allShown ? 'Show fewer' : `Show ${listed.length - SHOWN_AT_FIRST} older versions`}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {all.length > 1 && <VersionIndex notes={all} current={current} onJump={jump} />}
      </div>
    </div>
  )
}
