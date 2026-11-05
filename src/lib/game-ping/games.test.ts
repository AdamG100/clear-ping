import { describe, expect, it } from 'vitest'
import { isValidHost } from '../probes/host'
import { validateProbeConfig } from '../probes/config'
import { CONTINENTS, probeFor } from './catalogue'
import { findGame, GAMES, gameSummaries } from './games'

describe('the list of games', () => {
  it('names each game once', () => {
    const ids = GAMES.map(game => game.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('says where every game came from', () => {
    for (const game of GAMES) {
      expect(game.sources.length, game.id).toBeGreaterThan(0)
      for (const source of game.sources) expect(new URL(source).protocol, `${game.id}: ${source}`).toBe('https:')
    }
  })

  it('lists regions only for games whose regions are not read from Valve', () => {
    for (const game of GAMES) {
      if (game.valveAppId !== undefined) expect(game.regions, game.id).toEqual([])
      else expect(game.regions.length, game.id).toBeGreaterThan(0)
    }
  })

  it('gives every region an id of its own, a real address and a place', () => {
    for (const game of GAMES) {
      const ids = game.regions.map(region => region.id)
      expect(new Set(ids).size, game.id).toBe(ids.length)
      for (const region of game.regions) {
        expect(isValidHost(region.host), `${game.id}/${region.id}: ${region.host}`).toBe(true)
        expect(CONTINENTS, `${game.id}/${region.id}`).toContain(region.continent)
        // Within what a probe agent takes as a target id (protocol.ts), as the test sends it.
        expect(`game-ping:${game.id}:${region.id}`.length).toBeLessThanOrEqual(100)
      }
    }
  })

  it('asks every region in a way a monitor of it could be saved with', () => {
    for (const game of GAMES) {
      for (const region of game.regions) {
        const { probeType, probeConfig } = probeFor(region.method)
        expect(validateProbeConfig(probeType, region.host, probeConfig), `${game.id}/${region.id}`).toEqual({ ok: true, config: probeConfig })
      }
    }
  })

  it('names a Local Zone beacon for its city and parent Region, as Amazon does', () => {
    const lagos = findGame('amazon-gamelift')?.regions.find(region => region.id === 'af-south-1-los')
    expect(lagos).toMatchObject({ host: 'gamelift-ping-los.af-south-1.api.aws', method: { kind: 'udp-echo', port: 7770 } })
  })

  it('lists games without their regions, saying which are read live', () => {
    const cs2 = gameSummaries().find(game => game.id === 'cs2')
    expect(cs2).toMatchObject({ id: 'cs2', live: true })
    expect(cs2 && 'regions' in cs2).toBe(false)
    expect(gameSummaries().find(game => game.id === 'fortnite')?.live).toBe(false)
  })
})
