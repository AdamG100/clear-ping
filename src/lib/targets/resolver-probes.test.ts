import { describe, expect, it } from 'vitest'
import type { DnsResolver } from '@/types/probe'
import { validateResolvers } from '../probes/dns/resolvers'
import { changedResolvers, configForProbe, probesLeftWithout } from './resolver-probes'

const PUBLIC: DnsResolver = { protocol: 'doh', server: 'https://public.example.net/dns-query' }
const PROVIDER: DnsResolver = { protocol: 'doh', server: 'https://provider.example.net/dns-query', name: 'Provider' }

describe('which probes ask which resolvers', () => {
  it('leaves a resolver out for the probe it is not asked from, and tells no probe why', () => {
    const config = { resolvers: [PUBLIC, { ...PROVIDER, notFrom: ['local'] }] }
    expect(configForProbe(config, 'local')?.resolvers).toEqual([PUBLIC])
    expect(configForProbe(config, 'home')?.resolvers).toEqual([PUBLIC, PROVIDER])
  })

  it('asks them all rather than none, and leaves other settings alone', () => {
    const config = { recordType: 'A' as const, resolvers: [{ ...PUBLIC, notFrom: ['local'] }] }
    expect(configForProbe(config, 'local')).toEqual({ recordType: 'A', resolvers: [PUBLIC] })
    expect(configForProbe({ port: 443 }, 'local')).toEqual({ port: 443 })
    expect(configForProbe(undefined, 'local')).toBeUndefined()
  })

  it('changes only the resolvers named, and drops an empty list', () => {
    const off = changedResolvers([PUBLIC, PROVIDER], [{ ...PROVIDER, probe: 'local', asked: false }])
    expect(off).toEqual([PUBLIC, { ...PROVIDER, notFrom: ['local'] }])
    expect(changedResolvers(off, [{ ...PROVIDER, probe: 'local', asked: true }])).toEqual([PUBLIC, PROVIDER])
  })

  it('says which probes would have nothing left to ask', () => {
    const resolvers = [{ ...PUBLIC, notFrom: ['local'] }, { ...PROVIDER, notFrom: ['local', 'home'] }]
    expect(probesLeftWithout(resolvers, ['local', 'home', 'vps'])).toEqual(['local'])
    expect(probesLeftWithout([], ['local'])).toEqual([])
  })

  it('keeps the exclusions through validation', () => {
    const checked = validateResolvers([PUBLIC, { ...PROVIDER, notFrom: ['local', 7, ''] }])
    expect(checked).toEqual({ ok: true, resolvers: [PUBLIC, { ...PROVIDER, notFrom: ['local'] }] })
  })
})
