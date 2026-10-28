import { describe, expect, it } from 'vitest'
import { BGP_DIRECT } from '@/types/bgp'
import { flattenPath, hops, isDirect, originOf, upstreamOf } from './path'

describe('AS paths', () => {
  it('reads a path as RIS Live and RIPEstat write it, sets included', () => {
    expect(flattenPath([58057, 20459, [37154, 328665]])).toEqual([58057, 20459, 37154, 328665])
    expect(flattenPath('15692 174 37100 {37179,64501}')).toEqual([15692, 174, 37100, 37179, 64501])
  })

  it('takes prepending out', () => {
    expect(hops([174, 37179, 37179, 37179, 64501, 64501])).toEqual([174, 37179, 64501])
  })

  it('finds the origin and the network before it', () => {
    expect(originOf([3491, 3741, 64501])).toBe(64501)
    expect(upstreamOf([3491, 3741, 64501, 64501])).toBe(3741)
    // A peer of the origin's reaches it directly, through no one.
    expect(upstreamOf([37179, 64501])).toBe(BGP_DIRECT)
    expect(isDirect([37179, 64501, 64501])).toBe(true)
    expect(isDirect([3491, 37179, 64501])).toBe(false)
    // The origin itself.
    expect(upstreamOf([64501])).toBe(BGP_DIRECT)
    expect(upstreamOf([])).toBeNull()
  })
})
