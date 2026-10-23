#!/usr/bin/env node
// Patch notes, written from the commit messages. Each commit going out is an
// entry: its subject the heading, its body the text, and its Release: trailer
// (scripts/next-version.mjs) which part of the notes it goes in. A commit
// message is written for whoever reads the notes, so nothing else is needed.
//
//   node scripts/release-notes.mjs --markdown --version 1.4.0
//       the notes for what is going out as 1.4.0: the commits since the last
//       release, as Markdown for its GitHub release
//   node scripts/release-notes.mjs --json --version 1.4.0 --out release-notes.json
//       every release so far and the one going out, for the dashboard's patch
//       notes (src/lib/release-notes.ts); CI writes it into the image
//
// Run from the repository root with the tags fetched. Without --version the
// commits since the last release are left out.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLAIN = /^v(\d+)\.(\d+)\.(\d+)$/

/** What a commit's Release: trailer makes of it, as the part of the notes it goes in. */
const KINDS = { major: 'action', minor: 'new', patch: 'improved' }

/** The parts of the notes, in the order they are read. */
export const SECTIONS = [
  { kind: 'action', title: 'Before you update' },
  { kind: 'new', title: 'New' },
  { kind: 'improved', title: 'Fixes and improvements' },
]

/** Trailers are for git and CI, not for the reader. */
const TRAILER = /^(Co-Authored-By|Release|Signed-off-by|Reviewed-by|Change-Id|Refs?):/i

/**
 * One commit as an entry in the notes. The body's hard-wrapped lines are
 * joined into paragraphs again, keeping list items on lines of their own.
 *
 * @param {{ subject: string, body: string, release?: string }} commit
 * @returns {{ title: string, paragraphs: string[], kind: string }}
 */
export function noteFor({ subject, body, release }) {
  const lines = body.split(/\r?\n/).filter(line => !TRAILER.test(line.trim()))
  const paragraphs = []
  let current = []
  const flush = () => {
    if (current.length) paragraphs.push(current.join(' '))
    current = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) flush()
    else if (/^[-*] /.test(line)) {
      flush()
      current.push(line)
    } else current.push(line)
  }
  flush()

  const asked = (release ?? '').trim().toLowerCase()
  return { title: subject.trim(), paragraphs, kind: KINDS[asked] ?? 'improved' }
}

/**
 * A release's notes as Markdown, for its GitHub release.
 *
 * @param {{ notes: ReturnType<typeof noteFor>[] }} release
 */
export function markdownFor({ notes }) {
  if (notes.length === 0) return 'Nothing but the version number changed.\n'
  return SECTIONS.flatMap(({ kind, title }) => {
    const these = notes.filter(note => note.kind === kind)
    if (these.length === 0) return []
    return [`## ${title}`, '', ...these.flatMap(note => [`### ${note.title}`, '', ...note.paragraphs.flatMap(p => [p, '']) ])]
  }).join('\n')
}

// ─── Reading git ────────────────────────────────────────────────────────────

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** The commits in a range, newest first, as notes. Merges are left out: their commits are there already. */
function notesBetween(range) {
  const log = git('log', '--no-merges', '--format=%s%x1f%(trailers:key=Release,valueonly,separator=%x2c)%x1f%b%x1e', range)
  return log
    .split('\x1e')
    .map(entry => entry.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(entry => {
      const [subject, release, body = ''] = entry.split('\x1f')
      return noteFor({ subject, release: release.split(',')[0], body })
    })
}

/**
 * Every release, newest first, with the notes for what went out in it as
 * Markdown: the same for the dashboard as for the GitHub release. With
 * `version`, the commits since the last release come first as that version,
 * dated now: the release CI is about to make.
 *
 * @param {{ version?: string }} [options]
 */
export function releaseHistory({ version } = {}) {
  const tags = git('tag', '--list', 'v*', '--sort=v:refname').split(/\r?\n/).filter(tag => PLAIN.test(tag))
  const releases = tags.map((tag, index) => ({
    version: tag.slice(1),
    date: git('log', '-1', '--format=%cI', tag).trim(),
    notes: notesBetween(index === 0 ? tag : `${tags[index - 1]}..${tag}`),
  }))

  if (version && !tags.includes(`v${version}`)) {
    const since = tags.at(-1)
    releases.push({ version, date: new Date().toISOString(), notes: notesBetween(since ? `${since}..HEAD` : 'HEAD') })
  }
  return releases.reverse().map(({ notes, ...release }) => ({ ...release, markdown: markdownFor({ notes }) }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const option = name => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const version = option('--version')
  const history = releaseHistory({ version })

  let output
  if (args.includes('--markdown')) {
    const release = history.find(each => each.version === version)
    if (!release) throw new Error('--markdown needs the --version going out')
    output = release.markdown
  } else {
    output = JSON.stringify(history, null, 2) + '\n'
  }

  const out = option('--out')
  if (out) writeFileSync(out, output)
  else process.stdout.write(output)
}
