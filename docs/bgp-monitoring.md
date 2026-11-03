# BGP monitoring

Routing, in the sidebar under Overview, watches prefixes in BGP: how the world
reaches them, as RIPE RIS's route collectors see it, and how your own network
reaches them. It is for anyone who needs to know when a route moves, such as a
prefix taken off the exchanges onto transit during a DDoS mitigation.

It is off until an admin turns it on in **Settings › Routing**. While it is off,
Routing is greyed out in the sidebar (an admin's tile opens that setting), and
ClearPing asks nothing of RIPE or PeeringDB.

## Where the data comes from

- **RIPE RIS:** how other networks reach the prefix. RIPE NCC's Routing
  Information Service has route collectors at internet exchanges around the
  world, each taking a BGP feed from many networks (their "peers"). ClearPing
  reads every peer's route from RIPEstat (stat.ripe.net) and follows each
  change live from RIS Live (ris-live.ripe.net).
- **Your networks' routes:** many ISPs share their routes with RIS too. The
  routes of your networks (this server's, and each probe agent's) are picked
  out from the rest.
- **Your traffic:** traceroutes into the prefix from this server and from each
  probe agent. Each hop's address is checked against the exchanges' peering
  LANs from PeeringDB (peeringdb.com), which names the exchange the traffic
  crosses, and against the members' addresses on the exchanges from IXPDB
  (ixpdb.euro-ix.net, Euro-IX's database, built from the exchanges' own member
  lists), which names the network the traffic went into there.

Nothing is asked of your routers, and nothing needs setting up on them.

## What it does

**Watch a prefix**, on the Routing page, takes a prefix (a /8 or longer, or for
IPv6 a /16 or longer: nothing wider is announced), or the IP address of a
server (the announced prefix that holds it is watched, and the most specific
route to that address followed). As it is typed, the dialog says which
announced prefix that is and who announces it, with the announced prefixes it
is part of and those inside it: an address in a provider's space belongs to
one of its announcements, and which one is not always plain. The box takes several,
separated by commas. Below it, your existing monitors with a public address can
be ticked: ticking one puts its address in the box and unticking takes it out,
so the box always says what will be watched. Each is labelled with the
monitor's name unless a label is given, and a monitor whose address a watched
prefix already holds is shown as already watched. ClearPing
then:

- adds it at once, then reads every collector peer's current route to it in
  the background (RIPEstat can take up to a minute over a busy prefix, and a
  read that fails is tried again every minute; it shows as "Learning" until
  then), and takes how it is carried when they arrive as **normal**: the networks announcing it, the upstreams it is
  reached through, the peers that reach it directly, the peers that see it,
  the prefixes announced within it, and the exchanges whose route collectors
  have it from the origin itself. From then on normal is learned (below);
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

BGP cannot say which exchange a route uses: the exchanges' route servers stay
out of the path. **At the exchanges** says where the way from your networks
probably crosses one, from PeeringDB's member lists, and a traceroute, in
**From your networks**, says for sure.

## How a prefix stands

| State | When |
|---|---|
| Normal | Carried as it usually is. |
| Diverted | A fifth or more of the peers reach it through upstreams it was not reached through before; or, at one collector, half or more of the peers that reached it directly now go through an upstream ("Off the exchange at Johannesburg, NAPAfrica"); or a more-specific of it has appeared. |
| Partly withdrawn | Fewer than 80% of the peers that saw it still do. The page says in which regions. |
| Withdrawn | Fewer than 10% do. |
| Suspected hijack | Two or more peers see another network announcing it. |
| Learning | No routes were seen when it was added, so there is no normal yet. |

## Normal is learned

Normal follows how the prefix is carried, slowly, so there is nothing to
accept after a planned change:

- **Something new** (an upstream, a more-specific, a peer that sees it or
  reaches it directly, an exchange the origin offers it at) is normal once it
  has been there for a day without a break. A diversion that lasts a day is
  then how the prefix is carried; one that ends sooner is flagged for as long
  as it lasted. A break starts the day again.
- **Something normal that has gone** is forgotten after a week away: an
  upstream dropped, a collector's session closed. Until then its return is no
  news.
- **The networks announcing it** are never learned, as a new one is what a
  hijack looks like. When one is yours, or one you moved the prefix to, **This
  is ours: accept it as normal** in the warning takes how it is carried now as
  normal at once.
- Nothing is learned while it looks hijacked or withdrawn.

Each time something is learned or forgotten, What changed says what ("AS64510
is one of its usual upstreams now: it has carried it for a day"). What is
waiting to be learned is kept with the prefix, so a restart does not start the
wait again.

## The prefix's page

- **From your networks:** a card for each place you look from: this server,
  and each of your probe agents, with a timeline of what was seen from there,
  newest first, by day. Above them, a chip for each probe agent says which are
  looked from: choose one to leave it out (it is no longer traced from, and its
  network is no longer marked) or to take it back in. Every probe agent is in
  until left out, one added later too.
  - **Its network:** set for this server, or found from its traces (the
    network of the first hop on the internet).
  - **Its traffic's way in:** the networks its newest trace passed through, its
    own first.
  - **Its network's routes:** the routes that network shares with RIS's
    collectors, each "Directly connected" or "Through" an upstream, with where
    it was seen, from when it was first seen; and every time one of them
    changed ("Now through AS64500 at Johannesburg, was directly connected").
    Open one for its path. A route whose way in changed three times or more in
    24 hours is **flapping**: its changes are one entry ("Flapping at
    Johannesburg: 5 changes in 24 hours", with the ways it went between), and
    the card and the section are marked Flapping.
  - **Its traffic:** the latest round of traceroutes from there, one to each
    of your monitors inside the prefix (or, with none, to an address in it), as
    one entry saying the exchange they crossed ("Crosses JINX to all 4 addresses", or
    "Crosses NAPAfrica IX Johannesburg to 3 addresses; crosses JINX to 1");
    open it for each address and its hops. A hop on an exchange is named with
    the member whose address it is, by IXPDB: where the traffic went next. Below it, each time the traffic
    began crossing somewhere else ("Changed to JINX, was NAPAfrica IX
    Johannesburg"), one entry however many addresses changed together. An
    address that keeps going back and forth, as traffic spread over two ways
    in does, has a single entry ("Switches between JINX and NAPAfrica IX
    Johannesburg") instead of one for each change, and is marked Flapping
    too. The last 20 traces to each
    address are kept. A hop on an exchange's peering LAN is a
    sure crossing. Many routers answer a traceroute from another of their
    addresses, though, so a crossing can leave no hop on the LAN: then, where
    the trace passes from one network to the next and PeeringDB or IXPDB
    lists both as members of an exchange, it says "Probably crosses" that
    exchange (or the ones they share). Two members can also be joined by a private link, hence
    probably. Without PeeringDB it says the exchange is not known rather than
    that there is none.
  - **When it is traced:** whenever how the prefix stands changes, whenever a
    route of yours changes, when **Trace now** is pressed, and when the newest
    trace is over six hours old; unasked, not more than once in 15 minutes,
    however often the routes change. These traces are kept with the prefix, not in
    the monitors' traceroute history. A probe agent that is offline is skipped.
- **At the exchanges:** the exchanges anywhere in the world on the way to the
  prefix from your own networks: along your ISPs' routes (where they share
  them with RIS) and the way your traceroutes went, from this server and each
  probe agent. Where two networks next to each other on that way are both
  members of an exchange, by PeeringDB, they probably meet there; where they
  share two or three in one country, all are named ("NAPAfrica IX
  Johannesburg or JINX"), and where they share more, none is guessed. Each
  says whose way crosses it and between which networks, and a traceroute that
  crosses its peering LAN is marked "Your traceroute crosses it". With none
  on the way, there is no such section.
- **Yours, across the page:** your networks' routes are marked by whose they
  are, "Your ISP" for this server's network and each probe agent by name (two
  on one network share a mark), in Where it is seen, Who carries it, the paths
  (each drawn as a dashed line over the bands, "Your ISP" in the text colour
  and each probe agent in a colour and dash of its own, with a key beneath),
  the updates and the collector peers, which can be filtered to your networks.
  Where a network of yours shares no routes with RIS, its traffic is drawn
  instead: its way in by trace, on the paths from where its network is
  registered ("Probe agent London's traffic"), marked in Where it is seen and
  against the upstream it came through in Who carries it. A trace that stopped
  short of the origin is drawn on to it. "Add a probe agent", on a prefix's
  page, opens Settings at Probe agents (for an admin).
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
    hour, counted from the same updates as the list below, so a region or an
    upstream chosen narrows the bars too. Choose a bar to list just its
    updates; a bar of one opens it. On a day of more than 2,000 updates the
    bars count them all, everywhere, and say so.
  - **Each update listed:** who sent it, from which exchange, what was
    announced or withdrawn, and the path it replaced. For example, "Now through
    AS64502, was directly connected", or "Announced again on the same path",
    which is a change to something else about the route. Open one (anywhere on
    its row) for the whole of it: the prefix announced or withdrawn, the peer
    and its address, the RIS collector and where it is, the route before and
    the one announced a network at a time with each one's part (the peer, the
    upstream, the origin), and the route that peer has now, if any.
- **What changed:** changes in how the prefix stands, and in your network's
  route, over two weeks.
- **Your monitors in this prefix:** ClearPing monitors whose address is in it,
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
- **Members' addresses on the exchanges:** read from IXPDB once a day (three
  or four megabytes; no key needed), with a copy kept. Without it, hops on an
  exchange are not named with their member, and only PeeringDB says who is a
  member where.
- **Exchange LANs and members:** read from PeeringDB once a day, with a copy kept so a
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
  NAPAfrica Johannesburg, not at JINX, CINX or DINX. Where it has none, At the
  exchanges and your traceroutes are what place your traffic at one.
- Alerts are not sent for BGP changes yet: the states show in Routing, with a
  count beside it in the sidebar.
