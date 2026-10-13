import { describe, expect, it } from 'vitest'
import { decodeReply, encodeQuery, frameMessage, rcodeName, unframeMessage } from './dns-wire'
import { wireName as name, wirePointer as pointer, wireRecord, wireReply as reply } from './__fixtures__/dns-messages'

describe('encodeQuery', () => {
  it('writes one question, asking for recursion', () => {
    const query = encodeQuery('example.com', 'AAAA', 0xbeef)

    expect(query.readUInt16BE(0)).toBe(0xbeef)
    expect(query.readUInt16BE(2)).toBe(0x0100)
    expect(query.readUInt16BE(4)).toBe(1)
    expect(query.subarray(12, 25)).toEqual(name('example.com'))
    expect(query.readUInt16BE(25)).toBe(28)
    expect(query.readUInt16BE(27)).toBe(1)
    expect(query.length).toBe(29)
  })

  it('takes a name with its closing dot or without', () => {
    expect(encodeQuery('example.com.', 'A')).toEqual(encodeQuery('example.com', 'A'))
  })

  it('refuses a name that could not be asked for', () => {
    expect(() => encodeQuery('a..b', 'A')).toThrow()
    expect(() => encodeQuery(`${'x'.repeat(64)}.com`, 'A')).toThrow()
  })
})

describe('decodeReply', () => {
  it('reads addresses of both families', () => {
    const a = reply('example.com', 'A', [wireRecord('A', Buffer.from([192, 0, 2, 1])), wireRecord('A', Buffer.from([192, 0, 2, 2]))])
    expect(decodeReply(a, 'A')).toEqual({ id: 0x1234, rcode: 0, truncated: false, answers: ['192.0.2.1', '192.0.2.2'] })

    const address = Buffer.from('20010db8000000000000000000000001', 'hex')
    expect(decodeReply(reply('example.com', 'AAAA', [wireRecord('AAAA', address)]), 'AAAA').answers).toEqual(['2001:db8::1'])
  })

  it('writes an IPv6 address the usual way', () => {
    const answer = (hex: string) => decodeReply(reply('example.com', 'AAAA', [wireRecord('AAAA', Buffer.from(hex, 'hex'))]), 'AAAA').answers[0]

    expect(answer('26064700470000000000000000001111')).toBe('2606:4700:4700::1111')
    expect(answer('00000000000000000000000000000001')).toBe('::1')
    expect(answer('20010db8000000010000000000000000')).toBe('2001:db8:0:1::')
    // A lone zero group is written out; only a run of them is folded.
    expect(answer('20010db8000000010002000300040005')).toBe('2001:db8:0:1:2:3:4:5')
  })

  it('leaves out the aliases followed on the way to an address', () => {
    const alias = wireRecord('CNAME', Buffer.concat([Buffer.from([3]), Buffer.from('cdn'), pointer(12)]))
    const message = reply('www.example.com', 'A', [alias, wireRecord('A', Buffer.from([203, 0, 113, 9]))])

    expect(decodeReply(message, 'A').answers).toEqual(['203.0.113.9'])
    expect(decodeReply(message, 'CNAME').answers).toEqual(['cdn.www.example.com'])
  })

  it('reads the names in mail and nameserver records, through their pointers', () => {
    const mx = Buffer.concat([Buffer.from([0, 10, 2]), Buffer.from('mx'), pointer(12)])
    expect(decodeReply(reply('example.com', 'MX', [wireRecord('MX', mx)]), 'MX').answers).toEqual(['mx.example.com'])

    const ns = Buffer.concat([Buffer.from([3]), Buffer.from('ns1'), pointer(12)])
    expect(decodeReply(reply('example.com', 'NS', [wireRecord('NS', ns)]), 'NS').answers).toEqual(['ns1.example.com'])
  })

  it('joins the pieces of a text record', () => {
    const txt = Buffer.concat([Buffer.from([7]), Buffer.from('v=spf1 '), Buffer.from([4]), Buffer.from('-all')])
    expect(decodeReply(reply('example.com', 'TXT', [wireRecord('TXT', txt)]), 'TXT').answers).toEqual(['v=spf1 -all'])
  })

  it('reports what the resolver said when it did not answer', () => {
    const missing = decodeReply(reply('nowhere.example', 'A', [], { rcode: 3 }), 'A')
    expect(missing.rcode).toBe(3)
    expect(missing.answers).toEqual([])
    expect(rcodeName(missing.rcode)).toBe('NXDOMAIN')
    expect(rcodeName(2)).toBe('SERVFAIL')
    expect(rcodeName(11)).toBe('RCODE 11')

    expect(decodeReply(reply('example.com', 'A', [], { truncated: true }), 'A').truncated).toBe(true)
  })

  it('refuses a reply that is cut short or makes no sense, without running off the end of it', () => {
    const whole = reply('example.com', 'A', [wireRecord('A', Buffer.from([192, 0, 2, 1]))])

    expect(() => decodeReply(whole.subarray(0, 8), 'A')).toThrow()
    expect(() => decodeReply(whole.subarray(0, whole.length - 2), 'A')).toThrow()
    expect(() => decodeReply(reply('example.com', 'A', [wireRecord('A', Buffer.from([192, 0, 2]))]), 'A')).toThrow()

    // A name that points at itself would otherwise be followed for ever.
    const loop = Buffer.concat([whole.subarray(0, 12), pointer(12), whole.subarray(14)])
    expect(() => decodeReply(loop, 'A')).toThrow()
  })
})

describe('framing for DNS over TLS', () => {
  it('puts a message’s length in front of it, and takes it off again', () => {
    const message = encodeQuery('example.com', 'A')
    const framed = frameMessage(message)

    expect(framed.readUInt16BE(0)).toBe(message.length)
    expect(unframeMessage(framed)).toEqual({ message, rest: Buffer.alloc(0) })
  })

  it('waits for a message that is still arriving', () => {
    const framed = frameMessage(encodeQuery('example.com', 'A'))

    expect(unframeMessage(framed.subarray(0, 1))).toBeNull()
    expect(unframeMessage(framed.subarray(0, framed.length - 1))).toBeNull()
  })

  it('hands back what follows a whole message', () => {
    const first = encodeQuery('one.example', 'A')
    const second = frameMessage(encodeQuery('two.example', 'A'))

    expect(unframeMessage(Buffer.concat([frameMessage(first), second]))).toEqual({ message: first, rest: second })
  })
})
