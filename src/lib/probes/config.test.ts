import { describe, expect, it } from 'vitest'
import {
  httpUrlFor,
  isProbeType,
  nameRecordType,
  parseAddressInput,
  targetAddressLabel,
  validateProbeConfig,
} from './config'

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

  it('lets a DNS name target say which resolvers to ask, and then what kind of record', () => {
    expect(
      validateProbeConfig('dns', 'example.com', {
        resolvers: [{ protocol: 'udp', server: ' 1.1.1.1' }, { protocol: 'doh', server: 'dns.google' }, { protocol: 'dot', server: 'dns.quad9.net' }],
        recordType: 'MX',
        expectedAnswer: 'mx.example.com',
        queryName: 'other.example',
      })
    ).toEqual({
      ok: true,
      config: {
        resolvers: [
          { protocol: 'udp', server: '1.1.1.1' },
          { protocol: 'doh', server: 'https://dns.google/dns-query' },
          { protocol: 'dot', server: 'dns.quad9.net' },
        ],
        recordType: 'MX',
        expectedAnswer: 'mx.example.com',
      },
    })
  })

  it('stores nothing for the system resolver alone, which is what a name target has anyway', () => {
    expect(validateProbeConfig('dns', 'example.com', { resolvers: [{ protocol: 'system' }], recordType: 'TXT' })).toEqual({
      ok: true,
      config: {},
    })
    expect(validateProbeConfig('dns', 'example.com', { resolvers: [] })).toEqual({ ok: true, config: {} })
  })

  it('keeps the system resolver in a list with others, but only to be asked for addresses', () => {
    const resolvers = [{ protocol: 'system' }, { protocol: 'udp', server: '9.9.9.9' }]

    expect(validateProbeConfig('dns', 'example.com', { resolvers, recordType: 'AAAA' })).toEqual({
      ok: true,
      config: { resolvers, recordType: 'AAAA' },
    })
    expect(validateProbeConfig('dns', 'example.com', { resolvers })).toEqual({ ok: true, config: { resolvers } })

    const refused = validateProbeConfig('dns', 'example.com', { resolvers, recordType: 'TXT' })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error).toContain('only looks up addresses')
  })

  it('asks a name’s resolvers for the address of the IP version the target is on', () => {
    // The form saves A with every list, so a saved A must not pin IPv6 to IPv4.
    expect(nameRecordType('A', 'ipv6')).toBe('AAAA')
    expect(nameRecordType('AAAA', 'ipv4')).toBe('A')
    expect(nameRecordType(undefined, 'ipv6')).toBe('AAAA')
    // Left to itself, or to both (which is run as one of each), the version
    // leaves the record as it was chosen.
    expect(nameRecordType(undefined)).toBe('A')
    expect(nameRecordType('AAAA', 'auto')).toBe('AAAA')
    expect(nameRecordType('A', 'both')).toBe('A')
    // Anything that is not an address has no version to follow.
    expect(nameRecordType('MX', 'ipv6')).toBe('MX')
    expect(nameRecordType('TXT', 'both')).toBe('TXT')
  })

  it('refuses a resolver that is wrong, saying which', () => {
    const refused = validateProbeConfig('dns', 'example.com', {
      resolvers: [{ protocol: 'udp', server: '1.1.1.1' }, { protocol: 'udp', server: 'not-an-address' }],
    })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error).toContain('Resolver 2')
    expect(validateProbeConfig('dns', 'example.com', { resolvers: [{ protocol: 'udp', server: '1.1.1.1' }], recordType: 'SRV' })).toMatchObject({ ok: false })
  })

  it('ignores resolvers on a target that is itself a server to ask', () => {
    expect(validateProbeConfig('dns', '1.1.1.1', { resolvers: [{ protocol: 'udp', server: '9.9.9.9' }] })).toEqual({ ok: true, config: {} })
  })

  it('takes how many packets a ping probe sends, and leaves the usual 20 unsaid', () => {
    expect(validateProbeConfig('ping', 'example.com', { packets: 50 })).toEqual({ ok: true, config: { packets: 50 } })
    expect(validateProbeConfig('ping', 'example.com', { packets: 20 })).toEqual({ ok: true, config: {} })
    expect(validateProbeConfig('ping', 'example.com', { packets: null })).toEqual({ ok: true, config: {} })
    for (const packets of [4, 101, 12.5, Number.NaN, '50']) {
      expect(validateProbeConfig('ping', 'example.com', { packets })).toMatchObject({ ok: false, error: expect.stringContaining('Packets per probe') })
    }
    // Only a ping counts packets.
    expect(validateProbeConfig('tcp', 'example.com', { port: 22, packets: 50 })).toEqual({ ok: true, config: { port: 22 } })
  })

  it('strips settings that belong to a different probe', () => {
    // A target switched from HTTP to ping must not keep a path nobody can see.
    const leftovers = { port: 443, scheme: 'https', path: '/x', queryName: 'example.org' }

    expect(validateProbeConfig('ping', 'example.com', leftovers)).toEqual({ ok: true, config: {} })
    expect(validateProbeConfig('tcp', 'example.com', leftovers)).toEqual({ ok: true, config: { port: 443 } })
  })
})

describe('game server targets', () => {
  it('reads udp://host:port as a game server, IPv6 included', () => {
    expect(parseAddressInput('udp://203.0.113.5:27015')).toEqual({ host: '203.0.113.5', probeType: 'game', config: { port: 27015 } })
    expect(parseAddressInput('UDP://[2001:db8::1]:19132')).toEqual({ host: '2001:db8::1', probeType: 'game', config: { port: 19132 } })
    expect(parseAddressInput('udp://play.example.com')).toEqual({ host: 'play.example.com', probeType: 'game', config: {} })
  })

  it('needs a port, and asks the Steam query unless told otherwise', () => {
    expect(validateProbeConfig('game', 'example.com', {})).toMatchObject({ ok: false })
    expect(validateProbeConfig('game', 'example.com', { port: 70000 })).toMatchObject({ ok: false })
    expect(validateProbeConfig('game', 'example.com', { port: 27015 })).toEqual({ ok: true, config: { port: 27015, gameQuery: 'source' } })
    expect(validateProbeConfig('game', 'example.com', { port: 19132, gameQuery: 'bedrock', path: '/x' })).toEqual({
      ok: true,
      config: { port: 19132, gameQuery: 'bedrock' },
    })
    expect(validateProbeConfig('game', 'example.com', { port: 1, gameQuery: 'quake4' })).toMatchObject({ ok: false })
    expect(validateProbeConfig('game', '139.84.232.186', { port: 44998, gameQuery: 'unreachable' })).toEqual({
      ok: true,
      config: { port: 44998, gameQuery: 'unreachable' },
    })
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
    expect(targetAddressLabel({ host: '203.0.113.5', probeType: 'game', probeConfig: { port: 27015 } })).toBe('203.0.113.5:27015')
    expect(
      targetAddressLabel({ host: 'example.com', probeType: 'http', probeConfig: { scheme: 'https', path: '/health' } })
    ).toBe('https://example.com/health')
    expect(targetAddressLabel({ host: '1.1.1.1', probeType: 'dns' })).toBe('1.1.1.1')
  })
})

describe('isProbeType', () => {
  it('knows the five probes and nothing else', () => {
    expect(['ping', 'tcp', 'game', 'http', 'dns'].every(isProbeType)).toBe(true)
    expect(isProbeType('icmp')).toBe(false)
    expect(isProbeType(undefined)).toBe(false)
  })
})
