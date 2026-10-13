import { describe, expect, it } from 'vitest'
import { answersInclude } from './dns'
import { flattenAnswers } from './dns-transport'

describe('flattenAnswers', () => {
  it('passes address and name records through', () => {
    expect(flattenAnswers(['192.0.2.1', '192.0.2.2'])).toEqual(['192.0.2.1', '192.0.2.2'])
  })

  it('joins the chunks of a TXT record back into one string', () => {
    expect(flattenAnswers([['v=spf1 include:', '_spf.example.com ~all'], ['token']])).toEqual([
      'v=spf1 include:_spf.example.com ~all',
      'token',
    ])
  })

  it('reduces an MX record to the mail server it names', () => {
    expect(flattenAnswers([{ exchange: 'mx.example.com', priority: 10 }])).toEqual(['mx.example.com'])
  })

  it('treats anything that is not a list as no answers', () => {
    expect(flattenAnswers(undefined)).toEqual([])
    expect(flattenAnswers({ exchange: 'mx.example.com' })).toEqual([])
  })
})

describe('answersInclude', () => {
  it('matches an address exactly, not as a prefix', () => {
    expect(answersInclude(['192.0.2.10', '192.0.2.2'], '192.0.2.2', 'A')).toBe(true)
    expect(answersInclude(['192.0.2.10'], '192.0.2.1', 'A')).toBe(false)
  })

  it('ignores case and a trailing dot when comparing names', () => {
    expect(answersInclude(['MX.Example.com.'], 'mx.example.com', 'MX')).toBe(true)
    expect(answersInclude(['target.example.net'], 'TARGET.example.net.', 'CNAME')).toBe(true)
  })

  it('finds a token inside a longer TXT record', () => {
    const records = ['google-site-verification=abc', 'v=spf1 include:_spf.example.com ~all']
    expect(answersInclude(records, 'v=spf1', 'TXT')).toBe(true)
    expect(answersInclude(records, 'v=spf2', 'TXT')).toBe(false)
  })

  it('never matches an empty answer', () => {
    expect(answersInclude([], '192.0.2.1', 'A')).toBe(false)
  })
})
