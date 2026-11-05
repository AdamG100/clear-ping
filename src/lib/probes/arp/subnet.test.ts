import type { NetworkInterfaceInfo } from 'os'
import { describe, expect, it } from 'vitest'
import { localLinkFor, NOT_LOCAL } from './subnet'

function v4(address: string, netmask: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null }
}

const machine: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [v4('127.0.0.1', '255.0.0.0', true)],
  eth0: [
    v4('192.168.1.10', '255.255.255.0'),
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 2 },
  ],
  wlan0: [v4('10.20.0.5', '255.255.0.0')],
  // A VPN address: a network of one.
  tailscale0: [v4('100.64.0.7', '255.255.255.255')],
}

describe('localLinkFor', () => {
  it('finds the interface whose network holds the address', () => {
    expect(localLinkFor('192.168.1.1', machine)).toEqual({ ok: true, device: 'eth0', source: '192.168.1.10' })
    expect(localLinkFor('10.20.250.9', machine)).toEqual({ ok: true, device: 'wlan0', source: '10.20.0.5' })
  })

  it('picks the most specific network when two hold it', () => {
    const overlapping = { ...machine, br0: [v4('10.20.3.1', '255.255.255.0')] }
    expect(localLinkFor('10.20.3.40', overlapping)).toMatchObject({ ok: true, device: 'br0' })
  })

  it('says an address on no network of this machine is not local, rather than reading it as loss', () => {
    expect(localLinkFor('1.1.1.1', machine)).toEqual({ ok: false, error: NOT_LOCAL })
    expect(localLinkFor('192.168.2.1', machine)).toEqual({ ok: false, error: NOT_LOCAL })
  })

  it('leaves out loopback, and a network of one', () => {
    expect(localLinkFor('127.0.0.53', machine).ok).toBe(false)
    expect(localLinkFor('100.64.0.8', machine).ok).toBe(false)
  })

  it('says so when it is this machine\'s own address', () => {
    expect(localLinkFor('192.168.1.10', machine)).toMatchObject({ ok: false, error: expect.stringMatching(/own address/) })
  })

  it('works with networks whose mask has the top bit set', () => {
    const wide = { eth1: [v4('172.16.4.2', '255.240.0.0')] }
    expect(localLinkFor('172.31.255.254', wide)).toMatchObject({ ok: true, device: 'eth1' })
    expect(localLinkFor('172.32.0.1', wide).ok).toBe(false)
  })

  it('refuses anything that is not an IPv4 address', () => {
    expect(localLinkFor('fe80::2', machine).ok).toBe(false)
    expect(localLinkFor('192.168.1.256', machine).ok).toBe(false)
  })
})
