/**
 * Traceroute output for the parser tests.
 *
 * The Windows samples are built on real `tracert -d` captures: the header and
 * the answering hop lines are as printed, with the final hop, the hop limit
 * and the "Request timed out." lines edited in to make each case.
 *
 * The Linux and macOS samples are written out in the format those tools print
 * (`traceroute -n -q 3`), not captured: no such machine was to hand. They
 * cover the shapes the parser has to cope with — a router that never answers,
 * a hop that answers from two addresses, a reply flagged `!X` — but a real
 * capture from each would be a better fixture.
 */

export const WINDOWS_COMPLETE = [
  '',
  'Tracing route to 1.1.1.1 over a maximum of 24 hops',
  '',
  '  1    <1 ms    <1 ms    <1 ms  172.22.2.1 ',
  '  2     1 ms     1 ms     1 ms  100.100.101.68 ',
  '  3     1 ms     1 ms     1 ms  154.0.0.89 ',
  '  4     2 ms     1 ms     1 ms  154.0.0.33 ',
  '  5     3 ms     2 ms     5 ms  154.0.2.115 ',
  '  6     2 ms     2 ms     1 ms  1.1.1.1 ',
  '',
  'Trace complete.',
].join('\r\n')

export const WINDOWS_IPV6 = [
  '',
  'Tracing route to 2606:4700:4700::1111 over a maximum of 24 hops',
  '',
  '  1     4 ms    <1 ms    <1 ms  fe80::ba69:f4ff:feae:febd ',
  '  2     5 ms     5 ms     4 ms  2c0f:f9a8:3000::1:9657 ',
  '  3     2 ms     1 ms     1 ms  2c0f:f9a8::1:27:11:4 ',
  '  4     2 ms     1 ms     1 ms  2606:4700:4700::1111 ',
  '',
  'Trace complete.',
].join('\r\n')

/** The destination never answers: silent hops run on to the hop limit. */
export const WINDOWS_DEAD_END = [
  '',
  'Tracing route to 192.0.2.1 over a maximum of 24 hops',
  '',
  '  1    <1 ms    <1 ms    <1 ms  172.22.2.1 ',
  '  2     2 ms     1 ms     1 ms  100.100.101.68 ',
  '  3     2 ms     *        1 ms  154.0.0.89 ',
  '  4     *        *        *     Request timed out.',
  '  5     *        *        *     Request timed out.',
  '  6     *        *        *     Request timed out.',
  '  7     *        *        *     Request timed out.',
  '',
  'Trace complete.',
].join('\r\n')

/** A router in the middle that forwards traffic but will not answer probes. */
export const WINDOWS_SILENT_MIDDLE = [
  '',
  'Tracing route to 1.1.1.1 over a maximum of 24 hops',
  '',
  '  1    <1 ms    <1 ms    <1 ms  172.22.2.1 ',
  '  2     *        *        *     Request timed out.',
  '  3     1 ms     1 ms     1 ms  1.1.1.1 ',
  '',
  'Trace complete.',
].join('\r\n')

export const WINDOWS_UNRESOLVED = 'Unable to resolve target system name nope.invalid.'

export const LINUX_COMPLETE = [
  'traceroute to 1.1.1.1 (1.1.1.1), 24 hops max, 60 byte packets',
  ' 1  192.168.1.1  0.345 ms  0.301 ms  0.289 ms',
  ' 2  * * *',
  ' 3  10.0.0.1  2.113 ms 10.0.0.2  2.301 ms  2.207 ms',
  ' 4  1.1.1.1  3.512 ms  *  3.401 ms',
].join('\n')

export const LINUX_ADMIN_PROHIBITED = [
  'traceroute to 203.0.113.9 (203.0.113.9), 24 hops max, 60 byte packets',
  ' 1  192.168.1.1  0.412 ms  0.390 ms  0.377 ms',
  ' 2  198.51.100.1  4.120 ms !X  4.090 ms !X  4.011 ms !X',
].join('\n')

export const MACOS_IPV6 = [
  'traceroute6 to 2606:4700:4700::1111 (2606:4700:4700::1111) from 2001:db8::2, 24 hops max, 12 byte packets',
  ' 1  2001:db8::1  1.204 ms  0.981 ms  0.933 ms',
  ' 2  2606:4700:4700::1111  3.870 ms  3.512 ms  3.498 ms',
].join('\n')
