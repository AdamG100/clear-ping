import { describe, expect, it } from 'vitest'
import { arpingArgs, arpingFailure, parseArpingOutput } from './parse'
import * as fixture from '../../__fixtures__/arping-output'

describe('parseArpingOutput', () => {
  it('reads the reply time and the hardware address that answered', () => {
    expect(parseArpingOutput(fixture.REPLY, '192.168.215.1')).toEqual({ received: true, latency: 0.533, mac: '8A:5D:1B:34:5A:26' })
  })

  it('reads no reply as a lost request, not a failure', () => {
    expect(parseArpingOutput(fixture.NO_REPLY, '192.168.215.250', 'No ARP reply')).toEqual({ received: false, latency: null, error: 'No ARP reply' })
  })

  it('takes the first reply of a run that sent several', () => {
    expect(parseArpingOutput(fixture.THREE_REPLIES, '192.168.215.1').latency).toBe(0.506)
  })

  it('counts a reply only from the address it asked about', () => {
    expect(parseArpingOutput(fixture.REPLY, '192.168.215.9').received).toBe(false)
  })

  it('reads nothing from empty output', () => {
    expect(parseArpingOutput('', '192.168.215.1').received).toBe(false)
  })
})

describe('arpingArgs', () => {
  it('asks once, on the interface given, waiting whole seconds', () => {
    expect(arpingArgs('192.168.1.20', 'eth0', 1000)).toEqual(['-c', '1', '-w', '1', '-I', 'eth0', '192.168.1.20'])
    expect(arpingArgs('192.168.1.20', 'eth0', 1500)).toEqual(['-c', '1', '-w', '2', '-I', 'eth0', '192.168.1.20'])
  })

  it('never waits less than a second', () => {
    expect(arpingArgs('192.168.1.20', 'eth0', 200)[3]).toBe('1')
  })
})

describe('arpingFailure', () => {
  it('is nothing when it ran: answered, or not answered', () => {
    expect(arpingFailure(0, '')).toBeNull()
    expect(arpingFailure(1, '')).toBeNull()
    // Stopped by the timeout: a lost request.
    expect(arpingFailure(undefined, '')).toBeNull()
  })

  it('says how to install it when it is missing', () => {
    expect(arpingFailure('ENOENT', '')).toMatch(/Install iputils-arping/)
  })

  it('says it needs CAP_NET_RAW when it may not send', () => {
    expect(arpingFailure('EPERM', '')).toMatch(/CAP_NET_RAW/)
    expect(arpingFailure(2, 'arping: socket: Operation not permitted\n')).toMatch(/CAP_NET_RAW/)
  })

  it('passes on what arping said for anything else', () => {
    expect(arpingFailure(2, fixture.NO_DEVICE)).toBe('Device nope0 not available.')
    expect(arpingFailure(2, '')).toBe('arping failed (2)')
  })
})
