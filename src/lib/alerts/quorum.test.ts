import { describe, expect, it } from 'vitest'
import type { ProbePolicy } from '@/types/alert-rules'
import { describeCause, likelyCause, whereSeen } from './cause'
import { describeSpread, judgeMonitor, type ProbeStanding } from './rules'

const probe = (id: string, inBreach: boolean, extra: Partial<ProbeStanding> = {}): ProbeStanding => ({ probe: id, inBreach, silent: false, ...extra })
const twoThirdsOfHealthy: ProbePolicy = { kind: 'share', percent: 66, of: 'healthy' }

describe('a share of the probes that are reporting', () => {
  it('counts the silent probes out when deciding to fire', () => {
    // 2 of the 3 probes that are up are in breach; the other 3 are silent.
    const probes = [probe('a', true), probe('b', true), probe('c', false), probe('d', false, { silent: true }), probe('e', false, { silent: true }), probe('f', false, { silent: true })]
    expect(judgeMonitor(twoThirdsOfHealthy, 'ok', probes).transition).toBe('firing')
    // The same share of all six would need 4.
    expect(judgeMonitor({ kind: 'share', percent: 66 }, 'ok', probes).transition).toBeNull()
  })

  it('does not resolve while silent probes could still make up the share', () => {
    const probes = [probe('a', true), probe('b', true), probe('c', false), probe('d', false, { silent: true }), probe('e', false, { silent: true })]
    expect(judgeMonitor(twoThirdsOfHealthy, 'firing', probes).transition).toBeNull()
  })

  it('never fires and clears on the same probes', () => {
    for (let reporting = 1; reporting <= 6; reporting++) {
      for (let silent = 0; silent <= 4; silent++) {
        for (let breaching = 0; breaching <= reporting; breaching++) {
          const probes = [
            ...Array.from({ length: reporting }, (_, i) => probe(`r${i}`, i < breaching)),
            ...Array.from({ length: silent }, (_, i) => probe(`s${i}`, false, { silent: true })),
          ]
          const fires = judgeMonitor(twoThirdsOfHealthy, 'ok', probes).transition === 'firing'
          const clears = judgeMonitor(twoThirdsOfHealthy, 'firing', probes).transition === 'resolved'
          expect(fires && clears).toBe(false)
        }
      }
    }
  })
})

describe('probes in breach spread over regions and networks', () => {
  const spread = { regions: 3, networks: 2 }
  const anyProbe: ProbePolicy = { kind: 'any' }

  it('fires only when enough different regions and networks are in breach', () => {
    const narrow = [probe('a', true, { region: 'Europe', network: 'N1' }), probe('b', true, { region: 'Europe', network: 'N2' }), probe('c', false, { region: 'Asia', network: 'N3' })]
    expect(judgeMonitor(anyProbe, 'ok', narrow, spread).transition).toBeNull()

    const wide = [
      probe('a', true, { region: 'Europe', network: 'N1' }),
      probe('b', true, { region: 'Asia', network: 'N2' }),
      probe('c', true, { region: 'Oceania', network: 'N2' }),
    ]
    expect(judgeMonitor(anyProbe, 'ok', wide, spread).transition).toBe('firing')
  })

  it('does not count a probe with no label', () => {
    const unlabelled = [probe('a', true), probe('b', true), probe('c', true)]
    expect(judgeMonitor(anyProbe, 'ok', unlabelled, spread).transition).toBeNull()
  })

  it('is described in words', () => {
    expect(describeSpread(spread)).toBe('from at least 3 regions and 2 networks')
    expect(describeSpread({ regions: 1 })).toBe('from at least 1 region')
    expect(describeSpread(null)).toBe('')
  })
})

describe('what most likely broke', () => {
  const failed = { success: false, latency: null, packetLoss: 100 as number | undefined }

  it('reads the failing reading', () => {
    expect(likelyCause({ ...failed, errorMessage: 'connect ECONNREFUSED 192.0.2.1:443' }, 0)).toBe('the connection was refused')
    expect(likelyCause({ ...failed, errorMessage: 'getaddrinfo ENOTFOUND example.test' }, 0)).toBe('its name did not resolve')
    expect(likelyCause({ ...failed, errorMessage: 'Timed out' }, 0)).toBe('it did not answer in time')
    expect(likelyCause({ ...failed, details: { certExpiresAt: 1000 } }, 2000)).toBe('its certificate has expired')
    expect(likelyCause({ ...failed, details: { statusCode: 503 } }, 0)).toBe('it answered with HTTP 503')
    expect(likelyCause({ success: true, latency: 5, packetLoss: 0 }, 0)).toBeNull()
  })

  it('says when only one region sees it', () => {
    expect(whereSeen([{ inBreach: true, silent: false, region: 'Asia' }, { inBreach: false, silent: false, region: 'Europe' }])).toBe('seen from Asia only')
    expect(whereSeen([{ inBreach: true, silent: false, region: 'Asia' }, { inBreach: true, silent: false, region: 'Europe' }])).toBeNull()
    expect(whereSeen([{ inBreach: true, silent: false }, { inBreach: false, silent: false }])).toBeNull()
  })

  it('joins what it knows', () => {
    expect(describeCause('the connection was refused', 'seen from Asia only')).toBe('the connection was refused; seen from Asia only')
    expect(describeCause(null, null)).toBeNull()
  })
})
