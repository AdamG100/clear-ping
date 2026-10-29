import { describe, expect, it } from 'vitest'
import { maskAddress, maskForAssistant, maskText } from './mask'

describe('hiding an address', () => {
  it('keeps only the last part of an IP address', () => {
    expect(maskAddress('203.0.113.10')).toBe('•••.•••.•••.10')
    expect(maskAddress('2001:db8::1f')).toBe('•••:•••::1f')
  })

  it('keeps the first letter and the top-level domain of a name', () => {
    expect(maskAddress('vps1.example.net')).toBe('v•••.•••.net')
    expect(maskAddress('router')).toBe('r•••')
  })

  it('keeps the port, and hides a URL’s host and path', () => {
    expect(maskAddress('203.0.113.10:443')).toBe('•••.•••.•••.10:443')
    expect(maskAddress('[2001:db8::1]:8443')).toBe('[•••:•••::1]:8443')
    expect(maskAddress('https://status.example.com/health')).toBe('https://s•••.•••.com/…')
    expect(maskAddress('https://user:secret@example.com')).toBe('https://e•••.com')
  })
})

describe('hiding addresses in text', () => {
  it('hides IP addresses and leaves times and versions alone', () => {
    expect(maskText('Lost 192.0.2.7 at 18:19:05 on v0.16.0')).toBe('Lost •••.•••.•••.7 at 18:19:05 on v0.16.0')
    expect(maskText('via 2001:db8:0:1::5')).toBe('via •••:•••::5')
  })

  it('hides names only when asked, or the ones it is told', () => {
    expect(maskText('home.example.org is down')).toBe('home.example.org is down')
    expect(maskText('home.example.org is down', { names: true })).toBe('h•••.•••.org is down')
    expect(maskText('Probe home.example.org failed', { known: ['home.example.org'] })).toBe('Probe h•••.•••.org failed')
  })
})

describe('what an assistant is given', () => {
  it('hides address fields whole, and addresses wherever else they appear', () => {
    const answer = maskForAssistant(
      { name: 'Office', host: 'office.example.com', hops: [{ address: '198.51.100.1', hostname: 'gw.isp.example' }], note: 'Answered from 192.0.2.9' },
      ['office.example.com']
    )
    expect(answer).toEqual({
      name: 'Office',
      host: 'o•••.•••.com',
      hops: [{ address: '•••.•••.•••.1', hostname: 'g•••.•••.example' }],
      note: 'Answered from •••.•••.•••.9',
    })
  })
})
