import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The patch notes this build was made with: every release up to and including
 * its own, newest first.
 *
 * CI writes them from the commit messages (scripts/release-notes.mjs) into
 * `release-notes.json` beside the server, the same Markdown as on the GitHub
 * release. A build CI did not make has none, unless the file has been made by
 * hand with `npm run release-notes`.
 */

export interface Release {
  /** MAJOR.MINOR.PATCH, without the v. */
  version: string
  /** ISO 8601. */
  date: string
  /** What changed, in sections: Before you update, New, Fixes and improvements (see src/lib/markdown.ts). */
  markdown: string
}

const FILE = 'release-notes.json'

/** The notes, or an empty list where this build has none. */
export async function releaseNotes(): Promise<Release[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(process.cwd(), FILE), 'utf8'))
    return Array.isArray(parsed) ? (parsed as Release[]) : []
  } catch {
    return []
  }
}
