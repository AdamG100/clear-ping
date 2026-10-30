import { describe, expect, it } from 'vitest'
import { corsHeaders, corsOrigin, corsPath, parseCorsOrigins } from './cors'

describe('parseCorsOrigins', () => {
  it('turns addresses into origins, once each', () => {
    expect(parseCorsOrigins(['https://Home.Example.com/', ' http://192.168.1.20:8080 ', 'https://home.example.com'])).toEqual({
      origins: ['https://home.example.com', 'http://192.168.1.20:8080'],
    })
    expect(parseCorsOrigins([])).toEqual({ origins: [] })
    expect(parseCorsOrigins(['', '  '])).toEqual({ origins: [] })
  })

  it('refuses a wildcard, which would open it to every website', () => {
    expect(parseCorsOrigins(['*'])).toHaveProperty('error')
    expect(parseCorsOrigins(['https://*.example.com'])).toHaveProperty('error')
  })

  it.each(['home.example.com', 'ftp://example.com', 'https://example.com/app', 'https://example.com?x=1', 'https://user:pw@example.com'])(
    'refuses %s',
    entry => {
      expect(parseCorsOrigins([entry])).toHaveProperty('error')
    }
  )

  it('refuses what is not a list of text', () => {
    expect(parseCorsOrigins('https://example.com')).toHaveProperty('error')
    expect(parseCorsOrigins([1])).toHaveProperty('error')
  })

  it('stops at twenty', () => {
    const many = Array.from({ length: 21 }, (_, index) => `https://site${index}.example.com`)
    expect(parseCorsOrigins(many)).toHaveProperty('error')
  })
})

describe('corsOrigin', () => {
  const allowed = ['https://home.example.com']

  it('answers a listed website', () => {
    expect(corsOrigin('https://home.example.com', 'ping.example', allowed)).toBe('https://home.example.com')
  })

  it('does not answer one that is not listed, or no origin at all', () => {
    expect(corsOrigin('https://evil.example', 'ping.example', allowed)).toBeNull()
    expect(corsOrigin(null, 'ping.example', allowed)).toBeNull()
  })

  it("has nothing to add for ClearPing's own pages", () => {
    expect(corsOrigin('https://ping.example', 'ping.example', ['https://ping.example'])).toBeNull()
  })
})

describe('corsPath', () => {
  it('covers the API but not sign-in or the health check', () => {
    expect(corsPath('/api/targets')).toBe(true)
    expect(corsPath('/api/mcp')).toBe(true)
    expect(corsPath('/api/auth/login')).toBe(false)
    expect(corsPath('/api/health')).toBe(false)
    expect(corsPath('/settings')).toBe(false)
  })
})

describe('corsHeaders', () => {
  it('names the origin, and never allows credentials', () => {
    const headers = corsHeaders('https://home.example.com')
    expect(headers['Access-Control-Allow-Origin']).toBe('https://home.example.com')
    expect(headers.Vary).toBe('Origin')
    expect(headers).not.toHaveProperty('Access-Control-Allow-Credentials')
  })

  it('adds what a preflight asks for, and the private-network answer only when asked', () => {
    expect(corsHeaders('https://home.example.com', { privateNetwork: false })).toMatchObject({
      'Access-Control-Allow-Methods': expect.stringContaining('DELETE'),
      'Access-Control-Allow-Headers': expect.stringContaining('Authorization'),
    })
    expect(corsHeaders('https://home.example.com', { privateNetwork: false })).not.toHaveProperty('Access-Control-Allow-Private-Network')
    expect(corsHeaders('https://home.example.com', { privateNetwork: true })['Access-Control-Allow-Private-Network']).toBe('true')
  })
})
