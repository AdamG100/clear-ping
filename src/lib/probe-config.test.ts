import { describe, expect, it } from 'vitest'
import {
  httpUrlFor,
  isProbeType,
  parseAddressInput,
  targetAddressLabel,
  validateProbeConfig,
} from './probe-config'

describe('parseAddressInput', () => {
  it('leaves a plain host alone and suggests nothing', () => {
    expect(parseAddressInput(' example.com ')).toEqual({ host: 'example.com', config: {} })
    expect(parseAddressInput('192.0.2.1')).toEqual({ host: '192.0.2.1', config: {} })
  })

  it('does not read the colons of a bare IPv6 address as a port', () => {
    expect(parseAddressInput('2606:4700:4700::1111')).toEqual({ host: '2606:4700:4700::1111', config: {} })
    expect(parseAddressInput('[2606:4700:4700::1111]')).toEqual({ host: '2606:4700:4700::1111', config: {} })
  })

  it('takes a URL apart into host, scheme, port and path', () => {
    expect(parseAddressInput('https://example.com/health?deep=1')).toEqual({
      host: 'example.com',
      probeType: 'http',
      config: { scheme: 'https', path: '/health?deep=1' },
    })
    expect(parseAddressInput('http://192.0.2.1:8080')).toEqual({
      host: '192.0.2.1',
      probeType: 'http',
      config: { scheme: 'http', path: '/', port: 8080 },
    })
  })

  it('unwraps an IPv6 host inside a URL', () => {
    expect(parseAddressInput('https://[2001:db8::1]:8443/x').host).toBe('2001:db8::1')
  })

  it('reads host:port as a TCP target', () => {
    expect(parseAddressInput('db.internal:5432')).toEqual({
      host: 'db.internal',
      probeType: 'tcp',
      config: { port: 5432 },
    })
    expect(parseAddressInput('[2001:db8::1]:22')).toEqual({
      host: '2001:db8::1',
      probeType: 'tcp',
      config: { port: 22 },
    })
  })

  it('does not invent a port from something that is not one', () => {
    expect(parseAddressInput('example.com:99999').probeType).toBeUndefined()
    expect(parseAddressInput('example.com:http').probeType).toBeUndefined()
  })
})

describe('validateProbeConfig', () => {
  it('requires a real port for TCP', () => {
    expect(validateProbeConfig('tcp', 'example.com', {})).toMatchObject({ ok: false })
    expect(validateProbeConfig('tcp', 'example.com', { port: 0 })).toMatchObject({ ok: false })
    expect(validateProbeConfig('tcp', 'example.com', { port: 70000 })).toMatchObject({ ok: false })
    expect(validateProbeConfig('tcp', 'example.com', { port: '443' })).toMatchObject({ ok: false })
    expect(validateProbeConfig('tcp', 'example.com', { port: 443 })).toEqual({ ok: true, config: { port: 443 } })
  })

  it('fills in HTTP defaults and drops a port that is only the default', () => {
    expect(validateProbeConfig('http', 'example.com', undefined)).toEqual({
      ok: true,
      config: { scheme: 'https', path: '/' },
    })
    expect(validateProbeConfig('http', 'example.com', { scheme: 'https', port: 443 })).toEqual({
      ok: true,
      config: { scheme: 'https', path: '/' },
    })
    expect(validateProbeConfig('http', 'example.com', { scheme: 'http', port: 8080, path: '/up' })).toEqual({
      ok: true,
      config: { scheme: 'http', port: 8080, path: '/up' },
    })
  })

  it('rejects HTTP settings that could not produce a request', () => {
    expect(validateProbeConfig('http', 'example.com', { scheme: 'ftp' })).toMatchObject({ ok: false })
    expect(validateProbeConfig('http', 'example.com', { path: 'health' })).toMatchObject({ ok: false })
    expect(validateProbeConfig('http', 'example.com', { path: '/a b' })).toMatchObject({ ok: false })
    expect(validateProbeConfig('http', 'example.com', { expectedStatus: 99 })).toMatchObject({ ok: false })
    expect(validateProbeConfig('http', 'example.com', { expectedStatus: '200' })).toMatchObject({ ok: false })
  })

  it('keeps an expected status and keyword, and ignores a blank keyword', () => {
    expect(
      validateProbeConfig('http', 'example.com', { expectedStatus: 204, keyword: '  ok  ' })
    ).toEqual({ ok: true, config: { scheme: 'https', path: '/', expectedStatus: 204, keyword: 'ok' } })

    expect(validateProbeConfig('http', 'example.com', { keyword: '   ' })).toEqual({
      ok: true,
      config: { scheme: 'https', path: '/' },
    })
  })

  it('lets a DNS server target choose what to ask', () => {
    expect(
      validateProbeConfig('dns', '1.1.1.1', { queryName: 'example.org', recordType: 'MX', expectedAnswer: 'mx.example.org' })
    ).toEqual({
      ok: true,
      config: { queryName: 'example.org', recordType: 'MX', expectedAnswer: 'mx.example.org' },
    })
    expect(validateProbeConfig('dns', '1.1.1.1', { recordType: 'SRV' })).toMatchObject({ ok: false })
    expect(validateProbeConfig('dns', '1.1.1.1', { queryName: '8.8.8.8' })).toMatchObject({ ok: false })
  })

  it('gives a DNS name target only an expected answer, since the name is the question', () => {
    expect(
      validateProbeConfig('dns', 'example.com', { queryName: 'other.example', recordType: 'TXT', expectedAnswer: '192.0.2.1' })
    ).toEqual({ ok: true, config: { expectedAnswer: '192.0.2.1' } })
  })

  it('strips settings that belong to a different probe', () => {
    // A target switched from HTTP to ping must not keep a path nobody can see.
    const leftovers = { port: 443, scheme: 'https', path: '/x', queryName: 'example.org' }

    expect(validateProbeConfig('ping', 'example.com', leftovers)).toEqual({ ok: true, config: {} })
    expect(validateProbeConfig('tcp', 'example.com', leftovers)).toEqual({ ok: true, config: { port: 443 } })
  })
})

describe('displaying a target', () => {
  it('builds the URL an HTTP target requests', () => {
    expect(httpUrlFor('example.com')).toBe('https://example.com/')
    expect(httpUrlFor('example.com', { scheme: 'http', port: 8080, path: '/up' })).toBe('http://example.com:8080/up')
    expect(httpUrlFor('2001:db8::1', { scheme: 'https', path: '/' })).toBe('https://[2001:db8::1]/')
  })

  it('labels each kind of target the way it would be typed', () => {
    expect(targetAddressLabel({ host: '192.0.2.1', probeType: 'ping' })).toBe('192.0.2.1')
    expect(targetAddressLabel({ host: 'db.internal', probeType: 'tcp', probeConfig: { port: 5432 } })).toBe('db.internal:5432')
    expect(targetAddressLabel({ host: '2001:db8::1', probeType: 'tcp', probeConfig: { port: 22 } })).toBe('[2001:db8::1]:22')
    expect(
      targetAddressLabel({ host: 'example.com', probeType: 'http', probeConfig: { scheme: 'https', path: '/health' } })
    ).toBe('https://example.com/health')
    expect(targetAddressLabel({ host: '1.1.1.1', probeType: 'dns' })).toBe('1.1.1.1')
  })
})

describe('isProbeType', () => {
  it('knows the four probes and nothing else', () => {
    expect(['ping', 'tcp', 'http', 'dns'].every(isProbeType)).toBe(true)
    expect(isProbeType('icmp')).toBe(false)
    expect(isProbeType(undefined)).toBe(false)
  })
})
