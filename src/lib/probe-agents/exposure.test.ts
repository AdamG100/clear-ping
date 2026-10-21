import { describe, expect, it } from 'vitest'
import { exposureOfAddress, isTailnetAddress } from './exposure'
import { readProbeAgentAddress, readProbeAgentInput, readProbeAgentPort } from './input'

describe('how a probe agent is reached', () => {
  it('knows a tailnet by its addresses and its names', () => {
    expect(isTailnetAddress('100.84.12.7')).toBe(true)
    expect(isTailnetAddress('100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.127.255.254')).toBe(true)
    expect(isTailnetAddress('fd7a:115c:a1e0::1234')).toBe(true)
    expect(isTailnetAddress('vps.tail1234.ts.net')).toBe(true)

    expect(isTailnetAddress('100.128.0.1')).toBe(false)
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('fd00::1')).toBe(false)
    expect(isTailnetAddress('example.com')).toBe(false)
  })

  it('calls a tailnet, a private network and the internet what they are', () => {
    expect(exposureOfAddress('100.84.12.7')).toBe('tailnet')
    expect(exposureOfAddress('[fd7a:115c:a1e0::1]')).toBe('tailnet')
    expect(exposureOfAddress('192.168.1.20')).toBe('private')
    expect(exposureOfAddress('10.0.0.5')).toBe('private')
    expect(exposureOfAddress('fd12:3456::1')).toBe('private')
    expect(exposureOfAddress('nas.lan')).toBe('private')
    expect(exposureOfAddress('vps')).toBe('private')

    expect(exposureOfAddress('203.0.113.10')).toBe('public')
    expect(exposureOfAddress('2001:db8::10')).toBe('public')
    expect(exposureOfAddress('vps.example.com')).toBe('public')
  })
})

describe('what a probe agent is added with', () => {
  it('takes an address as written, without brackets or a port', () => {
    expect(readProbeAgentAddress(' 100.84.12.7 ')).toEqual({ ok: true, value: '100.84.12.7' })
    expect(readProbeAgentAddress('[2001:db8::1]:7380')).toEqual({ ok: true, value: '2001:db8::1' })
    expect(readProbeAgentAddress('VPS.Example.com').ok).toBe(true)
    expect(readProbeAgentAddress('not an address').ok).toBe(false)
    expect(readProbeAgentAddress('').ok).toBe(false)
  })

  it('takes the usual port when none is given, and refuses one that is not a port', () => {
    expect(readProbeAgentPort(undefined)).toEqual({ ok: true, value: 7380 })
    expect(readProbeAgentPort('8443')).toEqual({ ok: true, value: 8443 })
    expect(readProbeAgentPort(0).ok).toBe(false)
    expect(readProbeAgentPort(70000).ok).toBe(false)
    expect(readProbeAgentPort('80.5').ok).toBe(false)
  })

  it('needs a name', () => {
    expect(readProbeAgentInput({ address: '100.84.12.7' }).ok).toBe(false)
    expect(readProbeAgentInput({ name: 'x'.repeat(61), address: '100.84.12.7' }).ok).toBe(false)
    expect(readProbeAgentInput({ name: 'Germany VPS', address: '100.84.12.7' })).toEqual({
      ok: true,
      value: { name: 'Germany VPS', address: '100.84.12.7', port: 7380 },
    })
  })
})
