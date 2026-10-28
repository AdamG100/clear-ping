import { describe, expect, it } from 'vitest'
import { crossingOf, exchangeOf, likelyCrossing, sharedExchanges, type ExchangeLan } from './exchanges'

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
    expect(crossingOf(hops, lans)).toEqual({ ...NAPAFRICA, address: '198.19.8.129', hop: 6 })
    expect(crossingOf(hops.slice(0, 3), lans)).toBeNull()
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
})
