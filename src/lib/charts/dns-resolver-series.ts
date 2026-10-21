import type { BucketedMeasurement, DnsResolver, DnsResolverReading, TargetStatistics } from '@/types/probe'
import { resolverLabel, resolverOfReading } from '../probes/dns/resolvers'
import { mean, median, percentile } from '../probes/metrics'
import { lossBandIndex, PACKET_LOSS_BANDS } from './packet-loss-colors'

/**
 * A DNS target that asks several resolvers, taken apart into a line for each.
 *
 * Such a target is stored as one reading a round, all of its resolvers'
 * queries together, with how each resolver did kept beside it. That one
 * reading is what its own chart and its alerts are drawn from. These are the
 * resolvers set side by side again, in the shape every comparison chart takes.
 *
 * Pure: the rounds are handed in, whatever they were read from.
 */

/** One probe's readings, one for each resolver that was asked. */
export interface ResolverRound {
  timestamp: number
  readings: DnsResolverReading[]
}

export interface ResolverSeries {
  label: string
  buckets: BucketedMeasurement[]
  statistics: TargetStatistics
}

/**
 * One series for each resolver seen in `rounds`. `resolvers` is the list the
 * target asks now: theirs come first, in that order and under the names they
 * have now, followed by any that were asked earlier in the period and have
 * since been taken off the list, under the names they had.
 *
 * A resolver is followed by where it is, not by what it is called, so one
 * that was renamed half way through the period is still one line.
 */
export function resolverSeries(
  targetId: string,
  rounds: ResolverRound[],
  bucketMs: number,
  resolvers: readonly DnsResolver[] = []
): ResolverSeries[] {
  const width = Math.max(1000, Math.floor(bucketMs))
  const lines = new Map<string, { label: string; seen: Array<{ timestamp: number; reading: DnsResolverReading }> }>()
  // In the list's order from the start, so that is the order they come out in.
  resolvers.forEach((resolver, index) => lines.set(`listed:${index}`, { label: resolverLabel(resolver), seen: [] }))

  for (const round of rounds) {
    for (const reading of round.readings) {
      const current = resolverOfReading(reading, resolvers)
      const key = current ? `listed:${resolvers.indexOf(current)}` : `gone:${reading.label}`
      const line = lines.get(key)
      if (line) line.seen.push({ timestamp: round.timestamp, reading })
      else lines.set(key, { label: reading.label, seen: [{ timestamp: round.timestamp, reading }] })
    }
  }

  return [...lines.values()].filter(line => line.seen.length > 0).map(({ label, seen: unsorted }) => {
    const seen = unsorted.sort((a, b) => a.timestamp - b.timestamp)

    const inBucket = new Map<number, DnsResolverReading[]>()
    for (const { timestamp, reading } of seen) {
      const start = Math.floor(timestamp / width) * width
      const bucket = inBucket.get(start)
      if (bucket) bucket.push(reading)
      else inBucket.set(start, [reading])
    }

    const buckets: BucketedMeasurement[] = [...inBucket.entries()].map(([start, readings]) => {
      const answered = readings.map(reading => reading.latency).filter((latency): latency is number => latency !== null)
      const losses = readings.map(reading => reading.loss)
      const middle = median(answered)

      return {
        // Centre of the bucket, as every other chart places its readings.
        timestamp: new Date(start + width / 2),
        sampleCount: readings.length,
        latency: mean(answered),
        minLatency: answered.length > 0 ? Math.min(...answered) : null,
        maxLatency: answered.length > 0 ? Math.max(...answered) : null,
        // Only each round's mean is kept for a resolver, so there is no
        // spread within a round to draw: the middle of the rounds is all
        // there is, and it is what a comparison chart draws.
        p10Latency: null,
        p25Latency: null,
        p50Latency: middle,
        p75Latency: null,
        p90Latency: null,
        packetLoss: mean(losses) ?? 0,
        maxPacketLoss: Math.max(...losses),
        jitter: null,
        isOnline: answered.length > 0,
      }
    })

    const latencies = seen.map(each => each.reading.latency).filter((latency): latency is number => latency !== null)
    const losses = seen.map(each => each.reading.loss)
    const lossBands = PACKET_LOSS_BANDS.map(() => 0)
    for (const { reading } of seen) lossBands[lossBandIndex(reading.latency === null ? 100 : reading.loss)]++

    return {
      label,
      buckets,
      statistics: {
        targetId,
        sampleCount: seen.length,
        avgLatency: mean(latencies),
        minLatency: latencies.length > 0 ? Math.min(...latencies) : null,
        maxLatency: latencies.length > 0 ? Math.max(...latencies) : null,
        medianLatency: median(latencies),
        latencyP10: percentile(latencies, 10),
        latencyP90: percentile(latencies, 90),
        packetLoss: mean(losses) ?? 0,
        minPacketLoss: Math.min(...losses),
        maxPacketLoss: Math.max(...losses),
        uptime: (latencies.length / seen.length) * 100,
        lossyProbes: seen.filter(({ reading }) => reading.latency !== null && reading.loss > 0).length,
        failedProbes: seen.length - latencies.length,
        lossBands,
        lastProbe: new Date(seen[seen.length - 1].timestamp),
        jitter: null,
        minJitter: null,
        maxJitter: null,
        medianJitter: null,
        jitterP10: null,
        jitterP90: null,
      },
    }
  })
}

/**
 * Which resolvers answered something other than what most of them did.
 *
 * Answers are compared as sets: the same addresses in another order is the
 * same answer, which is how a name with several records usually comes back.
 * A resolver that gave no answer is not counted as disagreeing, since it has
 * its own way of being marked. Empty when they all agree, or only one answered.
 *
 * Differing is not failing. A name served by a network that answers by region
 * is given different addresses by different resolvers every day; what this is
 * for is the record that has changed at one resolver and not yet at another.
 */
export function resolversThatDiffer(readings: DnsResolverReading[]): Set<string> {
  const answerOf = (reading: DnsResolverReading) =>
    [...(reading.answers ?? [])].map(answer => answer.toLowerCase().replace(/\.$/, '')).sort().join('\n')

  const answered = readings.filter(reading => reading.answers && reading.answers.length > 0)
  const counts = new Map<string, number>()
  for (const reading of answered) counts.set(answerOf(reading), (counts.get(answerOf(reading)) ?? 0) + 1)
  if (counts.size < 2) return new Set()

  // The answer most of them gave; the first of them to give it, when it is a tie.
  let usual = ''
  let most = 0
  for (const reading of answered) {
    const count = counts.get(answerOf(reading)) ?? 0
    if (count > most) {
      most = count
      usual = answerOf(reading)
    }
  }

  return new Set(answered.filter(reading => answerOf(reading) !== usual).map(reading => reading.label))
}
