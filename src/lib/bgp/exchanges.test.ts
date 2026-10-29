import { describe, expect, it } from 'vitest'
import { crossingOf, exchangeOf, joinExchanges, likelyCrossing, exchangesOnPaths, sharedExchanges, type ExchangeLan } from './exchanges'
import { readIxpdb } from './ixpdb'
import { addressKey } from './prefix'

const NAPAFRICA = { name: 'NAPAfrica IX Johannesburg', city: 'Johannesburg', country: 'ZA' }
const JINX = { name: 'JINX', city: 'Johannesburg', country: 'ZA' }

const lans: ExchangeLan[] = [
  { prefix: '198.19.8.0/22', exchange: NAPAFRICA },
  { prefix: '198.19.96.0/22', exchange: JINX },
  { prefix: '2001:43f8:6d0::/48', exchange: NAPAFRICA },
]

describe('exchanges', () => {
  it('finds the exchange whose peering LAN holds an address', () => {
    expect(exchangeOf('198.19.8.129', lans)?.exchange).toBe(NAPAFRICA)
    expect(exchangeOf('198.19.97.1', lans)?.exchange).toBe(JINX)
    expect(exchangeOf('2001:43f8:6d0::12', lans)?.exchange).toBe(NAPAFRICA)
    expect(exchangeOf('1.1.1.1', lans)).toBeNull()
  })

  it('says where a traceroute crossed, by the first hop on an exchange', () => {
    const hops = [
      { hop: 1, address: '172.22.2.1' },
      { hop: 2, address: null },
      { hop: 5, address: '154.0.0.82' },
      { hop: 6, address: '198.19.8.129' },
      { hop: 7, address: '102.218.212.29' },
    ]
    expect(crossingOf(hops, lans)).toEqual({ ...NAPAFRICA, address: '198.19.8.129', hop: 6, member: null })
    expect(crossingOf(hops.slice(0, 3), lans)).toBeNull()
  })

  it('names the member whose address the hop on the exchange is, from IXPDB', () => {
    const ports = { [addressKey('198.19.8.129')!]: 64501 }
    expect(crossingOf([{ hop: 6, address: '198.19.8.129' }], lans, ports)?.member).toBe(64501)
  })

  // Members by AS number, as places in the list: AS64500 and AS64501 meet at
  // both exchanges, AS64502 only at JINX.
  const members = { exchanges: [NAPAFRICA, JINX], members: { 64500: [0, 1], 64501: [0, 1], 64502: [1] } }

  it('names the exchanges two networks are both members of', () => {
    expect(sharedExchanges(64500, 64502, members)).toEqual([JINX])
    expect(sharedExchanges(64500, 64501, members)).toEqual([NAPAFRICA, JINX])
    expect(sharedExchanges(64500, 64999, members)).toEqual([])
  })

  it('says where a trace with no hop on a LAN probably crossed, passing over hops not known', () => {
    const hops = [
      { hop: 1, asn: null },
      { hop: 2, asn: 64502 },
      { hop: 3, asn: 64502 },
      { hop: 4, asn: null },
      { hop: 5, asn: 64500 },
    ]
    expect(likelyCrossing(hops, members)).toEqual({ exchanges: [JINX], from: 64502, to: 64500, hop: 5 })
  })

  it('says nothing where the networks either side share no exchange', () => {
    expect(likelyCrossing([{ hop: 1, asn: 64502 }, { hop: 2, asn: 64999 }], members)).toBeNull()
  })

  it('puts IXPDB members on the exchange whose LAN holds their address', () => {
    const ixpdb = readIxpdb([
      { asn: 64503, ip_addresses: ['198.19.97.20', '2001:43F8:6D0::0:12', null, ''] },
      { asn: 64500, ip_addresses: ['198.19.8.1'] },
      { asn: 64504, ip_addresses: ['192.0.2.1'] },
    ])
    expect(ixpdb.ports[addressKey('2001:43f8:6d0::12')!]).toBe(64503)
    const joined = joinExchanges({ lans, ...members }, ixpdb)!
    // AS64503 is on JINX and NAPAfrica by its addresses, though PeeringDB had it on neither.
    expect(joined.members[64503]).toEqual([1, 0])
    // AS64500 was already on NAPAfrica: not listed twice.
    expect(joined.members[64500]).toEqual([0, 1])
    // An address on no LAN known adds nothing.
    expect(joined.members[64504]).toBeUndefined()
  })

  it('keeps IXPDB addresses with no PeeringDB, and PeeringDB with no IXPDB', () => {
    const ixpdb = readIxpdb([{ asn: 64503, ip_addresses: ['198.19.97.20'] }])
    expect(joinExchanges(null, ixpdb)).toEqual({ lans: [], exchanges: [], members: {}, ports: ixpdb.ports })
    expect(joinExchanges({ lans, ...members }, null)?.ports).toEqual({})
    expect(joinExchanges(null, null)).toBeNull()
  })
})

describe('the exchanges routes pass through', () => {
  const NAPAFRICA = { name: 'NAPAfrica Johannesburg', city: 'Johannesburg', country: 'ZA' }
  const LINX = { name: 'LINX LON1', city: 'London', country: 'GB' }
  const DECIX = { name: 'DE-CIX Frankfurt', city: 'Frankfurt', country: 'DE' }
  const AMSIX = { name: 'AMS-IX', city: 'Amsterdam', country: 'NL' }
  const data = {
    exchanges: [NAPAFRICA, LINX, DECIX, AMSIX],
    members: {
      // The origin, at NAPAfrica only.
      64500: [0],
      // A local carrier, at NAPAfrica and LINX.
      64501: [0, 1],
      // Two large carriers, meeting at three exchanges.
      64510: [1, 2, 3],
      64511: [1, 2, 3],
    } as Record<string, number[]>,
  }
  const country: Record<number, string> = { 64500: 'ZA', 64501: 'ZA', 64510: 'GB', 64511: 'US' }

  it('places a hand-off at the one exchange the two networks share, anywhere in the world', () => {
    const found = exchangesOnPaths(
      [
        { path: [64510, 64501, 64500], from: 'Berlin VPS' },
        { path: [64501, 64500], from: 'This server' },
        { path: [64501, 64501, 64500], from: 'This server' },
      ],
      data,
      asn => country[asn]
    )
    expect(found).toEqual([
      { exchanges: [NAPAFRICA], routes: 3, from: ['Berlin VPS', 'This server'], handoffs: [{ from: 64501, to: 64500, routes: 3 }] },
      // Further along the first path, in London.
      { exchanges: [LINX], routes: 1, from: ['Berlin VPS'], handoffs: [{ from: 64510, to: 64501, routes: 1 }] },
    ])
  })

  it('places networks that share several exchanges by their countries, or not at all', () => {
    const found = exchangesOnPaths([{ path: [64511, 64510, 64501, 64500], from: 'This server' }], data, asn => country[asn])
    // 64511 and 64510 meet at three exchanges, one in 64510's country: London.
    expect(found.map(each => each.exchanges.map(exchange => exchange.name))).toEqual([['LINX LON1'], ['NAPAfrica Johannesburg']])
    expect(exchangesOnPaths([{ path: [64511, 64510], from: 'This server' }], data)).toEqual([])
  })
})
