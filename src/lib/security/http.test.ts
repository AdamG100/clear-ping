import { afterEach, describe, expect, it, vi } from 'vitest'
import { addressKeys, clientAddress } from './http'

const from = (headers: Record<string, string>) => new Request('http://clearping.test/', { headers })

afterEach(() => vi.unstubAllEnvs())

describe('clientAddress', () => {
  it('ignores forwarding headers unless a proxy is trusted', () => {
    vi.stubEnv('CLEARPING_TRUST_PROXY', '')
    expect(clientAddress(from({ 'x-forwarded-for': '1.2.3.4' }))).toBe('unknown')
  })

  it('believes the entry the trusted proxy added, not what the client wrote before it', () => {
    vi.stubEnv('CLEARPING_TRUST_PROXY', 'true')
    expect(clientAddress(from({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('counts as many entries from the end as there are proxies', () => {
    vi.stubEnv('CLEARPING_TRUST_PROXY', '2')
    expect(clientAddress(from({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }))).toBe('203.0.113.9')
  })
})

describe('addressKeys', () => {
  it('counts against no address when there is none to trust, so one is not everyone', () => {
    expect(addressKeys('unknown')).toEqual([])
    expect(addressKeys('203.0.113.9')).toEqual(['address:203.0.113.9'])
  })
})
