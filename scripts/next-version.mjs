#!/usr/bin/env node
// The version the next build of main is published as. CI runs this to number
// the build (.github/workflows/docker.yml); run it from the repository root,
// with the tags fetched, to see the number a push would get.
//
//   node scripts/next-version.mjs
//
// One more than the last release, by however much the commits since then ask
// for. A commit asks with a trailer in its message, beside Co-Authored-By:
//
//   Release: minor     something new a user would notice
//   Release: major     an upgrade that needs the user to do something
//
// The biggest one among the commits going out wins, and the rest are patches,
// which need nothing. package.json's version is a floor: setting it higher by
// hand makes that the next version.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/
const BUMPS = ['patch', 'minor', 'major']

function parse(version) {
  const match = PLAIN.exec(version)
  return match ? match.slice(1).map(Number) : null
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * The next version from package.json's, the release tags so far (`v1.2.3`)
 * and the Release trailers of the commits since the last of them. Throws on a
 * trailer that is not patch, minor or major, so a typo stops the build rather
 * than going out as the wrong number.
 *
 * @param {string} base package.json's version
 * @param {string[]} tags every tag in the repository
 * @param {{commit: string, release: string}[]} requests one per Release trailer
 * @returns {{version: string, last: string | null, bump: string}}
 */
export function nextVersion(base, tags, requests) {
  const floor = parse(base)
  if (!floor) throw new Error(`package.json's version ${base} is not MAJOR.MINOR.PATCH`)

  const released = tags
    .map(tag => (tag.startsWith('v') ? parse(tag.slice(1)) : null))
    .filter(Boolean)
    .sort(compare)
  const last = released.at(-1) ?? null

  let bump = 'patch'
  for (const { commit, release } of requests) {
    const asked = release.trim().toLowerCase()
    if (!BUMPS.includes(asked)) {
      throw new Error(`commit ${commit} has "Release: ${release}"; it must be patch, minor or major`)
    }
    if (BUMPS.indexOf(asked) > BUMPS.indexOf(bump)) bump = asked
  }

  let next = floor
  if (last) {
    const [major, minor, patch] = last
    const counted =
      bump === 'major' ? [major + 1, 0, 0] : bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1]
    if (compare(counted, floor) > 0) next = counted
  }
  return { version: next.join('.'), last: last && `v${last.join('.')}`, bump }
}

/** The same, read from this checkout. */
export function nextVersionHere() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
  const base = JSON.parse(readFileSync('package.json', 'utf8')).version
  const tags = git('tag', '--list', 'v*').split(/\r?\n/).filter(Boolean)
  const { last } = nextVersion(base, tags, [])

  // Only the commits going out. Before the first release there is nothing to
  // count from, and package.json's version is the one.
  const requests = []
  if (last) {
    const log = git('log', '--format=%h%x09%(trailers:key=Release,valueonly,separator=%x1f)', `${last}..HEAD`)
    for (const line of log.split(/\r?\n/)) {
      const [commit, values] = line.split('\t')
      if (values) for (const release of values.split('\x1f')) requests.push({ commit, release })
    }
  }
  return nextVersion(base, tags, requests)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version, last, bump } = nextVersionHere()
  if (process.argv.includes('--explain')) console.error(`last release ${last ?? 'none'}, ${bump}`)
  console.log(version)
}
