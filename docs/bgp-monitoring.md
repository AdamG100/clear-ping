# BGP monitoring

Routing, in the sidebar under Overview, watches prefixes in BGP: how the world
reaches them, as RIPE RIS's route collectors see it, and how your own network
reaches them. It is for anyone who needs to know when a route moves, such as a
prefix taken off the exchanges onto transit during a DDoS mitigation.

It is off until an admin turns it on in **Settings › Routing**. While it is off,
Routing is greyed out in the sidebar (an admin's tile opens that setting), and
ClearPing asks nothing of RIPE, PeeringDB or the exchanges' looking glasses.

## Where the data comes from

- **RIPE RIS:** how other networks reach the prefix. RIPE NCC's Routing
  Information Service has route collectors at internet exchanges around the
  world, each taking a BGP feed from many networks (their "peers"). ClearPing
  reads every peer's route from RIPEstat (stat.ripe.net) and follows each
  change live from RIS Live (ris-live.ripe.net).
- **The South African exchanges' own route collectors:** RIS has no collector
  at JINX, CINX, DINX or NMBINX, but INX-ZA runs one at each, with a public
  looking glass (lg.inx.net.za). ClearPing asks it every five minutes, which is
  as often as it reads its collectors, what each exchange's members offer for
  the prefix, and whether the origin offers it there itself.
- **Your networks' routes:** many ISPs share their routes with RIS too. The
  routes of your networks (this server's, and each probe agent's) are picked
  out from the rest.
- **Your traffic:** traceroutes into the prefix from this server and from each
  probe agent. Each hop's address is checked against the exchanges' peering
  LANs from PeeringDB (peeringdb.com), which names the exchange the traffic
  crosses.

Nothing is asked of your routers, and nothing needs setting up on them.

## What it does

**Watch a prefix**, on the Routing page, takes a prefix (a /8 or longer, or for
IPv6 a /16 or longer: nothing wider is announced), or the IP address of a
server (the announced prefix that holds it is watched, and the most specific
route to that address followed). As it is typed, the dialog says which
announced prefix that is and who announces it, with the announced prefixes it
is part of and those inside it: an address in a provider's space belongs to
one of its announcements, and which one is not always plain. ClearPing then:

- reads every collector peer's current route to it, and takes how it is
  carried then as **normal**: the networks announcing it, the upstreams it is
  reached through, the peers that reach it directly, the peers that see it,
  the prefixes announced within it, and the exchanges whose route collectors
  have it from the origin itself;
- follows every change as it happens;
- reads the routes afresh whenever the connection to RIS Live comes back, and
  every half hour, so nothing missed while it was down stays wrong.

**Your network**, on the Routing page, is the AS number of this server's ISP,
or your own (for example AS64500). Left unset, it is found the way a probe
agent's is: the network of the first hop on the internet in its traces.

## Directly connected, or through an upstream

Each peer's route is either **directly connected**, with no network between
the peer and the origin (the two connect at an exchange, privately, or as the
origin's upstream), or **through an upstream**: the network before the origin
in the path.

A prefix taken off the exchanges shows as the peers that reached it directly
going through an upstream instead. That is so even when the upstream is one it
already used for the rest of the world, which is why it is judged on its own
(Off the exchange, below).

BGP cannot say which exchange a direct route uses: the exchanges' route servers
stay out of the path, and RIS has no collector at some exchanges (JINX, for
one). Two things can: the exchanges' own route collectors, in **At the
exchanges**, and a traceroute, in **From your networks**.

## How a prefix stands

| State | When |
|---|---|
| Normal | Carried as it was when normal was taken. |
| Diverted | A fifth or more of the peers reach it through upstreams it was not reached through before; or, at one collector, half or more of the peers that reached it directly now go through an upstream ("Off the exchange at Johannesburg, NAPAfrica"); or the origin no longer offers it itself at an exchange whose route collector had it from the origin ("Off the exchange at JINX"); or a more-specific of it has appeared. |
| Partly withdrawn | Fewer than 80% of the peers that saw it still do. The page says in which regions. |
| Withdrawn | Fewer than 10% do. |
| Suspected hijack | Two or more peers see another network announcing it. |
| Learning | No routes were seen when it was added, so there is no normal yet. |

After a planned change, such as a new upstream, **Take as normal** on the
prefix's page makes how it is carried now the normal it is judged against.

## The prefix's page

- **From your networks:** a card for each place you look from: this server,
  and each of your probe agents.
  - **Its network:** set for this server, or found from its traces (the
    network of the first hop on the internet).
  - **Its network's routes:** the routes that network shares with RIS's
    collectors, each "Directly connected" or "Through" an upstream, with where
    it was seen.
  - **Its traffic:** the latest traceroute from there to each of your targets
    inside the prefix (or, with none, to an address in it), the exchange it
    crossed (for example "Crosses JINX at 192.0.2.32"), when it last crossed
    somewhere else, and every hop.
  - **When it is traced:** whenever how the prefix stands changes, whenever a
    route of yours changes, when **Trace now** is pressed, and when the newest
    trace is over six hours old. These traces are kept with the prefix, not in
    the targets' traceroute history. A probe agent that is offline is skipped.
- **At the exchanges:** a card for each of JINX, CINX, DINX and NMBINX, from
  the exchange's own route collector: whether the origin offers the prefix
  there itself (and over how many sessions), or only through other members,
  or not at all; and the members that offer it, each with its path. An
  exchange the origin offered it at when normal was taken, and no longer does,
  is marked "Origin gone from here".
- **Your routes, across the page:** your networks' routes are marked by whose
  they are, "Your ISP" for this server's network and each probe agent by name,
  in Where it is seen, Who carries it, the paths (drawn as a dashed line over
  the bands), the updates and the collector peers, which can be filtered to
  your networks.
- **Where it is seen:** the share of collector peers that see it in each of the
  five regions the registries hand out addresses in. Choose a region to see its
  countries, and a country to see its exchanges.
- **Who carries it:** the network before the origin, or Directly connected,
  and each one's share. A new upstream is marked. Choose one to see where in
  the world it carries the prefix.
- **Paths:** region (or country, once a region is chosen), then the network the
  peers hear it from, then the upstream, then the origin, each band as thick as
  the peers on it. Choose a place to narrow the page to it, an upstream or a
  band to follow that upstream, or a network to light its bands.
- **Activity:**
  - **The day at a glance:** the updates received, a bar for each quarter of an
    hour. Choose a bar to list just its updates.
  - **Each update listed:** who sent it, from which exchange, what was
    announced or withdrawn, and the path it replaced. For example, "Now through
    AS64502, was directly connected", or "Announced again on the same path",
    which is a change to something else about the route.
- **What changed:** changes in how the prefix stands, and in your network's
  route, over two weeks.
- **Your targets in this prefix:** ClearPing targets whose address is in it,
  with their latest readings.
- **Collector peers:** every peer and its route, by exchange. Search by
  network, AS number, address or exchange. Filter to those directly connected,
  those with no route, or those through a new upstream.

Choosing a region, a country or an upstream narrows everything below it,
including the updates listed. What is chosen is shown above the panels, where
each part can be taken off again.

A peer at an exchange is placed in the exchange's country. Three collectors
(RRC00 and RRC25 in Amsterdam, RRC24 in Montevideo) take feeds from networks
anywhere; their peers are placed in the country their network is registered in,
looked up from RIPEstat once and kept.

## What is kept

Only a little, and briefly:
- **Updates:** two days, each with the path it replaced, and at most 50,000
  for a prefix, the newest, so one flapping for days cannot fill the database.
  A quiet prefix has tens a day.
- **Changes in state and in your networks' routes:** two weeks.
- **Routing's traces:** two weeks.
- **Routes:** not stored. They are read again from RIPEstat when ClearPing
  starts, and the exchanges' collectors are asked again.
- **Exchange LANs:** read from PeeringDB once a day, with a copy kept so a
  restart need not read them again. PeeringDB throttles anonymous reads of its
  whole lists, so a read can time out or be turned away. When it cannot be
  read and no copy is kept, Routing says so under your network and asks for a
  PeeringDB API key: make one for free in your PeeringDB profile, set it as
  `CLEARPING_PEERINGDB_API_KEY` and restart ClearPing. A key set or changed
  is tried at once rather than after the hour's wait.

## Limits

- The collectors see the internet from where their peers are. A change made
  inside one network that does not change what it announces, such as a
  mitigation diverting traffic within the upstream, is not seen in BGP. The
  traceroutes in From your networks are what show that.
- A network's own routes only show if it shares them with RIS. If it does not,
  the traceroutes still show the exchange its traffic crosses.
- RIS has collectors at some exchanges and not others: in South Africa at
  NAPAfrica Johannesburg, not at JINX, CINX or DINX. Those are covered by
  INX-ZA's own route collectors, which see what the members offer at each
  exchange, though not which route each member then uses. The exchange's
  looking glass matches a prefix exactly, so ClearPing asks it for the watched
  prefix and up to seven of the more-specifics announced in it.
- Alerts are not sent for BGP changes yet: the states show in Routing, with a
  count beside it in the sidebar.
