import { describe, expect, it } from 'vitest'
import { isValidPingHost, parsePingOutput, parsePingRound, pingArgs, pingCommand, pingRefusedRound, pingRoundArgs } from './ping-parse'
import * as fixture from '../__fixtures__/ping-output'

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
    ['Windows', fixture.WINDOWS_IPV6_REPLY, 3],
    ['Linux', fixture.LINUX_IPV6_REPLY, 3.21],
  ])('reads an IPv6 reply on %s, whose line has no bytes= or TTL= fields', (_label, output, latency) => {
    expect(parsePingOutput(output)).toEqual({ received: true, latency })
  })

  it('counts a Windows IPv6 send failure as loss with a reason', () => {
    // What a host with no IPv6 route prints. It must not read as a reply.
    const parsed = parsePingOutput(fixture.WINDOWS_IPV6_NO_ROUTE)
    expect(parsed.received).toBe(false)
    expect(parsed.error).toMatch(/general failure/i)
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

describe('address family', () => {
  it.each(['win32', 'linux'] as const)('pins the family with a flag on %s', platform => {
    expect(pingArgs('2001:db8::1', 1000, platform, 6)).toContain('-6')
    expect(pingArgs('192.0.2.1', 1000, platform, 4)).toContain('-4')
  })

  it('still puts the host last when a family flag is present', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(pingArgs('2001:db8::1', 1000, platform, 6).at(-1)).toBe('2001:db8::1')
    }
  })

  it('uses ping6 on macOS, where ping is IPv4-only, and none of its IPv4 flags', () => {
    expect(pingCommand('darwin', 6)).toBe('ping6')
    expect(pingCommand('darwin', 4)).toBe('ping')
    expect(pingArgs('2001:db8::1', 1000, 'darwin', 6)).toEqual(['-c', '1', '2001:db8::1'])
  })

  it('uses plain ping everywhere else', () => {
    expect(pingCommand('win32', 6)).toBe('ping')
    expect(pingCommand('linux', 6)).toBe('ping')
  })
})

describe('isValidPingHost', () => {
  it.each(['8.8.8.8', 'example.com', 'my-host.local', '2001:db8::1', '192.168.1.1', '[2001:db8::1]', 'fe80::1%eth0'])(
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

describe('pingRoundArgs', () => {
  it('asks for the packets, their spacing and a timeout in seconds', () => {
    expect(pingRoundArgs('192.0.2.1', 20, 50, 1000, 4)).toEqual(['-n', '-c', '20', '-i', '0.05', '-W', '1', '-4', '192.0.2.1'])
  })

  it('never sets a deadline, which would send more than it was asked to on a lossy path', () => {
    expect(pingRoundArgs('192.0.2.1', 20, 50, 1000)).not.toContain('-w')
  })

  it('keeps the host last, where it cannot be read as a flag', () => {
    expect(pingRoundArgs('2001:db8::1', 5, 50, 1500, 6).at(-1)).toBe('2001:db8::1')
    expect(pingRoundArgs('2001:db8::1', 5, 50, 1500, 6)).toEqual(expect.arrayContaining(['-6', '-W', '2']))
  })
})

describe('parsePingRound', () => {
  it('reads every reply in the order they were sent', () => {
    expect(parsePingRound(fixture.LINUX_ROUND, 1000)).toEqual({ sent: 4, latencies: [10, 12, 13, 15] })
  })

  it('counts a reply that arrives twice once, at its first time', () => {
    expect(parsePingRound(fixture.LINUX_ROUND_WITH_LOSS, 1000)).toEqual({ sent: 4, latencies: [10, 12] })
  })

  it('puts replies back in the order they were sent, which jitter is worked out from', () => {
    const output = '64 bytes from 192.0.2.1: icmp_seq=2 ttl=57 time=5.0 ms\n64 bytes from 192.0.2.1: icmp_seq=1 ttl=57 time=90.0 ms'
    expect(parsePingRound(output, 1000).latencies).toEqual([90, 5])
  })

  it('counts an answer later than the timeout as lost', () => {
    const output = '64 bytes from 192.0.2.1: icmp_seq=1 ttl=57 time=1200 ms\n1 packets transmitted, 1 received, 0% packet loss, time 0ms'
    expect(parsePingRound(output, 1000)).toMatchObject({ sent: 1, latencies: [] })
  })

  it('does not take an unreachable line for a reply, and keeps it as the reason', () => {
    const round = parsePingRound(fixture.LINUX_ROUND_UNREACHABLE, 1000)
    expect(round.latencies).toEqual([])
    expect(round.error).toMatch(/unreachable/i)
  })

  it('says it does not know what went out when ping never got as far as saying', () => {
    expect(parsePingRound('', 1000, 'ping: connect: Network is unreachable')).toEqual({
      sent: null,
      latencies: [],
      error: 'ping: connect: Network is unreachable',
    })
  })
})

describe('pingRefusedRound', () => {
  it.each([
    'ping: cannot flood; minimal interval allowed for user is 200ms',
    "ping: invalid option -- 'n'",
    'ping: option value too small: 0.05',
    'Usage: ping [OPTIONS] HOST',
  ])('takes %j as this ping not doing rounds', stderr => expect(pingRefusedRound(stderr)).toBe(true))

  it.each(['', 'ping: connect: Network is unreachable', 'ping: sendmsg: Operation not permitted', 'Command failed: ping'])(
    'takes %j as nothing to do with rounds',
    stderr => expect(pingRefusedRound(stderr)).toBe(false)
  )
})
