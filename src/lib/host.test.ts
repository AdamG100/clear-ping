import { describe, expect, it } from 'vitest'
import {
  addressFamilyFor,
  classifyHost,
  isDualStack,
  isIpVersion,
  isIpv6,
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
