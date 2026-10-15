import { describe, expect, it } from 'vitest'
import {
  firstDeadHop,
  hopLoss,
  newestPerFamily,
  pathLoss,
  parseTraceroute,
  traceReached,
  tracerouteCommand,
} from './traceroute-parse'
import * as fixture from './__fixtures__/traceroute-output'

describe('parseTraceroute', () => {
  it('reads every hop of a Windows trace, counting "<1 ms" as a reply', () => {
    const hops = parseTraceroute(fixture.WINDOWS_COMPLETE)

    expect(hops).toHaveLength(6)
    expect(hops[0]).toEqual({ hop: 1, address: '172.22.2.1', rtts: [1, 1, 1], sent: 3 })
    expect(hops[4]).toEqual({ hop: 5, address: '154.0.2.115', rtts: [3, 2, 5], sent: 3 })
    expect(traceReached(hops, '1.1.1.1')).toBe(true)
  })

  it('does not mistake the "maximum of 24 hops" header for a hop', () => {
    expect(parseTraceroute(fixture.WINDOWS_COMPLETE)[0].hop).toBe(1)
  })

  it('reads IPv6 addresses, including a link-local first hop', () => {
    const hops = parseTraceroute(fixture.WINDOWS_IPV6)

    expect(hops.map(h => h.address)).toEqual([
      'fe80::ba69:f4ff:feae:febd',
      '2c0f:f9a8:3000::1:9657',
      '2c0f:f9a8::1:27:11:4',
      '2606:4700:4700::1111',
    ])
    expect(traceReached(hops, '2606:4700:4700::1111')).toBe(true)
  })

  it('counts a partly answered hop as partial loss', () => {
    const hop = parseTraceroute(fixture.WINDOWS_DEAD_END)[2]

    expect(hop).toEqual({ hop: 3, address: '154.0.0.89', rtts: [2, 1], sent: 3 })
    expect(hopLoss(hop)).toBeCloseTo(33.33, 1)
  })

  it('keeps one silent hop at a dead end and drops the rest of the run', () => {
    const hops = parseTraceroute(fixture.WINDOWS_DEAD_END)

    expect(hops.map(h => h.hop)).toEqual([1, 2, 3, 4])
    expect(hops[3]).toEqual({ hop: 4, address: null, rtts: [], sent: 3 })
    expect(traceReached(hops, '192.0.2.1')).toBe(false)
  })

  it('keeps a silent hop in the middle of a path that carries on', () => {
    const hops = parseTraceroute(fixture.WINDOWS_SILENT_MIDDLE)

    expect(hops.map(h => h.rtts.length)).toEqual([3, 0, 3])
    expect(traceReached(hops, '1.1.1.1')).toBe(true)
  })

  it('reads Linux output, where the address comes first and may change mid-hop', () => {
    const hops = parseTraceroute(fixture.LINUX_COMPLETE)

    expect(hops).toEqual([
      { hop: 1, address: '192.168.1.1', rtts: [0.345, 0.301, 0.289], sent: 3 },
      { hop: 2, address: null, rtts: [], sent: 3 },
      { hop: 3, address: '10.0.0.1', rtts: [2.113, 2.301, 2.207], sent: 3 },
      { hop: 4, address: '1.1.1.1', rtts: [3.512, 3.401], sent: 3 },
    ])
  })

  it('reads timings flagged as administratively prohibited', () => {
    const hops = parseTraceroute(fixture.LINUX_ADMIN_PROHIBITED)

    expect(hops[1]).toEqual({ hop: 2, address: '198.51.100.1', rtts: [4.12, 4.09, 4.011], sent: 3 })
    expect(traceReached(hops, '203.0.113.9')).toBe(false)
  })

  it('reads macOS traceroute6 output', () => {
    const hops = parseTraceroute(fixture.MACOS_IPV6)

    expect(hops.map(h => h.address)).toEqual(['2001:db8::1', '2606:4700:4700::1111'])
  })

  it('returns nothing for an error message or empty output', () => {
    expect(parseTraceroute(fixture.WINDOWS_UNRESOLVED)).toEqual([])
    expect(parseTraceroute('')).toEqual([])
    expect(parseTraceroute(undefined as unknown as string)).toEqual([])
  })
})

describe('firstDeadHop', () => {
  it('points at the first hop nothing came back from', () => {
    const hops = parseTraceroute(fixture.WINDOWS_DEAD_END)
    expect(firstDeadHop(hops, false)).toBe(4)
  })

  it('does not blame a silent router on a path that arrived', () => {
    // The classic misreading: hop 2 never answers, but hop 3 does, so hop 2 is
    // forwarding traffic and merely declining to reply to the probes.
    const hops = parseTraceroute(fixture.WINDOWS_SILENT_MIDDLE)
    expect(firstDeadHop(hops, true)).toBeNull()
  })

  it('has nothing to point at when the last hop answered but was not the target', () => {
    const hops = parseTraceroute(fixture.LINUX_ADMIN_PROHIBITED)
    expect(firstDeadHop(hops, false)).toBeNull()
  })
})

describe('newestPerFamily', () => {
  const trace = (id: string, address: string) => ({ id, address })
  const ids = (traces: { id: string }[]) => traces.map(each => each.id)

  it('keeps only the newest when every trace is over the one family', () => {
    expect(ids(newestPerFamily([trace('c', '192.0.2.1'), trace('b', '192.0.2.1'), trace('a', '192.0.2.9')]))).toEqual(['c'])
  })

  it('keeps the newest to each family of a target traced over both', () => {
    const listed = [
      trace('v6-new', '2001:db8::1'),
      trace('v4-new', '192.0.2.1'),
      trace('v6-old', '2001:db8::1'),
      trace('v4-old', '192.0.2.1'),
    ]
    expect(ids(newestPerFamily(listed))).toEqual(['v6-new', 'v4-new'])
  })

  it('counts traces that never resolved a name as a kind of their own', () => {
    const listed = [trace('failed-new', 'gone.example.com'), trace('v4', '192.0.2.1'), trace('failed-old', 'gone.example.com')]
    expect(ids(newestPerFamily(listed))).toEqual(['failed-new', 'v4'])
  })

  it('keeps nothing of nothing', () => {
    expect(newestPerFamily([])).toEqual([])
  })
})

describe('tracerouteCommand', () => {
  it('uses tracert without name lookups on Windows, pinned to the family', () => {
    const { command, args } = tracerouteCommand('2001:db8::1', 6, 'win32')

    expect(command).toBe('tracert')
    expect(args).toContain('-d')
    expect(args).toContain('-6')
    expect(args.at(-1)).toBe('2001:db8::1')
  })

  it('uses numeric traceroute on Linux, pinned to the family', () => {
    const { command, args } = tracerouteCommand('192.0.2.1', 4, 'linux')

    expect(command).toBe('traceroute')
    expect(args).toContain('-n')
    expect(args).toContain('-4')
    expect(args.at(-1)).toBe('192.0.2.1')
  })

  it('probes with ICMP echo, as ping does, so a host that answers ping is reached', () => {
    // UDP to a closed port goes unanswered by most servers: the trace would
    // stop one hop short of a host that is up.
    expect(tracerouteCommand('192.0.2.1', 4, 'linux').args).toContain('-I')
    expect(tracerouteCommand('2001:db8::1', 6, 'darwin').args).toContain('-I')
    expect(tracerouteCommand('192.0.2.1', 4, 'linux', 'udp').args).not.toContain('-I')
  })

  it('sends one hop\'s probes at a time on Linux, not a burst that rate limits drop', () => {
    const { args } = tracerouteCommand('192.0.2.1', 4, 'linux')
    expect(args[args.indexOf('-N') + 1]).toBe('3')
  })

  it('switches binary rather than flag for IPv6 on macOS', () => {
    expect(tracerouteCommand('2001:db8::1', 6, 'darwin').command).toBe('traceroute6')
    expect(tracerouteCommand('192.0.2.1', 4, 'darwin').command).toBe('traceroute')
    expect(tracerouteCommand('2001:db8::1', 6, 'darwin').args).not.toContain('-6')
  })
})

describe('pathLoss', () => {
  const hop = (n: number, answered: number, sent = 3) => ({
    hop: n,
    address: `10.0.0.${n}`,
    rtts: Array.from({ length: answered }, () => 5),
    sent,
  })

  it('does not count a dropped reply at a hop the later hops answered fully past', () => {
    // The router answering one probe in three, the path beyond it clean.
    expect(pathLoss([hop(1, 2), hop(2, 3), hop(3, 3)])).toEqual([0, 0, 0])
  })

  it('counts loss that carries on to the hops after it', () => {
    expect(pathLoss([hop(1, 3), hop(2, 2), hop(3, 2)])).toEqual([0, 33.33333333333333, 33.33333333333333])
  })

  it('counts a hop only at the loss the hops beyond it still show', () => {
    // 66% at hop 2, but only 33% by the end: 33% is what was lost on the way.
    expect(pathLoss([hop(1, 3), hop(2, 1), hop(3, 2)]).map(Math.round)).toEqual([0, 33, 33])
  })

  it('passes over hops that never answer', () => {
    const silent = { hop: 2, address: null, rtts: [], sent: 3 }
    expect(pathLoss([hop(1, 2), silent, hop(3, 3)])).toEqual([0, 100, 0])
  })
})
