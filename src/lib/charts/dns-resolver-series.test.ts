import { describe, expect, it } from 'vitest'
import type { DnsResolverReading } from '@/types/probe'
import { resolverSeries, resolversThatDiffer, type ResolverRound } from './dns-resolver-series'

const MINUTE = 60_000

const reading = (label: string, latency: number | null, extra: Partial<DnsResolverReading> = {}): DnsResolverReading => ({
  label,
  protocol: 'udp',
  latency,
  loss: latency === null ? 100 : 0,
  ...extra,
})

/** Three rounds a minute apart: Quad9 slower throughout, and silent in the last. */
const rounds: ResolverRound[] = [
  { timestamp: 0 * MINUTE + 5000, readings: [reading('Cloudflare', 10), reading('Quad9', 30)] },
  { timestamp: 1 * MINUTE + 5000, readings: [reading('Cloudflare', 12), reading('Quad9', 34, { loss: 20 })] },
  { timestamp: 2 * MINUTE + 5000, readings: [reading('Cloudflare', 14), reading('Quad9', null)] },
]

describe('resolverSeries', () => {
  it('gives each resolver a line of its own, a point to a round', () => {
    const [cloudflare, quad9] = resolverSeries('t', rounds, MINUTE)

    expect(cloudflare.label).toBe('Cloudflare')
    expect(cloudflare.buckets.map(bucket => bucket.p50Latency)).toEqual([10, 12, 14])
    expect(cloudflare.buckets.map(bucket => bucket.timestamp.getTime())).toEqual([0.5 * MINUTE, 1.5 * MINUTE, 2.5 * MINUTE])

    expect(quad9.buckets.map(bucket => bucket.p50Latency)).toEqual([30, 34, null])
    expect(quad9.buckets.map(bucket => bucket.packetLoss)).toEqual([0, 20, 100])
    expect(quad9.buckets.map(bucket => bucket.isOnline)).toEqual([true, true, false])
  })

  it('folds the rounds of a wider bucket together', () => {
    const [cloudflare, quad9] = resolverSeries('t', rounds, 3 * MINUTE)

    expect(cloudflare.buckets).toHaveLength(1)
    expect(cloudflare.buckets[0]).toMatchObject({ sampleCount: 3, latency: 12, minLatency: 10, maxLatency: 14, p50Latency: 12, packetLoss: 0 })
    expect(quad9.buckets[0]).toMatchObject({ sampleCount: 3, latency: 32, maxPacketLoss: 100, isOnline: true })
    expect(quad9.buckets[0].packetLoss).toBeCloseTo(40)
  })

  it('sums each resolver up over the period', () => {
    const [cloudflare, quad9] = resolverSeries('t', rounds, MINUTE)

    expect(cloudflare.statistics).toMatchObject({
      targetId: 't',
      sampleCount: 3,
      avgLatency: 12,
      medianLatency: 12,
      minLatency: 10,
      maxLatency: 14,
      packetLoss: 0,
      uptime: 100,
    })
    expect(cloudflare.statistics.lastProbe?.getTime()).toBe(2 * MINUTE + 5000)

    expect(quad9.statistics).toMatchObject({ sampleCount: 3, medianLatency: 32, minPacketLoss: 0, maxPacketLoss: 100 })
    expect(quad9.statistics.packetLoss).toBeCloseTo(40)
    expect(quad9.statistics.uptime).toBeCloseTo(66.67, 1)
  })

  it('lists them in the order the target asks them now, then any it used to ask', () => {
    const changed: ResolverRound[] = [
      { timestamp: 5000, readings: [reading('Old one', 9), reading('Cloudflare', 10)] },
      { timestamp: MINUTE + 5000, readings: [reading('Cloudflare', 11), reading('Quad9', 30)] },
    ]
    const asksNow = [
      { protocol: 'udp', server: '9.9.9.9' },
      { protocol: 'udp', server: '1.1.1.1' },
      { protocol: 'udp', server: '192.0.2.53' },
    ] as const
    expect(resolverSeries('t', changed, MINUTE, asksNow).map(series => series.label)).toEqual(['Quad9', 'Cloudflare', 'Old one'])
  })

  it('keeps a resolver that was renamed as one line, under the name it has now', () => {
    const office = { protocol: 'doh', server: 'https://dns.example.net/dns-query' } as const
    const at = (label: string, latency: number, server?: string) => reading(label, latency, { protocol: 'doh', server })

    const renamed: ResolverRound[] = [
      // Before where it is was kept with a reading: known by what it was called.
      { timestamp: 5000, readings: [at('dns.example.net DoH', 10)] },
      // Named, then named again.
      { timestamp: MINUTE + 5000, readings: [at('Office DoH', 11, office.server)] },
      { timestamp: 2 * MINUTE + 5000, readings: [at('Head office DoH', 12, office.server)] },
    ]

    const series = resolverSeries('t', renamed, MINUTE, [{ ...office, name: 'Head office' }])
    expect(series.map(each => each.label)).toEqual(['Head office DoH'])
    expect(series[0].buckets.map(bucket => bucket.p50Latency)).toEqual([10, 11, 12])
  })

  it('has nothing to show for nothing', () => {
    expect(resolverSeries('t', [], MINUTE)).toEqual([])
  })
})

describe('resolversThatDiffer', () => {
  const answering = (label: string, answers?: string[]) => reading(label, answers ? 10 : null, { answers })

  it('finds none where they all say the same, in whatever order', () => {
    expect(
      resolversThatDiffer([
        answering('a', ['192.0.2.1', '192.0.2.2']),
        answering('b', ['192.0.2.2', '192.0.2.1']),
        answering('c', ['192.0.2.1', '192.0.2.2']),
      ]).size
    ).toBe(0)
  })

  it('picks out the one that says something else', () => {
    const differing = resolversThatDiffer([
      answering('a', ['192.0.2.1']),
      answering('b', ['198.51.100.7']),
      answering('c', ['192.0.2.1']),
    ])
    expect([...differing]).toEqual(['b'])
  })

  it('compares names without their case or closing dot', () => {
    expect(resolversThatDiffer([answering('a', ['MX.Example.com.']), answering('b', ['mx.example.com'])]).size).toBe(0)
  })

  it('does not count a resolver that gave no answer, which is marked in its own way', () => {
    expect(resolversThatDiffer([answering('a', ['192.0.2.1']), answering('b'), answering('c', [])]).size).toBe(0)
  })

  it('takes the first answer as the usual one when they are evenly split', () => {
    expect([...resolversThatDiffer([answering('a', ['192.0.2.1']), answering('b', ['198.51.100.7'])])]).toEqual(['b'])
  })
})
