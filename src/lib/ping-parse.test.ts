import { describe, expect, it } from 'vitest'
import { isValidPingHost, parsePingOutput, pingArgs } from './ping-parse'
import * as fixture from './__fixtures__/ping-output'

describe('parsePingOutput', () => {
  it('reads integer milliseconds from Windows output', () => {
    expect(parsePingOutput(fixture.WINDOWS_REPLY)).toEqual({ received: true, latency: 12 })
  })

  it('reads decimal milliseconds from Linux output', () => {
    expect(parsePingOutput(fixture.LINUX_REPLY)).toEqual({ received: true, latency: 12.3 })
  })

  it('keeps sub-millisecond precision on macOS', () => {
    expect(parsePingOutput(fixture.MACOS_REPLY)).toEqual({ received: true, latency: 12.345 })
  })

  it('treats Windows "time<1ms" as a reply, not a loss', () => {
    const parsed = parsePingOutput(fixture.WINDOWS_SUB_MILLISECOND)
    expect(parsed.received).toBe(true)
    expect(parsed.latency).toBe(1)
  })

  it.each([
    ['Windows timeout', fixture.WINDOWS_TIMEOUT],
    ['Linux timeout', fixture.LINUX_TIMEOUT],
    ['macOS timeout', fixture.MACOS_TIMEOUT],
  ])('counts %s as a lost packet', (_label, output) => {
    const parsed = parsePingOutput(output)
    expect(parsed.received).toBe(false)
    expect(parsed.latency).toBeNull()
  })

  it('counts an unreachable reply as loss even though the line says "Reply from"', () => {
    // Windows answers from an intermediate router here and exits zero. Treating
    // the presence of "Reply from" as success would score this as a 0ms hop.
    const parsed = parsePingOutput(fixture.WINDOWS_UNREACHABLE)
    expect(parsed.received).toBe(false)
    expect(parsed.error).toMatch(/unreachable/i)
  })

  it.each([
    ['Windows', fixture.WINDOWS_DNS_FAILURE],
    ['Linux', fixture.LINUX_UNKNOWN_HOST],
  ])('reports %s name-resolution failure as loss with a reason', (_label, output) => {
    const parsed = parsePingOutput(output)
    expect(parsed.received).toBe(false)
    expect(parsed.error).toBeTruthy()
  })

  it('falls back to the supplied error when output explains nothing', () => {
    expect(parsePingOutput('', 'spawn ENOENT').error).toBe('spawn ENOENT')
  })

  it('handles empty and undefined output without throwing', () => {
    expect(parsePingOutput('').received).toBe(false)
    expect(parsePingOutput(undefined as unknown as string).received).toBe(false)
  })
})

describe('pingArgs', () => {
  it('passes milliseconds to Windows -w', () => {
    expect(pingArgs('8.8.8.8', 1000, 'win32')).toEqual(['-n', '1', '-w', '1000', '8.8.8.8'])
  })

  it('converts to seconds for Linux -W', () => {
    // Passing 1000 here would mean a ~17 minute timeout and every packet would
    // appear to arrive, reporting a flawless path.
    const args = pingArgs('8.8.8.8', 1000, 'linux')
    expect(args[args.indexOf('-W') + 1]).toBe('1')
    expect(args).toContain('8.8.8.8')
  })

  it('never rounds a sub-second timeout down to zero', () => {
    expect(pingArgs('8.8.8.8', 200, 'linux')[3]).toBe('1')
  })

  it('puts the host last so it is never read as a flag', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(pingArgs('example.com', 1000, platform).at(-1)).toBe('example.com')
    }
  })
})

describe('isValidPingHost', () => {
  it.each(['8.8.8.8', 'example.com', 'my-host.local', '2001:db8::1', '192.168.1.1'])(
    'accepts %s',
    host => expect(isValidPingHost(host)).toBe(true)
  )

  it.each([
    '8.8.8.8 & calc.exe',
    '8.8.8.8; rm -rf /',
    '$(whoami)',
    '`id`',
    '-n',
    '--help',
    '',
    'a b',
  ])('rejects %j', host => expect(isValidPingHost(host)).toBe(false))
})
