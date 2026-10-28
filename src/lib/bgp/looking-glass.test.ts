import { describe, expect, it } from 'vitest'
import type { BgpExchangeLook, BgpExchangeRoute } from '@/types/bgp'
import { offExchanges, originPresent, readServerName } from './looking-glass'

const ORIGIN = 64504

function route(path: number[]): BgpExchangeRoute {
  return { peerAsn: path[0], gateway: '192.0.2.1', prefix: '203.0.113.0/24', path, best: false, since: null }
}

function look(views: Record<string, number[][]>, ready = true): BgpExchangeLook {
  return {
    at: 0,
    error: null,
    views: Object.entries(views).map(([exchange, paths]) => ({ exchange, city: null, source: 'INX-ZA', ready, routes: paths.map(route) })),
  }
}

describe('the exchanges route collectors', () => {
  it('reads the exchange and address family from a collector name', () => {
    expect(readServerName('JINX Route Collector (IPv4)')).toEqual({ exchange: 'JINX', version: 4 })
    expect(readServerName('NMBINX Route Collector (IPv6)')).toEqual({ exchange: 'NMBINX', version: 6 })
    expect(readServerName('Route server')).toEqual({ exchange: 'Route', version: null })
  })

  it('finds where the origin offers it itself, not where only others do', () => {
    const now = look({ JINX: [[ORIGIN], [64502, ORIGIN]], CINX: [[64502, ORIGIN]], DINX: [] })
    expect(originPresent(now, [ORIGIN])).toEqual(['JINX'])
  })

  it('says it went off an exchange when the origin stops offering it there', () => {
    const now = look({ JINX: [[64502, ORIGIN], [64503, 64502, ORIGIN]], CINX: [] })
    expect(offExchanges(['JINX', 'CINX'], now, [ORIGIN])).toEqual([
      'Off the exchange at JINX: the origin no longer offers it there itself, only through AS64502, AS64503',
      'Off the exchange at CINX: the origin no longer offers it there itself, and no member offers it there',
    ])
  })

  it('says nothing while the origin is still there, or the collector has not read its routes', () => {
    expect(offExchanges(['JINX'], look({ JINX: [[ORIGIN]] }), [ORIGIN])).toEqual([])
    expect(offExchanges(['JINX'], look({ JINX: [] }, false), [ORIGIN])).toEqual([])
    expect(offExchanges(['JINX'], look({}), [ORIGIN])).toEqual([])
  })
})
