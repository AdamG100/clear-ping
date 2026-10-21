import { describe, expect, it } from 'vitest'
import type { TargetDefinition } from '@/types/probe'
import {
  MAX_SHARED_TARGETS,
  decodeImport,
  decodeShare,
  encodeShare,
  exportTargets,
  extractShareCode,
  readTargetFile,
  shareLinkFor,
} from './share'

const TARGETS: TargetDefinition[] = [
  { name: 'Router', host: '192.0.2.1', probeType: 'ping', ipVersion: 'auto', probeConfig: {}, interval: 300, group: 'Home/Network' },
  { name: 'example.com', host: 'example.com', probeType: 'ping', ipVersion: 'both', probeConfig: {}, interval: 60 },
  { name: 'Database', host: 'db.internal', probeType: 'tcp', ipVersion: 'auto', probeConfig: { port: 5432 }, interval: 30, group: 'Work' },
  {
    name: 'Sign-in page',
    host: 'example.com',
    probeType: 'http',
    ipVersion: 'ipv6',
    probeConfig: { scheme: 'https', path: '/login?next=%2F', expectedStatus: 200, keyword: 'Sign in' },
    interval: 600,
  },
  {
    name: 'Résolveur ☎',
    host: '2606:4700:4700::1111',
    probeType: 'dns',
    ipVersion: 'auto',
    probeConfig: { queryName: 'example.org', recordType: 'MX', expectedAnswer: 'mx.example.org' },
    interval: 300,
  },
]

/** A share code for whatever JSON is given, written the way a real one is. */
async function codeFor(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const packed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()
  return 'cp1.' + Buffer.from(packed).toString('base64url')
}

describe('share links', () => {
  it('brings every kind of target back exactly as it was sent', async () => {
    const decoded = await decodeShare(await encodeShare(TARGETS))
    expect(decoded).toEqual({ ok: true, targets: TARGETS, skipped: 0 })
  })

  it('makes a code that can sit in a link without being escaped', async () => {
    expect(await encodeShare(TARGETS)).toMatch(/^cp1\.[A-Za-z0-9_-]+$/)
  })

  it('is short enough to paste: far smaller than the targets written out', async () => {
    const many = Array.from({ length: 40 }, (_, index): TargetDefinition => ({
      name: `Server ${index}`,
      host: `server-${index}.example.com`,
      probeType: 'http',
      ipVersion: 'auto',
      probeConfig: { scheme: 'https', path: '/health' },
      interval: 300,
      group: 'Production/Web',
    }))
    const code = await encodeShare(many)
    expect(code.length).toBeLessThan(JSON.stringify(many).length / 4)
    expect(await decodeShare(code)).toMatchObject({ ok: true, targets: many })
  })

  it('is read out of a whole link, and out of whatever a link was pasted with', async () => {
    const code = await encodeShare(TARGETS)
    const link = shareLinkFor('https://ping.example.com', code)

    expect(link).toBe(`https://ping.example.com/#import=${code}`)
    expect(extractShareCode(link)).toBe(code)
    expect(extractShareCode(`#import=${code}`)).toBe(code)
    expect(extractShareCode(`Here are my probes:\n${link}\nlet me know`)).toBe(code)
    expect(await decodeShare(`  ${link}\n`)).toMatchObject({ ok: true, targets: TARGETS })
  })

  it('finds no code where there is none', () => {
    expect(extractShareCode('')).toBeNull()
    expect(extractShareCode('#section')).toBeNull()
    expect(extractShareCode('https://example.com/')).toBeNull()
  })
})

describe('exported files', () => {
  it('bring every kind of target back exactly as it was exported, under a dated name', () => {
    const { fileName, text } = exportTargets(TARGETS, new Date('2026-10-14T12:00:00Z'))
    expect(fileName).toBe('clearping-targets-2026-10-14.json')
    expect(JSON.parse(text)).toMatchObject({ kind: 'clearping-targets', version: 1 })
    expect(readTargetFile(text)).toEqual({ ok: true, targets: TARGETS, skipped: 0 })
  })

  it('take a bare list of targets too, as someone editing one by hand might leave it', () => {
    expect(readTargetFile(JSON.stringify(TARGETS.slice(0, 2)))).toMatchObject({ ok: true, targets: TARGETS.slice(0, 2) })
  })

  it('leave out, and count, entries that are not targets', () => {
    const text = JSON.stringify({ kind: 'clearping-targets', version: 1, targets: [TARGETS[0], { host: '' }, 'nonsense'] })
    expect(readTargetFile(text)).toMatchObject({ ok: true, targets: [TARGETS[0]], skipped: 2 })
  })

  it('say so for what is not an export, or one from a newer ClearPing', () => {
    for (const text of ['', 'not json', '{"kind":"something-else","targets":[]}', '{"kind":"clearping-targets"}', '[]']) {
      expect(readTargetFile(text).ok).toBe(false)
    }
    expect(readTargetFile('{"kind":"clearping-targets","version":2,"targets":[]}')).toMatchObject({ ok: false, error: expect.stringContaining('newer') })
    const tooMany = JSON.stringify(Array.from({ length: MAX_SHARED_TARGETS + 1 }, () => TARGETS[0]))
    expect(readTargetFile(tooMany)).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_SHARED_TARGETS)) })
  })

  it('import from a file or a link alike', async () => {
    expect(await decodeImport(exportTargets(TARGETS).text)).toMatchObject({ ok: true, targets: TARGETS })
    expect(await decodeImport(shareLinkFor('https://ping.example', await encodeShare(TARGETS)))).toMatchObject({ ok: true, targets: TARGETS })
  })
})

describe('decodeShare', () => {
  it('says so when what was pasted is not a share link', async () => {
    for (const text of ['', 'hello', 'https://example.com/#import=', 'cp1.not-really-a-link', 'cp1.AAAA']) {
      const decoded = await decodeShare(text)
      expect(decoded.ok, text).toBe(false)
    }
  })

  it('says so when a link has lost its end', async () => {
    const code = await encodeShare(TARGETS)
    expect((await decodeShare(code.slice(0, code.length - 12))).ok).toBe(false)
  })

  it('refuses a payload that is not a list of targets', async () => {
    expect((await decodeShare(await codeFor({ h: 'example.com' }))).ok).toBe(false)
    expect((await decodeShare(await codeFor([]))).ok).toBe(false)
  })

  it('fills in what a link leaves out as usual', async () => {
    expect(await decodeShare(await codeFor([{ h: 'example.com' }]))).toEqual({
      ok: true,
      targets: [{ name: 'example.com', host: 'example.com', probeType: 'ping', ipVersion: 'auto', probeConfig: {}, interval: 300 }],
      skipped: 0,
    })
  })

  it('leaves out what could not be a target here, and counts it', async () => {
    const decoded = await decodeShare(await codeFor([
      { h: 'example.com' },
      { h: 'not a host; rm -rf /' },
      { h: 'db.internal', p: 'tcp' }, // no port
      { h: 'example.net', p: 'carrier-pigeon' },
      { h: 'example.org', i: 1 },
      'example.com',
      null,
    ]))
    expect(decoded).toMatchObject({ ok: true, skipped: 6 })
    expect(decoded.ok && decoded.targets.map(target => target.host)).toEqual(['example.com'])
  })

  it('keeps only the settings the probe uses, whatever else a link carries', async () => {
    const decoded = await decodeShare(await codeFor([
      { h: 'example.com', p: 'tcp', c: { port: 22, path: '/etc/passwd', keyword: 'x' }, id: 'abc', status: 'paused' },
    ]))
    expect(decoded.ok && decoded.targets).toEqual([
      { name: 'example.com', host: 'example.com', probeType: 'tcp', ipVersion: 'auto', probeConfig: { port: 22 }, interval: 300 },
    ])
  })

  it('refuses more targets than a link may hold', async () => {
    const tooMany = Array.from({ length: MAX_SHARED_TARGETS + 1 }, (_, index) => ({ h: `host-${index}.example.com` }))
    const decoded = await decodeShare(await codeFor(tooMany))
    expect(decoded).toEqual({ ok: false, error: `A share link holds at most ${MAX_SHARED_TARGETS} targets.` })
  })

  it('gives up on a link that unpacks to far more than a link holds', async () => {
    // Fifty megabytes of nothing, which packs down to a few kilobytes.
    const bomb = await codeFor('0'.repeat(50_000_000))
    expect(bomb.length).toBeLessThan(200_000)
    expect((await decodeShare(bomb)).ok).toBe(false)
  })
})
