import { describe, expect, it } from 'vitest'
import {
  DNS_PROVIDERS,
  MAX_DNS_RESOLVERS,
  MAX_RESOLVER_NAME_LENGTH,
  parseDohServer,
  parseDotServer,
  providerOf,
  providerResolver,
  readingName,
  resolverLabel,
  resolverName,
  resolverOfReading,
  validateResolver,
  validateResolvers,
} from './dns-resolvers'

const cloudflare = DNS_PROVIDERS[0]

describe('validateResolver', () => {
  it('takes the system resolver, which has no address', () => {
    expect(validateResolver({ protocol: 'system', server: 'ignored' })).toEqual({ ok: true, resolver: { protocol: 'system' } })
  })

  it('takes a plain DNS resolver by its address, and only by its address', () => {
    expect(validateResolver({ protocol: 'udp', server: ' 9.9.9.9 ' })).toEqual({ ok: true, resolver: { protocol: 'udp', server: '9.9.9.9' } })
    expect(validateResolver({ protocol: 'udp', server: '[2620:fe::fe]' })).toEqual({ ok: true, resolver: { protocol: 'udp', server: '2620:fe::fe' } })
    expect(validateResolver({ protocol: 'udp', server: 'dns.google' })).toMatchObject({ ok: false })
    expect(validateResolver({ protocol: 'udp', server: '' })).toMatchObject({ ok: false })
  })

  it('takes a DNS over TLS resolver by name or address, with a port only when it is unusual', () => {
    expect(validateResolver({ protocol: 'dot', server: 'dns.quad9.net' })).toEqual({ ok: true, resolver: { protocol: 'dot', server: 'dns.quad9.net' } })
    expect(validateResolver({ protocol: 'dot', server: 'tls://1.1.1.1:853' })).toEqual({ ok: true, resolver: { protocol: 'dot', server: '1.1.1.1' } })
    expect(validateResolver({ protocol: 'dot', server: 'dns.example.net:8853' })).toEqual({ ok: true, resolver: { protocol: 'dot', server: 'dns.example.net:8853' } })
    expect(validateResolver({ protocol: 'dot', server: '[2620:fe::fe]:8853' })).toEqual({ ok: true, resolver: { protocol: 'dot', server: '[2620:fe::fe]:8853' } })
    expect(validateResolver({ protocol: 'dot', server: 'not a host' })).toMatchObject({ ok: false })
  })

  it('takes a DNS over HTTPS resolver as a URL, filling in what is usually left unsaid', () => {
    expect(validateResolver({ protocol: 'doh', server: 'dns.google' })).toEqual({
      ok: true,
      resolver: { protocol: 'doh', server: 'https://dns.google/dns-query' },
    })
    expect(validateResolver({ protocol: 'doh', server: 'https://dns.example.net/resolve?ct=1' })).toEqual({
      ok: true,
      resolver: { protocol: 'doh', server: 'https://dns.example.net/resolve?ct=1' },
    })
    expect(validateResolver({ protocol: 'doh', server: 'ftp://dns.example.net/' })).toMatchObject({ ok: false })
    expect(validateResolver({ protocol: 'doh', server: 'https://bad host/' })).toMatchObject({ ok: false })
    expect(validateResolver({ protocol: 'doh' })).toMatchObject({ ok: false })
  })

  it('keeps a name given to a resolver, and nothing where none was', () => {
    expect(validateResolver({ protocol: 'doh', server: 'dns.example.net', name: ' Office ' })).toEqual({
      ok: true,
      resolver: { protocol: 'doh', server: 'https://dns.example.net/dns-query', name: 'Office' },
    })
    expect(validateResolver({ protocol: 'udp', server: '192.168.1.1', name: '  ' })).toEqual({
      ok: true,
      resolver: { protocol: 'udp', server: '192.168.1.1' },
    })
    expect(validateResolver({ protocol: 'system', name: 'Mine' })).toEqual({ ok: true, resolver: { protocol: 'system' } })
    expect(validateResolver({ protocol: 'udp', server: '192.168.1.1', name: 'x'.repeat(MAX_RESOLVER_NAME_LENGTH + 1) })).toMatchObject({ ok: false })
  })

  it('refuses a protocol it does not know, and anything that is not a resolver', () => {
    expect(validateResolver({ protocol: 'quic', server: '1.1.1.1' })).toMatchObject({ ok: false })
    expect(validateResolver('1.1.1.1')).toMatchObject({ ok: false })
    expect(validateResolver(null)).toMatchObject({ ok: false })
  })
})

describe('where a resolver is', () => {
  it('reads a DNS over TLS address, with or without a port', () => {
    expect(parseDotServer('dns.google')).toEqual({ host: 'dns.google', port: 853 })
    expect(parseDotServer('9.9.9.9:8853')).toEqual({ host: '9.9.9.9', port: 8853 })
    expect(parseDotServer('2620:fe::fe')).toEqual({ host: '2620:fe::fe', port: 853 })
    expect(parseDotServer('[2620:fe::fe]:853')).toEqual({ host: '2620:fe::fe', port: 853 })
    expect(parseDotServer('dns.google:99999')).toBeNull()
  })

  it('reads a DNS over HTTPS address', () => {
    expect(parseDohServer('https://cloudflare-dns.com/dns-query')?.toString()).toBe('https://cloudflare-dns.com/dns-query')
    expect(parseDohServer('http://192.168.1.2:8080')?.toString()).toBe('http://192.168.1.2:8080/dns-query')
    expect(parseDohServer('')).toBeNull()
  })
})

describe('resolverLabel', () => {
  it('names a known provider, and the protocol when it is not plain DNS', () => {
    expect(resolverLabel(providerResolver(cloudflare, 'udp'))).toBe('Cloudflare')
    expect(resolverLabel(providerResolver(cloudflare, 'dot'))).toBe('Cloudflare DoT')
    expect(resolverLabel(providerResolver(cloudflare, 'doh'))).toBe('Cloudflare DoH')
    expect(providerOf(providerResolver(cloudflare, 'doh'))).toBe(cloudflare)
  })

  it('calls any other resolver by where it is', () => {
    expect(resolverLabel({ protocol: 'system' })).toBe('System resolver')
    expect(resolverLabel({ protocol: 'udp', server: '192.168.1.1' })).toBe('192.168.1.1')
    expect(resolverLabel({ protocol: 'dot', server: 'dns.example.net:8853' })).toBe('dns.example.net:8853 DoT')
    expect(resolverLabel({ protocol: 'doh', server: 'https://dns.example.net/dns-query' })).toBe('dns.example.net DoH')
    expect(resolverLabel({ protocol: 'doh', server: 'https://dns.example.net/family' })).toBe('dns.example.net/family DoH')
    expect(providerOf({ protocol: 'udp', server: '192.168.1.1' })).toBeNull()
  })

  it('calls a resolver that was given a name by it, always with how it is asked', () => {
    expect(resolverLabel({ protocol: 'udp', server: '192.168.1.1', name: 'Pi-hole' })).toBe('Pi-hole DNS')
    expect(resolverLabel({ protocol: 'dot', server: 'dns.example.net', name: 'Office' })).toBe('Office DoT')
    expect(resolverLabel({ protocol: 'doh', server: 'https://dns.example.net/dns-query', name: ' Office ' })).toBe('Office DoH')
    // Even at an address the list knows: the name is what was asked for.
    expect(resolverLabel({ protocol: 'udp', server: '1.1.1.1', name: 'Upstream' })).toBe('Upstream DNS')
    // A name not typed yet is no name.
    expect(resolverLabel({ protocol: 'udp', server: '192.168.1.1', name: ' ' })).toBe('192.168.1.1')
  })

  it('gives every provider a different name over every protocol', () => {
    const labels = DNS_PROVIDERS.flatMap(provider =>
      (['udp', 'dot', 'doh'] as const).map(protocol => resolverLabel(providerResolver(provider, protocol)))
    )
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('a stored reading and the resolver it was taken from', () => {
  const office = { protocol: 'doh', server: 'https://dns.example.net/dns-query', name: 'Office' } as const
  const list = [providerResolver(cloudflare, 'dot'), office]
  const reading = (label: string, protocol: 'udp' | 'dot' | 'doh', server?: string) => ({ label, protocol, server, latency: 1, loss: 0 })

  it('says who a resolver is without how it is asked, for beside a badge that says it', () => {
    expect(resolverName(office)).toBe('Office')
    expect(resolverName(providerResolver(cloudflare, 'doh'))).toBe('Cloudflare')
    expect(resolverName({ protocol: 'doh', server: 'https://dns.example.net/family' })).toBe('dns.example.net/family')
    expect(resolverName({ protocol: 'dot', server: 'dns.example.net:8853' })).toBe('dns.example.net:8853')
    expect(resolverName({ protocol: 'system' })).toBe('System resolver')
  })

  it('finds the resolver by where it is, so a name given since is the one shown', () => {
    const taken = reading('dns.example.net DoH', 'doh', office.server)
    expect(resolverOfReading(taken, list)).toBe(office)
    expect(readingName(taken, list)).toBe('Office')
    // Renamed again: still the same resolver.
    expect(readingName(reading('Old name DoH', 'doh', office.server), list)).toBe('Office')
    // The same address asked another way is another resolver.
    expect(resolverOfReading(reading('x', 'dot', office.server), list)).toBeUndefined()
  })

  it('finds one from before where it was got kept, by what it was called', () => {
    expect(readingName(reading('dns.example.net DoH', 'doh'), list)).toBe('Office')
    expect(readingName(reading('Office DoH', 'doh'), list)).toBe('Office')
    expect(readingName(reading('Cloudflare DoT', 'dot'), list)).toBe('Cloudflare')
  })

  it('calls one that is no longer listed by what it was called, less the protocol', () => {
    expect(readingName(reading('Quad9 DoH', 'doh', 'https://dns.quad9.net/dns-query'), list)).toBe('Quad9')
    expect(readingName(reading('192.168.1.1', 'udp', '192.168.1.1'), list)).toBe('192.168.1.1')
    expect(readingName(reading('Pi-hole DNS', 'udp'))).toBe('Pi-hole')
  })
})

describe('validateResolvers', () => {
  it('refuses the same resolver under two names, which would be asked twice for one answer', () => {
    expect(
      validateResolvers([
        { protocol: 'udp', server: '192.168.1.1', name: 'Office' },
        { protocol: 'udp', server: '192.168.1.1', name: 'Home' },
      ])
    ).toEqual({ ok: false, error: 'Home DNS is the same resolver as Office DNS' })
    expect(validateResolvers([{ protocol: 'udp', server: '1.1.1.1' }, { protocol: 'udp', server: '1.1.1.1', name: 'Upstream' }])).toMatchObject({ ok: false })
  })

  it('treats no list, an empty one and the system resolver alone as the same: nothing to store', () => {
    expect(validateResolvers(undefined)).toEqual({ ok: true, resolvers: [] })
    expect(validateResolvers([])).toEqual({ ok: true, resolvers: [] })
    expect(validateResolvers([{ protocol: 'system' }])).toEqual({ ok: true, resolvers: [] })
  })

  it('keeps a list in its order, each address written the one way', () => {
    expect(
      validateResolvers([{ protocol: 'system' }, { protocol: 'udp', server: '1.1.1.1 ' }, { protocol: 'doh', server: 'dns.google' }])
    ).toEqual({
      ok: true,
      resolvers: [{ protocol: 'system' }, { protocol: 'udp', server: '1.1.1.1' }, { protocol: 'doh', server: 'https://dns.google/dns-query' }],
    })
  })

  it('keeps one resolver by itself when it is not the system’s', () => {
    expect(validateResolvers([{ protocol: 'dot', server: 'dns.quad9.net' }])).toEqual({
      ok: true,
      resolvers: [{ protocol: 'dot', server: 'dns.quad9.net' }],
    })
  })

  it('says which resolver is wrong', () => {
    const checked = validateResolvers([{ protocol: 'udp', server: '1.1.1.1' }, { protocol: 'udp', server: 'nope' }])
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.error).toContain('Resolver 2')
  })

  it('refuses the same resolver twice, however it was typed', () => {
    const checked = validateResolvers([{ protocol: 'doh', server: 'dns.google' }, { protocol: 'doh', server: 'https://dns.google/dns-query' }])
    expect(checked).toEqual({ ok: false, error: 'Google DoH is listed twice' })
    expect(validateResolvers([{ protocol: 'system' }, { protocol: 'system' }])).toMatchObject({ ok: false })
  })

  it('refuses two resolvers given the same name over the same protocol, which one line could not tell apart', () => {
    const office = (server: string, protocol = 'udp') => ({ protocol, server, name: 'Office' })

    expect(validateResolvers([office('192.168.1.1'), office('192.168.1.2')])).toEqual({ ok: false, error: 'Office DNS is listed twice' })
    expect(validateResolvers([office('192.168.1.1'), office('192.168.1.1', 'dot')])).toMatchObject({ ok: true })
  })

  it('refuses a list too long to read as lines on a chart, or anything that is not a list', () => {
    const many = Array.from({ length: MAX_DNS_RESOLVERS + 1 }, (_, index) => ({ protocol: 'udp', server: `192.0.2.${index + 1}` }))
    expect(validateResolvers(many)).toMatchObject({ ok: false })
    expect(validateResolvers(many.slice(1))).toMatchObject({ ok: true })
    expect(validateResolvers('1.1.1.1')).toMatchObject({ ok: false })
  })
})
