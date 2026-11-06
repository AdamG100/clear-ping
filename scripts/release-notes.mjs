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

/**
 * Commits that went out without the trailer they should have had, by full
 * hash, and the one they should have had. A commit message cannot be changed
 * once it is pushed, and every build writes the notes of every release again
 * from them, so this is where a note filed in the wrong part is put right.
 */
export const RELEASE_CORRECTIONS = {
  // 0.16.0: the trailer was only on the last commit of the push.
  a284aa625e9c0b890ae9f20c18fbe447038c24cb: 'minor', // Maintenance step by step, on a schedule by default
  '97fd9e91c275912642346dda177e39a1d83765e8': 'minor', // The reworked Overview
}

/**
 * Notes already out that said what only someone working on ClearPing needs
 * (its CI, tests, tooling, files and how it is built) rather than what changed
 * for someone running it, by full hash. `null` leaves the note out; otherwise
 * `title` or `paragraphs` replace the note's own, `drop` leaves out each
 * paragraph that starts with one of its strings, and `replace` swaps text
 * inside the paragraphs. A commit from here on that is only for the people
 * working on ClearPing says `Notes: internal` instead (see INTERNAL).
 *
 * @type {Record<string, null | { title?: string, paragraphs?: string[], drop?: string[], replace?: [string, string][] }>}
 */
export const NOTE_CORRECTIONS = {
  // Tooling, CI and tests: nothing changed for anyone running ClearPing.
  '8b71a9dcb223d7cb227f40e3d104160717b8f7a6': null, // A pull request review skill
  '00e0681354774cf46af81025f4a4afba9237e8df': null, // A security scan on pull requests
  d482ca0ca766642668cbecd899b7135560aeb285: null, // The registry sign-in step
  aac2d3008a558dee4204c4165f4b8838aef19c2b: null, // A typo in the build's check for changes
  e6a58b0392ee729bdefa8aa7604049efecc9f88e: null, // A flaky test
  '058723ed04b7d792a57bf3f4e6cc2565d4ee8af8': null, // Skipping empty builds
  '83defab498d93a1482521dc63847e27821b71d5e': null, // Skipping builds of docs and tests
  '6fbeae1d8b9e618f4c9ad0c2138e4e56d2b1bf06': null, // How the security review is run
  '67ba1a977f8c101f224d26524a13703b8b9633c7': null, // A slow test's time limit
  d18bb506ad8888d0d7a4132c93e108e525964304: null, // A line in the structure guide
  '1cef47d89f3a4af22ca7388f3d2483828a5bcbae': null, // The build's actions
  '70b6a8b1bf02707c31143526d01b3406994dc2e6': null, // A package that broke the build, never an image
  ac3a97dc59b1f303678143b278b12b9b59876f1b: null, // How the version number is chosen
  '9496c1ce848936d0b95168c4f87b21043a16239f': null, // A deploy skill
  '7a044eb56888e5fa140eba1895443f23e25b79b5': null, // The starter template's files
  '89d0ab4ed53304e7ffb5fcac2196a3a0be2deb1d': null, // Colour values in the code
  '888a23c5c3c1ef76f0e4d9ec3fe7373497353dbc': null, // A rename that was undone

  // Notes for users that also told of files, tools, tests and commits.
  '15b55d08db7869ba4a9f99ae322cf2dd7df954df': {
    title: 'Keep Node.js up to date automatically',
    paragraphs: ['New Node.js versions are picked up, tested and released automatically.'],
  },
  e6ba5d6b4d3dc94311a48859f01270748c708225: {
    paragraphs: [
      'better-auth, Next.js, Tailwind, motion, lucide-react and the rest of what ClearPing is built on are on their newest versions, and none of them has an open security advisory.',
    ],
  },
  a384e3fe659eecbcd1071585e5798702378ae166: {
    replace: [
      [
        'The notes are written from the commit messages that go out in each release, under Before you update, New, and Fixes and improvements.',
        'Each release is set out under Before you update, New, and Fixes and improvements.',
      ],
    ],
  },
  '20e0ccf0561339206e5670fe25d5f22ee414f8b5': {
    paragraphs: [
      'Both images, the dashboard and the probe agent, and so the probe agent binaries built from it, now start from Node.js 26.12.1, and running from source asks for 26.12.1 or newer.',
    ],
  },
  '16859552bb0813004262395694e03921dd8d60d9': {
    title: 'Refresh what AI assistants are told about ClearPing',
    paragraphs: ['The instructions an assistant gets over MCP now mention game server checks, and no longer say that every tool only reads.'],
  },
  ce79ea87107bdd35106759a295e2c0c998dc1362: {
    title: 'Add probe agents, game server checks and password resets',
    drop: ['Layout:'],
    replace: [
      [' (docs/probe-agents.md)', ''],
      [' Under npm run dev the dashboard opens signed in as a dev admin.', ''],
    ],
  },
  '600472d7cf1684952f4fbbab179366e30bcb1f38': {
    title: 'Close the gaps found in a security review',
    replace: [["- Pin actions to SHAs, the Node image to a digest, and Apprise's packages by hash; add Dependabot", "- Pin the Node image to a digest and Apprise's packages by hash"]],
  },
  '83ae490e48269e26342e603b11814b915ca9dcfa': {
    replace: [[' It also updates the dashboard page parser and tests to recognize and round-trip the new target URLs.', '']],
  },
  fc905228478ba7b48cf85179a83703203e940863: {
    replace: [
      [
        'This also includes database/index tuning, retention cleanup, and new tests covering maintenance settings, scheduled runs, and path-loss calculations.',
        'It also tunes the database and its indexes, and clears out old data.',
      ],
    ],
  },
  daafac0b2faa178fa19fc8535b6672a8029ce0c1: { replace: [['This commit fixes', 'Fixes']] },
  d0b5aa65fca7df1fbd2e1e36807fbdd311eb9005: { drop: ['CLAUDE.md says'] },
  '2b95e2361fc14b118daaa6463b48a0d84885bab9': {
    drop: ['CLAUDE.md notes'],
    replace: [[', installed into src/components/arc with the shadcn CLI, in place of the shadcn primitives that were there', '']],
  },
  '979fffe3a6c139f12647dea3ab73bed1c833737f': { drop: ['- Its username plugin', '- Activity noted during'] },
  '043bdc14032f8c3d649c57b6e772c68dc0803e67': {
    replace: [['Moving between them is history.pushState, which Next.js follows, so nothing reloads', 'Moving between them reloads nothing']],
  },
  c32a79594cefb0de2e36ca2654d756d7f7e27cee: {
    paragraphs: [
      'Each release now has a version number. The sidebar shows the running version under the ClearPing name, and whether it is the latest: a green dot is the latest, an amber one links to the newer release, and a page left open across an update says to reload. The check asks the image registry once an hour; CLEARPING_UPDATE_CHECK=off stops it.',
      'GET /api/version answers the same as JSON, and the assistant tools report it too.',
    ],
  },
  '4332c84ec895f11b512e14e1bf9b66eaa45806a2': {
    title: 'Tooltips on icon buttons, and clearer AI assistant setup',
    paragraphs: [
      "Icon-only buttons now say what they do in a tooltip, in place of the browser's own. The AI assistant setup explains how to connect Claude Desktop and other clients, for a ClearPing on your own network or one reachable from the internet.",
    ],
  },
  '7587d2b650e90ce082d42a19e14b4a848ff6a3cf': { drop: ['Housekeeping', '- .env.example'] },
  '1b455ce1ec3e8484781a2fc2eda04b509aacb549': {
    paragraphs: [
      "On a phone or tablet the dashboard offers to install itself as an app, with steps for Android over HTTPS and for the iOS Share menu, and remembers if you dismiss it. On a wide screen the sidebar folds to a narrow rail that keeps each group's health in view, and remembers being folded.",
    ],
  },
  '7b1f7f9af61e3bd66fba57d4ebe03c2e3158de39': {
    title: 'Publish images for x64 and ARM64',
    paragraphs: ['Each image is published for both x64 and ARM64 under one name, so docker pull picks the one for your machine.'],
  },
  '7ff3d11fb449f53ec6a2b626b63452f2dbda6c3a': {
    title: 'Keep databases out of the Docker image',
    paragraphs: ['The image never carries a database, so a new container always starts empty, with no targets. It is now built on Debian trixie.'],
  },
  '324cac86869729efc1f7606a40fff7a23120c2b6': {
    paragraphs: [
      'A production Docker image for the dashboard and the scheduler. It includes ping and traceroute, runs as a non-root user, and keeps its SQLite data in a mounted /data volume.',
    ],
  },
  '3c217d072f66bde86d27da1c325fe041486fc2d1': {
    drop: ['- New columns:', 'TESTS AND DOCS', '- 270 tests', '- docs/automatic-probing.md', 'Verified:'],
    replace: [
      [
        '- targets.probe_type and alert_rules.metric carried CHECK constraints that made every new probe or metric a table rebuild. Both tables are rebuilt once without them; a VACUUM INTO backup is written first.',
        '- The database is rebuilt once, to make room for new probes and metrics, with a backup written first.',
      ],
    ],
  },
  '57befa0d15f05bc7a55b341b59baf0bfc38aac17': {
    drop: ['- Adds scripts/prober.ts', 'TESTING', '- Adds vitest', '- next 16.1.4', '- Holds back eslint', '- Removes recharts', 'Verified:'],
  },
  dbd9fabeddde3107e10aceb68b7934cedd4d0870: {
    title: 'Combine the latency and packet loss charts',
    paragraphs: [
      'Latency and packet loss are now one chart: the latency line takes the colour of the loss at each moment, with a band for jitter and a marker where some packets were lost.',
      'Targets can be dragged from one group into another in the sidebar.',
    ],
  },
  '974e9ee9c22f9838ffe92ef4264f71daf1255ec4': {
    paragraphs: [
      "Groups and targets can be put in any order by dragging them in the sidebar, and the order is kept. The sidebar also has search, add and edit dialogs, groups that fold, and badges for status and type. The latency chart's tooltip uses plainer labels and units, and marks partial packet loss.",
    ],
  },
  c041ab49c2d31d5e1c1e3af432c43e6d7fb09bde: {
    title: 'Add jitter, and fix the time ranges',
    paragraphs: ['Each reading now records jitter, with its lowest and highest shown beside the rest. The 5-hour range is now 6 hours.'],
  },
  df52910047eb8f330a04877761f4f2eb864bbb49: {
    title: 'Show missing readings as gaps, and measure DNS jitter from answers only',
    paragraphs: [
      "Charts mark a missing reading as No data, in grey, instead of drawing it as zero, and the cards show 0 ms or N/A rather than nothing. A DNS check's latency and jitter now count only the queries that were answered, so failures no longer skew them.",
    ],
  },
  '8d9bc7c49c39ce3d7e361cce0eb00098379b7516': {
    title: 'Animate the trend on each card',
    paragraphs: ['The trend arrow and figure on a card now ease to their new value when they change.'],
  },
  '5172770b671ab05d9a34550ed564c774f58f6692': {
    title: 'The first version of ClearPing',
    paragraphs: ['A network monitor that probes your targets on a schedule, keeps their readings in SQLite and shows them on a dashboard.'],
  },
}

/** A note as corrected in NOTE_CORRECTIONS, or null when it is left out. */
export function corrected(note, correction) {
  if (correction === undefined) return note
  if (correction === null) return null
  const replaced = (correction.paragraphs ?? note.paragraphs).map(paragraph =>
    (correction.replace ?? []).reduce((text, [from, to]) => text.split(from).join(to), paragraph)
  )
  const paragraphs = replaced.filter(paragraph => paragraph.trim() && !(correction.drop ?? []).some(start => paragraph.startsWith(start)))
  return { ...note, title: correction.title ?? note.title, paragraphs }
}

/**
 * A commit whose message is for whoever works on ClearPing, not whoever runs
 * it (CI, tests, tooling, the repo's own guides), ends with this trailer and
 * has no note at all.
 */
const INTERNAL = /^Notes:\s*internal\s*$/im

/** Trailers are for git and CI, not for the reader. */
const TRAILER = /^(Co-Authored-By|Release|Notes|Signed-off-by|Reviewed-by|Change-Id|Refs?):/i

/**
 * One commit as an entry in the notes, or null for one marked `Notes:
 * internal`. The body's hard-wrapped lines are joined into paragraphs again,
 * keeping list items on lines of their own.
 *
 * @param {{ subject: string, body: string, release?: string }} commit
 * @returns {{ title: string, paragraphs: string[], kind: string } | null}
 */
export function noteFor({ subject, body, release }) {
  if (INTERNAL.test(body)) return null
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
  const log = git('log', '--no-merges', '--format=%H%x1f%s%x1f%(trailers:key=Release,valueonly,separator=%x2c)%x1f%b%x1e', range)
  return log
    .split('\x1e')
    .map(entry => entry.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(entry => {
      const [hash, subject, release, body = ''] = entry.split('\x1f')
      const note = noteFor({ subject, release: RELEASE_CORRECTIONS[hash] ?? release.split(',')[0], body })
      return note && corrected(note, NOTE_CORRECTIONS[hash])
    })
    .filter(note => note !== null)
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
