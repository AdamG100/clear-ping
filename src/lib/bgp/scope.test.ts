import { describe, expect, it } from 'vitest'
import type { BgpPeerRoute } from '@/types/bgp'
import { peerPlace } from './collectors'
import { countryName, countryRegion } from './countries'
import { inScope, placeShares, upstreamShares, WORLD } from './scope'

const ORIGIN = 64501
const IX = 37179
const TRANSIT = 6939

function peer(collector: string, country: string, path: number[] | null, effective = true): BgpPeerRoute {
  return {
    collector,
    location: collector,
    country,
    region: countryRegion(country),
    peer: `${collector}-${country}-${path?.join('.') ?? 'none'}`,
    peerAsn: path?.[0] ?? 0,
    route: path ? { collector, peer: '', peerAsn: path[0], prefix: '198.18.96.0/20', path, since: 0 } : null,
    effective,
  }
}

const peers = [
  peer('RRC19', 'ZA', [100, IX, ORIGIN]),
  peer('RRC19', 'ZA', [101, IX, ORIGIN]),
  peer('RRC19', 'ZA', null),
  peer('RRC00', 'KE', [102, TRANSIT, ORIGIN]),
  peer('RRC12', 'DE', [200, TRANSIT, ORIGIN]),
  peer('RRC12', 'DE', [201, IX, ORIGIN], false),
]

describe('countries', () => {
  it('places a country in its registry region', () => {
    expect(countryRegion('ZA')).toBe('africa')
    expect(countryRegion('BR')).toBe('latin-america')
    expect(countryRegion('US')).toBe('north-america')
    expect(countryRegion('SG')).toBe('asia-pacific')
    expect(countryRegion('DE')).toBe('europe')
    expect(countryRegion('AE')).toBe('europe')
  })

  it('names a country, or gives the code back', () => {
    expect(countryName('ZA')).toBe('South Africa')
    expect(countryName('not a code')).toBe('not a code')
  })
})

describe('placing a peer', () => {
  const countries = new Map([[102, 'KE']])
  it('puts a peer at an exchange in the exchange country', () => {
    expect(peerPlace('RRC19', 102, asn => countries.get(asn))).toEqual({ country: 'ZA', region: 'africa' })
  })

  it('puts a multihop peer where its network is registered, once known', () => {
    expect(peerPlace('RRC00', 102, asn => countries.get(asn))).toEqual({ country: 'KE', region: 'africa' })
    expect(peerPlace('RRC00', 999, asn => countries.get(asn))).toEqual({ country: 'NL', region: 'europe' })
  })
})

describe('narrowing a prefix page', () => {
  it('lists the regions for the world, every one of them', () => {
    const rows = placeShares(peers, WORLD)
    expect(rows.map(row => row.key)).toEqual(['africa', 'europe', 'north-america', 'latin-america', 'asia-pacific'])
    expect(rows[0]).toMatchObject({ seen: 3, total: 4 })
    expect(rows[2]).toMatchObject({ seen: 0, total: 0 })
  })

  it('lists the countries in a region, biggest first, and the exchanges in a country', () => {
    expect(placeShares(peers, { ...WORLD, region: 'africa' }).map(row => [row.key, row.seen, row.total])).toEqual([
      ['ZA', 2, 3],
      ['KE', 1, 1],
    ])
    expect(placeShares(peers, { ...WORLD, region: 'africa', country: 'ZA' }).map(row => row.key)).toEqual(['RRC19'])
  })

  it('counts those through the upstream chosen', () => {
    const rows = placeShares(peers, { ...WORLD, upstream: IX })
    expect(rows[0].via).toBe(2)
    // The second German peer's route is not the one that counts.
    expect(rows[1].via).toBe(0)
  })

  it('works out who carries it in a place, keeping whether each is usual', () => {
    const africa = peers.filter(each => each.region === 'africa')
    expect(upstreamShares(africa, [{ asn: TRANSIT, peers: 9, expected: false }])).toEqual([
      { asn: IX, peers: 2, expected: true },
      { asn: TRANSIT, peers: 1, expected: false },
    ])
  })

  it('keeps the peers in the place and through the upstream', () => {
    expect(peers.filter(each => inScope(each, { region: 'africa', country: null, upstream: TRANSIT }))).toHaveLength(1)
  })
})
