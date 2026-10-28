import { describe, expect, it } from 'vitest'
import { BGP_DIRECT, type BgpRoute } from '@/types/bgp'
import { assess, effectiveRoutes, takeBaseline } from './assess'

const PREFIX = '198.18.96.0/20'
const ORIGIN = 64501
const IX = 37179
const TRANSIT = 6939
const SCRUBBER = 64500

function route(collector: string, peer: string, path: number[], prefix = PREFIX, since = 1_000): BgpRoute {
  return { collector, peer, peerAsn: path[0], prefix, path, since }
}

/** Ten peers: eight in Africa and Europe through the exchange, two through transit. */
function normal(): BgpRoute[] {
  return [
    ...Array.from({ length: 4 }, (_, i) => route('RRC19', `198.19.8.${i}`, [100 + i, IX, ORIGIN])),
    ...Array.from({ length: 4 }, (_, i) => route('RRC12', `80.81.0.${i}`, [200 + i, IX, ORIGIN])),
    route('RRC11', '198.32.0.1', [300, TRANSIT, ORIGIN]),
    route('RRC11', '198.32.0.2', [301, TRANSIT, ORIGIN, ORIGIN]),
  ]
}

describe('taking normal', () => {
  it('records the origin, the usual upstreams, the peers and the prefixes', () => {
    const baseline = takeBaseline(normal(), PREFIX, null, 5)
    expect(baseline.origins).toEqual([ORIGIN])
    expect(baseline.upstreams).toEqual([IX, TRANSIT])
    expect(baseline.peers).toHaveLength(10)
    expect(baseline.prefixes).toEqual([PREFIX])
  })
})

describe('assessing a prefix', () => {
  const baseline = takeBaseline(normal(), PREFIX, null, 5)
  const watched = { prefix: PREFIX, address: null, baseline }

  it('is learning until there is a normal to judge against', () => {
    expect(assess({ ...watched, baseline: null }, normal()).state).toBe('learning')
  })

  it('is normal as it was, with every region accounted for', () => {
    const status = assess(watched, normal())
    expect(status.state).toBe('normal')
    expect(status.visibility).toEqual({ seen: 10, total: 10 })
    expect(status.byRegion.africa).toEqual({ seen: 4, total: 4 })
    expect(status.byRegion['north-america']).toEqual({ seen: 2, total: 2 })
    expect(status.upstreams[0]).toEqual({ asn: IX, peers: 8, expected: true })
  })

  it('calls a move to another upstream a diversion', () => {
    const moved = normal().map(each => (each.collector === 'RRC19' ? { ...each, path: [each.path[0], SCRUBBER, ORIGIN] } : each))
    const status = assess(watched, moved)
    expect(status.state).toBe('diverted')
    expect(status.upstreams.find(each => each.asn === SCRUBBER)).toEqual({ asn: SCRUBBER, peers: 4, expected: false })
    expect(status.reasons[0]).toContain('AS64500')
  })

  it('calls a new more-specific a diversion, and follows it for an address inside it', () => {
    const routes = [...normal(), route('RRC19', '198.19.8.0', [100, SCRUBBER, ORIGIN], '198.18.101.0/24')]
    expect(assess(watched, routes).newPrefixes).toEqual(['198.18.101.0/24'])
    expect(assess(watched, routes).state).toBe('diverted')
    // For the address it holds, that peer's traffic follows the /24.
    const counted = effectiveRoutes(routes, PREFIX, '198.18.101.2')
    expect(counted.get('RRC19|198.19.8.0')?.prefix).toBe('198.18.101.0/24')
    expect(effectiveRoutes(routes, PREFIX, null).get('RRC19|198.19.8.0')?.prefix).toBe(PREFIX)
  })

  it('says how much of the world has lost it, and where', () => {
    const fewer = normal().filter(each => each.collector !== 'RRC19')
    const status = assess(watched, fewer)
    expect(status.state).toBe('partial')
    expect(status.byRegion.africa).toEqual({ seen: 0, total: 4 })
    expect(status.reasons[0]).toContain('Africa')
    expect(assess(watched, []).state).toBe('withdrawn')
  })

  it('suspects a hijack when another network announces it to more than one peer', () => {
    const one = [...normal().slice(1), route('RRC19', '198.19.8.0', [100, 65001])]
    expect(assess(watched, one).state).toBe('normal')
    const two = [...normal().slice(2), route('RRC19', '198.19.8.0', [100, 65001]), route('RRC19', '198.19.8.1', [101, 65001])]
    const status = assess(watched, two)
    expect(status.state).toBe('hijack')
    expect(status.reasons[0]).toContain('AS65001')
  })

  it('calls it off the exchange when the peers that reached it directly go over to transit it already used', () => {
    // At NAPAfrica three peers reach it directly and one through transit; in
    // Europe everyone goes through transit. Both transits are usual.
    const AGILE = 64502
    const BITCO = 64503
    const before = [
      route('RRC19', '198.19.8.1', [64500, ORIGIN]),
      route('RRC19', '198.19.8.2', [37239, ORIGIN]),
      route('RRC19', '198.19.8.3', [917, ORIGIN]),
      route('RRC19', '198.19.8.4', [327960, BITCO, ORIGIN]),
      route('RRC12', '80.81.0.1', [200, 137409, AGILE, ORIGIN]),
      route('RRC12', '80.81.0.2', [201, 137409, AGILE, ORIGIN]),
    ]
    const normalNow = takeBaseline(before, PREFIX, null, 5)
    expect(normalNow.directPeers).toEqual(['RRC19|198.19.8.1', 'RRC19|198.19.8.2', 'RRC19|198.19.8.3'])
    const usual = { prefix: PREFIX, address: null, baseline: normalNow }
    expect(assess(usual, before).state).toBe('normal')
    expect(assess(usual, before).upstreams[0]).toEqual({ asn: BGP_DIRECT, peers: 3, expected: true })

    const offTheExchange = [
      route('RRC19', '198.19.8.1', [64500, AGILE, ORIGIN]),
      route('RRC19', '198.19.8.2', [37239, BITCO, ORIGIN]),
      route('RRC19', '198.19.8.3', [917, ORIGIN]),
      ...before.slice(3),
    ]
    const status = assess(usual, offTheExchange)
    // Agile and Bitco were usual: only the move off the exchange gives it away.
    expect(status.upstreams.every(each => each.expected)).toBe(true)
    expect(status.state).toBe('diverted')
    expect(status.reasons[0]).toBe(
      'Off the exchange at Johannesburg, NAPAfrica: 2 of the 3 peers there that reached it directly now go through AS64502, AS64503'
    )

    // A normal taken before direct peers were recorded says nothing either way.
    expect(assess({ ...usual, baseline: { ...normalNow, directPeers: undefined } }, offTheExchange).state).toBe('normal')
  })
})
