/**
 * Real `ping` output captured from each platform.
 *
 * The formats differ in ways a regex written against one will get wrong on
 * another: Windows prints integer milliseconds with no space ("time=12ms") and
 * uses "<" for sub-millisecond replies, while Linux and macOS print a decimal
 * with a space ("time=12.3 ms"). Windows also reports some failures on a line
 * that begins "Reply from ...", which must not be mistaken for a success.
 */

export const WINDOWS_REPLY = [
  '',
  'Pinging 8.8.8.8 with 32 bytes of data:',
  'Reply from 8.8.8.8: bytes=32 time=12ms TTL=117',
  '',
  'Ping statistics for 8.8.8.8:',
  '    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),',
].join('\r\n')

export const WINDOWS_SUB_MILLISECOND = [
  '',
  'Pinging 192.168.1.1 with 32 bytes of data:',
  'Reply from 192.168.1.1: bytes=32 time<1ms TTL=64',
].join('\r\n')

export const WINDOWS_TIMEOUT = [
  '',
  'Pinging 192.0.2.1 with 32 bytes of data:',
  'Request timed out.',
  '',
  'Ping statistics for 192.0.2.1:',
  '    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),',
].join('\r\n')

/** Exits zero, contains "Reply from", but is a lost packet. */
export const WINDOWS_UNREACHABLE = [
  '',
  'Pinging 10.255.255.1 with 32 bytes of data:',
  'Reply from 10.0.0.1: Destination host unreachable.',
].join('\r\n')

export const WINDOWS_DNS_FAILURE =
  'Ping request could not find host nonexistent.invalid. Please check the name and try again.'

export const LINUX_REPLY = [
  'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.',
  '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=12.3 ms',
  '',
  '--- 8.8.8.8 ping statistics ---',
  '1 packets transmitted, 1 received, 0% packet loss, time 0ms',
].join('\n')

export const LINUX_TIMEOUT = [
  'PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.',
  '',
  '--- 192.0.2.1 ping statistics ---',
  '1 packets transmitted, 0 received, 100% packet loss, time 0ms',
].join('\n')

export const LINUX_UNKNOWN_HOST = 'ping: nonexistent.invalid: Name or service not known'

export const MACOS_REPLY = [
  'PING 8.8.8.8 (8.8.8.8): 56 data bytes',
  '64 bytes from 8.8.8.8: icmp_seq=0 ttl=117 time=12.345 ms',
  '',
  '--- 8.8.8.8 ping statistics ---',
  '1 packets transmitted, 1 packets received, 0.0% packet loss',
].join('\n')

export const MACOS_TIMEOUT = [
  'PING 192.0.2.1 (192.0.2.1): 56 data bytes',
  'Request timeout for icmp_seq 0',
  '',
  '--- 192.0.2.1 ping statistics ---',
  '1 packets transmitted, 0 packets received, 100.0% packet loss',
].join('\n')
