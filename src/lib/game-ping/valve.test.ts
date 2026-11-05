import { describe, expect, it } from 'vitest'
import { continentAt, readSdrConfig } from './valve'

/**
 * Three locations as Valve's GetSDRConfig gives them, from a public capture of
 * Dota 2's (revision 1793736599): one of Valve's own, a partner's without
 * relays, and Alibaba's in Shanghai. Relays trimmed to two.
 */
const SDR_CONFIG = {
  revision: 1793736599,
  pops: {
    fra: {
      desc: 'Frankfurt (Germany)',
      geo: [8.68, 50.12],
      partners: 1,
      tier: 0,
      relays: [
        { ipv4: '155.133.226.68', port_range: [27015, 27140] },
        { ipv4: '155.133.226.70', port_range: [27015, 27140] },
      ],
    },
    mfr1: { desc: 'Multiplay Frankfurt (Germany)', geo: [8.68, 50.12], partners: 0, relay_public_key: 'EE41', tier: 2 },
    pvgt: {
      desc: 'Alibaba Cloud Shanghai - Telecom (China)',
      geo: [121.5, 31.2],
      partners: 2,
      tier: 1,
      relays: [{ ipv4: '61.152.104.1', port_range: [27015, 27044] }],
    },
  },
  typical_pings: [['fra', 'pvgt', 180]],
  success: true,
}

describe('readSdrConfig', () => {
  it('makes a region of each location with relays, pinged at its first relay', () => {
    expect(readSdrConfig(SDR_CONFIG)).toEqual([
      { id: 'pvgt', label: 'Alibaba Cloud Shanghai - Telecom, China', continent: 'Asia', host: '61.152.104.1', method: { kind: 'icmp' } },
      { id: 'fra', label: 'Frankfurt, Germany', continent: 'Europe', host: '155.133.226.68', method: { kind: 'icmp' } },
    ])
  })

  it('leaves out anything not shaped as a location with relays', () => {
    const odd = {
      pops: {
        bad1: { desc: 'No place', relays: [{ ipv4: '10.0.0.1' }] },
        bad2: { desc: 'Bad address', geo: [0, 51], relays: [{ ipv4: 'not-an-ip' }] },
        'BAD CODE': { desc: 'Bad code', geo: [0, 51], relays: [{ ipv4: '10.0.0.2' }] },
      },
    }
    expect(readSdrConfig(odd)).toEqual([])
  })

  it('refuses an answer with no list at all', () => {
    expect(() => readSdrConfig({ success: false })).toThrow(/no list/)
    expect(() => readSdrConfig(null)).toThrow()
  })
})

describe('continentAt', () => {
  it.each([
    ['Frankfurt', 8.68, 50.12, 'Europe'],
    ['Madrid', -3.7, 40.4, 'Europe'],
    ['Istanbul', 29, 41, 'Europe'],
    ['Stockholm', 18, 59.3, 'Europe'],
    ['Dubai', 55.3, 25.2, 'Middle East'],
    ['Tel Aviv', 34.8, 32.1, 'Middle East'],
    ['Cairo', 31.2, 30, 'Africa'],
    ['Johannesburg', 28, -26.2, 'Africa'],
    ['Lagos', 3.4, 6.5, 'Africa'],
    ['Seattle', -122.3, 47.6, 'North America'],
    ['Atlanta', -84.4, 33.7, 'North America'],
    ['São Paulo', -46.6, -23.5, 'South America'],
    ['Lima', -77, -12, 'South America'],
    ['Mumbai', 72.8, 19, 'Asia'],
    ['Hong Kong', 114.2, 22.3, 'Asia'],
    ['Tokyo', 139.7, 35.7, 'Asia'],
    ['Singapore', 103.8, 1.35, 'Asia'],
    ['Sydney', 151.2, -33.9, 'Oceania'],
  ])('puts %s in the right place', (_city, longitude, latitude, continent) => {
    expect(continentAt(longitude, latitude)).toBe(continent)
  })
})
