import type { IpVersion, ProbeConfig, ProbeType, TargetDefinition } from '@/types/probe'
import { validateTargetDefinition } from './target-definition'

/**
 * Share links: a list of targets packed into a link, to be unpacked by another
 * ClearPing.
 *
 * The link is the list. Nothing is stored for it on the server it came from,
 * which is the point: the two installations are usually on different networks
 * and could not reach each other to fetch anything. The targets sit after the
 * `#`, the part of an address a browser keeps to itself, so opening a link
 * does not write them into a server's log either.
 *
 * A link carries what the targets are and nothing they have recorded, and
 * never an alert: where an alert is sent is a URL with a password in it.
 *
 * Pure, with no Node imports: links are made and read in the browser.
 */

/** What a share code starts with. The digit is the format, should it ever change. */
const CODE_PREFIX = 'cp1.'
const CODE_PATTERN = /cp1\.[A-Za-z0-9_-]+/

/** More than anyone shares, and few enough for a link to be checked in an instant. */
export const MAX_SHARED_TARGETS = 500

/** What an honest link of that many targets unpacks to, several times over. */
const MAX_UNPACKED_BYTES = 1_000_000

const DEFAULT_INTERVAL = 300

/**
 * A target as it is written into a link. Links are pasted into chats that cut
 * long messages short, so the keys are single letters and anything left at its
 * usual value is not written at all.
 */
interface PackedTarget {
  h: string
  /** Left out when it is the address. */
  n?: string
  p?: ProbeType
  i?: number
  v?: IpVersion
  g?: string
  c?: ProbeConfig
}

function pack(target: TargetDefinition): PackedTarget {
  const packed: PackedTarget = { h: target.host }
  if (target.name !== target.host) packed.n = target.name
  if (target.probeType !== 'ping') packed.p = target.probeType
  if (target.interval !== DEFAULT_INTERVAL) packed.i = target.interval
  if (target.ipVersion !== 'auto') packed.v = target.ipVersion
  if (target.group) packed.g = target.group
  if (Object.keys(target.probeConfig).length > 0) packed.c = target.probeConfig
  return packed
}

/** Null for anything that is not a target this ClearPing could add. */
function unpack(packed: unknown): TargetDefinition | null {
  if (!packed || typeof packed !== 'object') return null
  const { h, n, p, i, v, g, c } = packed as Record<string, unknown>

  const checked = validateTargetDefinition({
    name: n ?? h,
    host: h,
    probeType: p ?? 'ping',
    interval: i ?? DEFAULT_INTERVAL,
    ipVersion: v ?? 'auto',
    group: g,
    probeConfig: c,
  })
  return checked.ok ? checked.target : null
}

// ─── Bytes ──────────────────────────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Run bytes through a compressor or its opposite, giving up past `limit` bytes out. */
async function streamThrough(
  bytes: Uint8Array<ArrayBuffer>,
  through: CompressionStream | DecompressionStream,
  limit = Infinity
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes]).stream().pipeThrough<Uint8Array>(through).getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    // A few hundred bytes can be made to unpack into gigabytes.
    if (size > limit) {
      await reader.cancel()
      throw new Error('Share link unpacks to more than a share link holds')
    }
    chunks.push(value)
  }

  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

// ─── Links ──────────────────────────────────────────────────────────────────

/** Pack targets into a share code: the part of a link that is the list. */
export async function encodeShare(targets: TargetDefinition[]): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(targets.map(pack)))
  return CODE_PREFIX + toBase64Url(await streamThrough(json, new CompressionStream('deflate')))
}

/**
 * The link for a share code. It opens the import on the ClearPing at `origin`,
 * and pasted into the import box of any other it is read just the same.
 */
export function shareLinkFor(origin: string, code: string): string {
  return `${origin}/#import=${code}`
}

/** The share code in a link, or in anything else it has been pasted along with. */
export function extractShareCode(text: string): string | null {
  return CODE_PATTERN.exec(text ?? '')?.[0] ?? null
}

export type ShareDecoding =
  | {
      ok: true
      targets: TargetDefinition[]
      /** Entries that were not targets this ClearPing could add, and were left out. */
      skipped: number
    }
  | { ok: false; error: string }

const NOT_A_LINK = 'That is not a ClearPing share link, or some of it is missing.'

/**
 * Read the targets out of a share link or code. Never throws: whatever was
 * pasted, the answer is the targets or a sentence saying why not.
 *
 * Everything in a link was written by somebody else, so each target is held to
 * the rules a typed one is, and what does not pass is counted and left out.
 */
export async function decodeShare(text: string): Promise<ShareDecoding> {
  const code = extractShareCode(text)
  if (!code) return { ok: false, error: NOT_A_LINK }

  let packed: unknown
  try {
    const compressed = fromBase64Url(code.slice(CODE_PREFIX.length))
    const json = await streamThrough(compressed, new DecompressionStream('deflate'), MAX_UNPACKED_BYTES)
    packed = JSON.parse(new TextDecoder().decode(json))
  } catch {
    return { ok: false, error: NOT_A_LINK }
  }

  if (!Array.isArray(packed)) return { ok: false, error: NOT_A_LINK }
  if (packed.length > MAX_SHARED_TARGETS) {
    return { ok: false, error: `A share link holds at most ${MAX_SHARED_TARGETS} targets.` }
  }

  const targets = packed.map(unpack).filter((target): target is TargetDefinition => target !== null)
  if (targets.length === 0) return { ok: false, error: 'There are no targets in that share link.' }

  return { ok: true, targets, skipped: packed.length - targets.length }
}

// ─── Files ──────────────────────────────────────────────────────────────────

/**
 * The same list as a file, for where a link does not suit: kept as a backup,
 * or sent by email or on a stick. Written out in full and readable, so it can
 * be looked over, or edited, before it is imported.
 */
export const EXPORT_KIND = 'clearping-targets'

/** A file bigger than this is not an export of targets. */
export const MAX_IMPORT_FILE_BYTES = 5_000_000

export interface TargetExport {
  kind: typeof EXPORT_KIND
  version: 1
  exportedAt: string
  targets: TargetDefinition[]
}

/** The file for these targets: its name, and what goes in it. */
export function exportTargets(targets: TargetDefinition[], now = new Date()): { fileName: string; text: string } {
  const file: TargetExport = { kind: EXPORT_KIND, version: 1, exportedAt: now.toISOString(), targets }
  return {
    fileName: `clearping-targets-${now.toISOString().slice(0, 10)}.json`,
    text: JSON.stringify(file, null, 2) + '\n',
  }
}

const NOT_A_FILE = 'That is not a ClearPing export of targets.'

/**
 * Read the targets out of an exported file. Never throws. Takes the file as
 * exported, or just its list of targets; and, as a link's targets are, holds
 * each to the rules a typed one is, leaving out and counting what fails.
 */
export function readTargetFile(text: string): ShareDecoding {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: NOT_A_FILE }
  }

  let entries: unknown
  if (Array.isArray(parsed)) {
    entries = parsed
  } else if (parsed && typeof parsed === 'object') {
    const file = parsed as Partial<TargetExport>
    if (file.kind !== EXPORT_KIND) return { ok: false, error: NOT_A_FILE }
    if (typeof file.version === 'number' && file.version > 1) {
      return { ok: false, error: 'That export is from a newer ClearPing. Update this one to import it.' }
    }
    entries = file.targets
  }
  if (!Array.isArray(entries)) return { ok: false, error: NOT_A_FILE }
  if (entries.length > MAX_SHARED_TARGETS) {
    return { ok: false, error: `At most ${MAX_SHARED_TARGETS} targets can be imported at once.` }
  }

  const targets = entries
    .map(entry => validateTargetDefinition(entry))
    .flatMap(checked => (checked.ok ? [checked.target] : []))
  if (targets.length === 0) return { ok: false, error: 'There are no targets in that file.' }

  return { ok: true, targets, skipped: entries.length - targets.length }
}

/**
 * Whatever was pasted or chosen to import: a share link, or the contents of an
 * exported file. Never throws.
 */
export async function decodeImport(text: string): Promise<ShareDecoding> {
  const trimmed = (text ?? '').trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return readTargetFile(trimmed)
  return decodeShare(trimmed)
}
