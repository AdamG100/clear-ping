import { describe, expect, it } from 'vitest'
import { addressIn, firstHost, isAddress, isPrefix, isPublicAddress, prefixLength, prefixWithin, tooWide } from './prefix'

describe('prefixes', () => {
  it('reads IPv4 and IPv6 prefixes, and refuses what is not one', () => {
    expect(isPrefix('198.18.96.0/20')).toBe(true)
    expect(isPrefix('2a10:50c0::/32')).toBe(true)
    expect(isPrefix('198.18.96.0')).toBe(false)
    expect(isPrefix('198.18.96.0/33')).toBe(false)
    expect(isPrefix('300.1.1.0/24')).toBe(false)
    expect(isAddress('2001:db8::1')).toBe(true)
    expect(isAddress('::ffff:192.0.2.1')).toBe(true)
    expect(isAddress('example.com')).toBe(false)
  })

  it('knows a more-specific from a prefix beside it', () => {
    expect(prefixWithin('198.18.101.0/24', '198.18.96.0/20')).toBe(true)
    expect(prefixWithin('198.18.96.0/20', '198.18.96.0/20')).toBe(true)
    expect(prefixWithin('198.18.112.0/24', '198.18.96.0/20')).toBe(false)
    expect(prefixWithin('198.18.0.0/16', '198.18.96.0/20')).toBe(false)
    expect(prefixWithin('2a10:50c0:1::/48', '2a10:50c0::/32')).toBe(true)
    expect(prefixWithin('2a10:50c0::/32', '198.18.96.0/20')).toBe(false)
  })

  it('finds an address inside a prefix', () => {
    expect(addressIn('198.18.101.2', '198.18.96.0/20')).toBe(true)
    expect(addressIn('198.18.95.255', '198.18.96.0/20')).toBe(false)
    expect(addressIn('2a10:50c0::ad1:ff', '2a10:50c0::/32')).toBe(true)
    expect(addressIn('nonsense', '198.18.96.0/20')).toBe(false)
    expect(prefixLength('198.18.96.0/20')).toBe(20)
  })
})

describe('public addresses', () => {
  it('tells an address on the internet from a private, shared or local one', () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    expect(isPublicAddress('172.16.0.1')).toBe(false)
    expect(isPublicAddress('100.64.0.1')).toBe(false)
    expect(isPublicAddress('fe80::1')).toBe(false)
    expect(isPublicAddress('not an address')).toBe(false)
  })

  it('finds somewhere in a prefix to trace to', () => {
    expect(firstHost('198.18.96.0/20')).toBe('198.18.96.1')
    expect(firstHost('203.0.113.5/32')).toBe('203.0.113.5')
    expect(firstHost('2001:db8::/32')).toBe('2001:db8:0:0:0:0:0:1')
  })
})

describe('prefixes too wide to watch', () => {
  it('refuses anything wider than a network announces, and takes the rest', () => {
    expect(tooWide('0.0.0.0/0')).toMatch(/wider than any network announces/)
    expect(tooWide('192.0.0.0/4')).toMatch(/a \/8 or longer/)
    expect(tooWide('2000::/3')).toMatch(/a \/16 or longer/)
    expect(tooWide('12.0.0.0/8')).toBeNull()
    expect(tooWide('203.0.113.0/24')).toBeNull()
    expect(tooWide('2001:db8::/32')).toBeNull()
    expect(tooWide('not a prefix')).toBeNull()
  })
})
