import { describe, expect, it } from 'vitest'
import {
  addressFamilyFor,
  classifyHost,
  isDualStack,
  isIpVersion,
  isIpv6,
  isLocalHost,
  isPrivateAddress,
  isValidHost,
  isWellKnownResolver,
  normalizeHost,
  probeRuns,
  targetTypeFor,
} from './host'

describe('isIpv6', () => {
  it.each([
    '::',
    '::1',
    '2001:db8::1',
    '2606:4700:4700::1111',
    '2001:0db8:0000:0000:0000:ff00:0042:8329',
    'fe80::1',
    '1:2:3:4:5:6:7::',
    '::ffff:192.0.2.1',
    '64:ff9b::192.0.2.33',
    'fe80::1%eth0',
    'fe80::1%12',
  ])('accepts %s', address => expect(isIpv6(address)).toBe(true))

  it.each([
    ['too many groups', '1:2:3:4:5:6:7:8:9'],
    ['too few groups without compression', '1:2:3:4:5:6:7'],
    ['two compressions', '2001::db8::1'],
    ['a group that is too long', '2001:db8::12345'],
    ['a non-hex group', '2001:db8::g'],
    ['a stray colon', ':::'],
    ['compression that replaces nothing', '1:2:3:4:5:6:7:8::'],
    ['a bad embedded IPv4 tail', '::ffff:999.0.2.1'],
    ['an IPv4 address', '192.0.2.1'],
    ['an empty zone', 'fe80::1%'],
    ['a zone carrying a shell metacharacter', 'fe80::1%eth0;id'],
    ['a hostname', 'example.com'],
  ])('rejects %s', (_label, address) => expect(isIpv6(address)).toBe(false))
})

describe('classifyHost', () => {
  it.each([
    ['8.8.8.8', 'ipv4'],
    ['2606:4700:4700::1111', 'ipv6'],
    ['[2606:4700:4700::1111]', 'ipv6'],
    ['  2001:db8::1  ', 'ipv6'],
    ['example.com', 'hostname'],
    ['my-host.local', 'hostname'],
    ['localhost', 'hostname'],
    ['999.1.1.1', 'invalid'],
    ['10.0.1', 'invalid'],
    ['2001:db8:::1', 'invalid'],
    ['[example.com]', 'invalid'],
    ['-n', 'invalid'],
    ['a b', 'invalid'],
    ['', 'invalid'],
  ] as const)('reads %j as %s', (host, kind) => expect(classifyHost(host)).toBe(kind))

  it('never lets an injection attempt through as a host', () => {
    for (const host of ['8.8.8.8 & calc.exe', '8.8.8.8; rm -rf /', '$(whoami)', '`id`', '--help']) {
      expect(isValidHost(host)).toBe(false)
    }
  })
})

describe('normalizeHost', () => {
  it('unwraps a bracketed IPv6 literal', () => {
    expect(normalizeHost(' [2001:db8::1] ')).toBe('2001:db8::1')
  })

  it('leaves brackets around anything that is not IPv6 so it stays invalid', () => {
    expect(normalizeHost('[example.com]')).toBe('[example.com]')
  })
})

describe('targetTypeFor', () => {
  it('separates addresses from names for ping targets', () => {
    expect(targetTypeFor('8.8.8.8', 'ping')).toBe('ip')
    expect(targetTypeFor('2606:4700:4700::1111', 'ping')).toBe('ip')
    expect(targetTypeFor('example.com', 'ping')).toBe('domain')
  })

  it('names every other target for its probe, whatever the address', () => {
    expect(targetTypeFor('8.8.8.8', 'dns')).toBe('dns')
    expect(targetTypeFor('example.com', 'dns')).toBe('dns')
    expect(targetTypeFor('example.com', 'tcp')).toBe('tcp')
    expect(targetTypeFor('192.0.2.1', 'http')).toBe('http')
  })
})

describe('addressFamilyFor', () => {
  it('lets a literal decide, whatever the setting says', () => {
    expect(addressFamilyFor('8.8.8.8', 'ipv6')).toBe(4)
    expect(addressFamilyFor('2001:db8::1', 'ipv4')).toBe(6)
  })

  it('follows the setting for a name, and leaves auto to the resolver', () => {
    expect(addressFamilyFor('example.com', 'ipv4')).toBe(4)
    expect(addressFamilyFor('example.com', 'ipv6')).toBe(6)
    expect(addressFamilyFor('example.com', 'auto')).toBeNull()
    expect(addressFamilyFor('example.com')).toBeNull()
  })
})

describe('isDualStack', () => {
  it('is true only for a name set to both families', () => {
    expect(isDualStack('example.com', 'both')).toBe(true)
    expect(isDualStack('example.com', 'ipv6')).toBe(false)
    expect(isDualStack('example.com')).toBe(false)
  })

  it('is never true for an address, which belongs to one family', () => {
    expect(isDualStack('8.8.8.8', 'both')).toBe(false)
    expect(isDualStack('2001:db8::1', 'both')).toBe(false)
  })
})

describe('probeRuns', () => {
  it('is one probe for an ordinary target, pinned as the setting says', () => {
    expect(probeRuns('example.com')).toEqual([{ ipVersion: 'auto', family: null }])
    expect(probeRuns('example.com', 'ipv6')).toEqual([{ ipVersion: 'ipv6', family: 6 }])
    expect(probeRuns('8.8.8.8')).toEqual([{ ipVersion: 'auto', family: 4 }])
  })

  it('is one probe per family for a name set to both', () => {
    expect(probeRuns('example.com', 'both')).toEqual([
      { ipVersion: 'ipv4', family: 4 },
      { ipVersion: 'ipv6', family: 6 },
    ])
  })

  it('does not probe an address twice just because it was set to both', () => {
    expect(probeRuns('2001:db8::1', 'both')).toEqual([{ ipVersion: 'auto', family: 6 }])
  })
})

describe('isIpVersion', () => {
  it('accepts every setting, including both', () => {
    for (const value of ['auto', 'ipv4', 'ipv6', 'both']) expect(isIpVersion(value)).toBe(true)
    expect(isIpVersion('ipv5')).toBe(false)
    expect(isIpVersion(undefined)).toBe(false)
  })
})

describe('isWellKnownResolver', () => {
  it('recognises public resolvers in both families, however they are written', () => {
    expect(isWellKnownResolver('1.1.1.1')).toBe(true)
    expect(isWellKnownResolver('[2606:4700:4700::1111]')).toBe(true)
    expect(isWellKnownResolver('2620:FE::FE')).toBe(true)
  })

  it('does not claim an arbitrary address', () => {
    expect(isWellKnownResolver('192.168.1.1')).toBe(false)
  })
})

describe('isPrivateAddress', () => {
  it('knows an address inside a private network from one outside it', () => {
    for (const inside of ['192.168.1.1', '10.0.0.1', '172.16.5.4', '172.31.255.254', '127.0.0.1', '169.254.1.1', 'fe80::1', 'fd12:3456::1', '::1']) {
      expect(isPrivateAddress(inside), inside).toBe(true)
    }
    // The ISP's own shared range is the ISP's side of the line.
    for (const outside of ['1.1.1.1', '172.32.0.1', '100.64.0.1', '192.169.1.1', '2606:4700:4700::1111', 'example.com', '']) {
      expect(isPrivateAddress(outside), outside).toBe(false)
    }
  })
})

describe('isLocalHost', () => {
  it('takes this machine and a private address as local, with or without a port', () => {
    for (const local of ['localhost', 'localhost:3000', '127.0.0.1:3000', '192.168.1.20:3000', '10.1.2.3', '[::1]:3000', '[fd12:3456::1]', 'fe80::1']) {
      expect(isLocalHost(local), local).toBe(true)
    }
  })

  it('takes a name that only means anything on its own network as local', () => {
    for (const local of ['clearping', 'clearping:3000', 'nas.lan:3000', 'pi.local', 'monitor.home.arpa', 'box.internal', 'app.localhost', 'CLEARPING.LAN']) {
      expect(isLocalHost(local), local).toBe(true)
    }
  })

  it('takes the addresses an overlay network hands out as local', () => {
    expect(isLocalHost('100.101.102.103:3000')).toBe(true)
    expect(isLocalHost('100.63.0.1')).toBe(false)
    expect(isLocalHost('100.128.0.1')).toBe(false)
  })

  it('takes anything out across the internet as not', () => {
    for (const remote of ['clearping.example.com', 'clearping.example.com:3000', '203.0.113.5:3000', '[2606:4700:4700::1111]:443', 'evil.lan.example.com', 'not a host', '']) {
      expect(isLocalHost(remote), remote).toBe(false)
    }
  })
})
