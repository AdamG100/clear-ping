import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetDay, readDay } from './day-readings'

vi.mock('../db/database', () => ({ getProbeReadings: vi.fn() }))

const MINUTE = 60_000
const START = Date.UTC(2026, 9, 27, 0, 0)
const reading = (timestamp: number) => ({ timestamp, latency: 5, packetLoss: 0, success: true })
const LINE = { key: 'a', monitor: 'monitor-a', probe: 'local' }

/** A database holding these readings, which says what it was asked for. */
function database(rows: () => number[]) {
  return vi.fn(async (_monitor: string, from: Date, to: Date) =>
    rows()
      .filter(at => at >= from.getTime() && at <= to.getTime())
      .map(reading)
  )
}

const times = (readings: { timestamp: number }[] | undefined) => (readings ?? []).map(each => each.timestamp)

afterEach(() => forgetDay())

describe('readDay', () => {
  it('reads the whole period the first time', async () => {
    const read = database(() => [START, START + MINUTE])
    const day = await readDay([LINE], START, START + 2 * MINUTE, read)
    expect(times(day.get('a'))).toEqual([START, START + MINUTE])
    expect(read.mock.calls[0][1]).toEqual(new Date(START))
  })

  it('then reads only what is new, keeping what it has', async () => {
    const stored = Array.from({ length: 60 }, (_, minute) => START + minute * MINUTE)
    const read = database(() => stored)
    await readDay([LINE], START, START + 59 * MINUTE, read)

    stored.push(START + 60 * MINUTE)
    const day = await readDay([LINE], START, START + 61 * MINUTE, read)

    expect(times(day.get('a'))).toEqual(stored)
    expect(read.mock.calls[1][1].getTime()).toBeGreaterThan(START + 50 * MINUTE)
  })

  it('finds a reading stored late, stamped behind one it already has', async () => {
    const stored = [START, START + 2 * MINUTE]
    const read = database(() => stored)
    await readDay([LINE], START, START + 3 * MINUTE, read)

    stored.splice(1, 0, START + MINUTE)
    const day = await readDay([LINE], START, START + 4 * MINUTE, read)

    expect(times(day.get('a'))).toEqual([START, START + MINUTE, START + 2 * MINUTE])
  })

  it('lets what has passed out of the period go', async () => {
    const read = database(() => [START, START + 10 * MINUTE])
    await readDay([LINE], START, START + 10 * MINUTE, read)
    const day = await readDay([LINE], START + MINUTE, START + 11 * MINUTE, read)
    expect(times(day.get('a'))).toEqual([START + 10 * MINUTE])
  })

  it('reads the whole day again now and then, for what changed further back', async () => {
    const stored = [START + 10 * MINUTE]
    const read = database(() => stored)
    await readDay([LINE], START, START + 11 * MINUTE, read)

    stored.unshift(START + MINUTE)
    expect(times((await readDay([LINE], START, START + 12 * MINUTE, read)).get('a'))).toEqual([START + 10 * MINUTE])
    expect(times((await readDay([LINE], START, START + 27 * MINUTE, read)).get('a'))).toEqual(stored)
  })

  it('forgets a monitor that is no longer asked about, and reads a new one whole', async () => {
    const read = database(() => [START])
    await readDay([LINE], START, START + MINUTE, read)
    const day = await readDay([{ key: 'b', monitor: 'monitor-b', probe: 'local' }], START, START + 2 * MINUTE, read)

    expect([...day.keys()]).toEqual(['b'])
    expect(read.mock.calls[1][1]).toEqual(new Date(START))
  })

  it('reads the whole period when asked for more than it holds', async () => {
    const read = database(() => [START])
    await readDay([LINE], START, START + MINUTE, read)
    await readDay([LINE], START - 60 * MINUTE, START + 2 * MINUTE, read)
    expect(read.mock.calls[1][1]).toEqual(new Date(START - 60 * MINUTE))
  })

  it('reads one at a time when asked twice together', async () => {
    const read = database(() => [START])
    let running = 0
    let most = 0
    const counting: typeof read = vi.fn(async (...args: Parameters<typeof read>) => {
      most = Math.max(most, ++running)
      await new Promise(resolve => setTimeout(resolve, 1))
      running--
      return read(...args)
    })

    await Promise.all([readDay([LINE], START, START + MINUTE, counting), readDay([LINE], START, START + MINUTE, counting)])
    expect(most).toBe(1)
  })

  it('still answers the next time after a read fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('busy')
    })
    await expect(readDay([LINE], START, START + MINUTE, failing)).rejects.toThrow('busy')
    const day = await readDay([LINE], START, START + MINUTE, database(() => [START]))
    expect(times(day.get('a'))).toEqual([START])
  })
})
