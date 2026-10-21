import { describe, expect, it } from 'vitest'
import type { Target } from '@/types/probe'
import { definitionOf, measurementKey, validateTargetDefinition } from './definition'

describe('validateTargetDefinition', () => {
  it('accepts a target and tidies it', () => {
    expect(
      validateTargetDefinition({ name: '  Router ', host: ' [2001:db8::1] ', probeType: 'ping', interval: '60', group: ' Home / Network ' })
    ).toEqual({
      ok: true,
      target: { name: 'Router', host: '2001:db8::1', probeType: 'ping', ipVersion: 'auto', probeConfig: {}, interval: 60, group: 'Home/Network' },
    })
  })

  it('has no group rather than an empty one', () => {
    const checked = validateTargetDefinition({ name: 'a', host: 'example.com', probeType: 'ping', interval: 300, group: ' / ' })
    expect(checked.ok && 'group' in checked.target).toBe(false)
  })

  it('reduces the settings to the ones the probe uses', () => {
    const checked = validateTargetDefinition({
      name: 'a',
      host: 'example.com',
      probeType: 'http',
      interval: 300,
      probeConfig: { scheme: 'https', port: 443, path: '/x', queryName: 'example.org' },
    })
    expect(checked.ok && checked.target.probeConfig).toEqual({ scheme: 'https', path: '/x' })
  })

  it.each([
    ['nothing at all', undefined, 'Missing required fields'],
    ['no name', { host: 'example.com', probeType: 'ping', interval: 300 }, 'Missing required fields'],
    ['a name of spaces', { name: '   ', host: 'example.com', probeType: 'ping', interval: 300 }, 'Missing required fields'],
    ['an unknown probe', { name: 'a', host: 'example.com', probeType: 'smtp', interval: 300 }, 'Invalid probe type'],
    ['a host that is not one', { name: 'a', host: '-rf; reboot', probeType: 'ping', interval: 300 }, 'Invalid host'],
    ['a host that is not text', { name: 'a', host: 8, probeType: 'ping', interval: 300 }, 'Invalid host'],
    ['an unknown IP version', { name: 'a', host: 'example.com', probeType: 'ping', interval: 300, ipVersion: 'ipv5' }, 'Invalid IP version'],
    ['an interval too short', { name: 'a', host: 'example.com', probeType: 'ping', interval: 5 }, 'Interval must be'],
    ['an interval too long', { name: 'a', host: 'example.com', probeType: 'ping', interval: 86401 }, 'Interval must be'],
    ['a TCP target with no port', { name: 'a', host: 'example.com', probeType: 'tcp', interval: 300 }, 'needs a port'],
  ])('refuses %s', (_, raw, message) => {
    const checked = validateTargetDefinition(raw)
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.error).toContain(message)
  })
})

const TARGET: Target = {
  id: 'abc',
  name: 'Sign-in',
  host: 'example.com',
  probeType: 'http',
  interval: 120,
  status: 'paused',
  group: 'Work',
  sortOrder: 4,
  ipVersion: 'ipv4',
  resolvedAddress: '192.0.2.7',
  probeConfig: { scheme: 'https', path: '/login' },
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe('definitionOf', () => {
  it('keeps what the target is and leaves behind what belongs to this installation', () => {
    expect(definitionOf(TARGET)).toEqual({
      name: 'Sign-in',
      host: 'example.com',
      probeType: 'http',
      ipVersion: 'ipv4',
      probeConfig: { scheme: 'https', path: '/login' },
      interval: 120,
      group: 'Work',
    })
  })

  it('gives back something that can be added as it is', () => {
    expect(validateTargetDefinition(definitionOf(TARGET))).toEqual({ ok: true, target: definitionOf(TARGET) })
  })
})

describe('measurementKey', () => {
  it('is the same for two targets that measure the same thing', () => {
    const elsewhere: Target = { ...TARGET, name: 'Another name', group: 'Elsewhere', interval: 30 }
    expect(measurementKey(elsewhere)).toBe(measurementKey(TARGET))
    expect(measurementKey({ ...TARGET, host: 'EXAMPLE.com' })).toBe(measurementKey(TARGET))
    expect(measurementKey({ ...TARGET, probeConfig: { path: '/login', scheme: 'https' } })).toBe(measurementKey(TARGET))
  })

  it('differs when the address, the probe, its settings or the family do', () => {
    const others: Partial<Target>[] = [
      { host: 'example.org' },
      { probeType: 'ping', probeConfig: {} },
      { probeConfig: { scheme: 'https', path: '/' } },
      { ipVersion: 'ipv6' },
    ]
    for (const change of others) {
      expect(measurementKey({ ...TARGET, ...change }), JSON.stringify(change)).not.toBe(measurementKey(TARGET))
    }
  })

  it('ignores the IP version on an address, where it means nothing', () => {
    const literal = { host: '192.0.2.1', probeType: 'ping' as const, probeConfig: {} }
    expect(measurementKey({ ...literal, ipVersion: 'both' })).toBe(measurementKey({ ...literal, ipVersion: 'auto' }))
    expect(measurementKey({ ...literal, ipVersion: undefined })).toBe(measurementKey({ ...literal, ipVersion: 'auto' }))
  })
})
