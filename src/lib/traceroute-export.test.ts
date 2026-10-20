import { describe, expect, it } from 'vitest'
import type { Traceroute } from '@/types/probe'
import { traceAsHtml, traceAsText, traceFileName, traceSummary } from './traceroute-export'

const at = new Date('2026-10-20T09:05:07.000Z')

const reached: Traceroute = {
  id: 't1',
  targetId: 'web',
  timestamp: at,
  trigger: 'alert',
  address: '93.184.216.34',
  reached: true,
  hops: [
    { hop: 1, address: '192.168.1.1', hostname: 'router.lan', rtts: [0.6, 0.8, 1.1], sent: 3 },
    // Silent, while the hops after it answer: forwarding, not failing.
    { hop: 2, address: null, rtts: [], sent: 3 },
    { hop: 3, address: '203.0.113.9', hostname: null, rtts: [12.4, 13.1, 12.9], sent: 3 },
    { hop: 4, address: '93.184.216.34', hostname: 'example.com', rtts: [14, 15, 16], sent: 3 },
  ],
}

const broken: Traceroute = {
  ...reached,
  id: 't2',
  trigger: 'manual',
  reached: false,
  hops: [
    { hop: 1, address: '192.168.1.1', rtts: [0.6, 0.8, 1.1], sent: 3 },
    { hop: 2, address: '<script>', hostname: '"evil"&<b>', rtts: [5], sent: 3 },
    { hop: 3, address: null, rtts: [], sent: 3 },
    { hop: 4, address: null, rtts: [], sent: 3 },
  ],
}

const subject = { name: 'Web server', host: 'example.com', zone: 'UTC' }

describe('traceAsText', () => {
  it('says what was traced, when, and how it went, then every hop in columns', () => {
    const text = traceAsText(reached, subject)
    const lines = text.split('\n')

    expect(lines[0]).toBe('Route to Web server (example.com → 93.184.216.34) over IPv4')
    expect(lines[1]).toBe('Taken 2026-10-20 09:05:07 UTC, automatically when an alert fired')
    expect(lines[2]).toBe('Reached in 4 hops, 15 ms end to end')
    expect(lines[4]).toMatch(/^Hop\s+Router\s+Loss\s+Avg ms\s+Min\s+Max$/)
    expect(text).toContain('router.lan (192.168.1.1)')
    // The silent hop is a star with no figures, not a loss.
    expect(lines.find(line => line.trimStart().startsWith('2 '))).toMatch(/^\s*2\s+\*\s+-\s+-\s+-\s+-$/)

    // Every row is the same width up to its last column.
    const rows = lines.slice(4, 9)
    const lossEnd = rows.map(row => row.indexOf('%') === -1 ? null : row.indexOf('%'))
    expect(new Set(lossEnd.filter(end => end !== null)).size).toBe(1)
  })

  it('says where replies stopped', () => {
    const text = traceAsText(broken, subject)
    expect(text).toContain('No replies beyond hop 2')
    expect(text).toContain('Nothing answered from hop 3 onwards.')
    expect(text).not.toContain('alert fired')
  })

  it('leaves out a name that is only the address again', () => {
    expect(traceAsText({ ...reached, hops: [] }, { name: '93.184.216.34', host: '93.184.216.34', zone: 'UTC' }).split('\n')[0])
      .toBe('Route to 93.184.216.34 over IPv4')
  })
})

describe('traceAsHtml', () => {
  it('is a whole page that needs nothing from anywhere else', () => {
    const html = traceAsHtml(reached, subject, at)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Route to Web server (example.com → 93.184.216.34) over IPv4</title>')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).not.toMatch(/<(script|link)\b/)
    expect(html).not.toMatch(/src=|https?:\/\//)
    expect(html).toContain('Taken when an alert fired')
  })

  it('escapes whatever a router calls itself', () => {
    const html = traceAsHtml(broken, subject, at)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;evil&quot;&amp;&lt;b&gt;')
    expect(html).toContain('Nothing answered from hop 3 onwards')
  })
})

describe('traceFileName', () => {
  it('names the target, the family and the moment, in a form any file system takes', () => {
    expect(traceFileName(reached, subject)).toBe('route-web-server-ipv4-2026-10-20-0905.html')
    expect(traceFileName(reached, { name: '../../etc', host: 'x', zone: 'UTC' })).toBe('route-etc-ipv4-2026-10-20-0905.html')
    expect(traceFileName(reached, { name: '', host: '', zone: 'UTC' })).toBe('route-target-ipv4-2026-10-20-0905.html')
  })
})

describe('the shared readings', () => {
  it('summarises a trace the way the dashboard does', () => {
    expect(traceSummary(reached)).toEqual({ text: 'Reached in 4 hops', tone: 'ok' })
    expect(traceSummary({ ...reached, hops: [], errorMessage: 'traceroute is not installed' }))
      .toEqual({ text: 'traceroute is not installed', tone: 'bad' })
  })

  it('gives times on the clock of the zone ClearPing is set to, with the offset', () => {
    const johannesburg = { ...subject, zone: 'Africa/Johannesburg' }
    expect(traceAsText(reached, johannesburg).split('\n')[1]).toBe('Taken 2026-10-20 11:05:07 GMT+2, automatically when an alert fired')
    expect(traceFileName(reached, johannesburg)).toBe('route-web-server-ipv4-2026-10-20-1105.html')
  })
})
