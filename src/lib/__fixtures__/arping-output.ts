/**
 * What iputils `arping` prints, captured from `arping from iputils 20240905`
 * on Debian 13 (trixie), the version the Docker images install.
 */

/** `arping -c 1 -w 1 -I eth0 192.168.215.1`: answered. Exit 0. */
export const REPLY = `ARPING 192.168.215.1 from 192.168.215.2 eth0
Unicast reply from 192.168.215.1 [8A:5D:1B:34:5A:26]  0.533ms
Sent 1 probes (1 broadcast(s))
Received 1 response(s)
`

/** `arping -c 1 -w 1 192.168.215.250`: nothing there. Exit 1 after the second. */
export const NO_REPLY = `ARPING 192.168.215.250 from 192.168.215.2 eth0
Sent 1 probes (1 broadcast(s))
Received 0 response(s)
`

/** `arping -c 3 192.168.215.1`: one run sending three, the first broadcast and the rest unicast. */
export const THREE_REPLIES = `ARPING 192.168.215.1 from 192.168.215.2 eth0
Unicast reply from 192.168.215.1 [8A:5D:1B:34:5A:26]  0.506ms
Unicast reply from 192.168.215.1 [8A:5D:1B:34:5A:26]  0.563ms
Unicast reply from 192.168.215.1 [8A:5D:1B:34:5A:26]  0.589ms
Sent 3 probes (1 broadcast(s))
Received 3 response(s)
`

/** `arping -c 1 -w 1 -I nope0 192.168.215.1`, on stderr. Exit 2. */
export const NO_DEVICE = `arping: Device nope0 not available.
`
