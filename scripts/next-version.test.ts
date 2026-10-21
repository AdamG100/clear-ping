import { describe, expect, it } from 'vitest'
// The script CI numbers each build of main with.
import { nextVersion } from './next-version.mjs'

const asks = (...releases: string[]) => releases.map((release, i) => ({ commit: `c${i}`, release }))

describe('nextVersion', () => {
  it('is package.json\'s version before the first release', () => {
    expect(nextVersion('0.1.0', [], []).version).toBe('0.1.0')
    expect(nextVersion('0.1.0', ['not-a-release'], asks('minor')).version).toBe('0.1.0')
  })

  it('counts a patch when no commit asks for more', () => {
    expect(nextVersion('0.1.0', ['v0.1.0', 'v0.1.1'], [])).toEqual({ version: '0.1.2', last: 'v0.1.1', bump: 'patch' })
    expect(nextVersion('0.1.0', ['v0.1.0'], asks('patch')).version).toBe('0.1.1')
  })

  it('counts on from the highest release, not the newest tag listed', () => {
    expect(nextVersion('0.1.0', ['v0.1.10', 'v0.1.9', 'v0.2.0-rc.1'], []).version).toBe('0.1.11')
  })

  it('takes the biggest bump the commits ask for', () => {
    expect(nextVersion('0.1.0', ['v0.1.4'], asks('minor', 'patch')).version).toBe('0.2.0')
    expect(nextVersion('0.1.0', ['v0.1.4'], asks('Minor', 'MAJOR', 'minor')).version).toBe('1.0.0')
  })

  it('treats package.json as a floor', () => {
    expect(nextVersion('1.0.0', ['v0.4.2'], []).version).toBe('1.0.0')
    expect(nextVersion('0.3.0', ['v0.4.2'], asks('minor')).version).toBe('0.5.0')
  })

  it('stops on a trailer it does not know, naming the commit', () => {
    expect(() => nextVersion('0.1.0', ['v0.1.0'], [{ commit: 'abc1234', release: 'feature' }])).toThrow(/abc1234/)
  })
})
