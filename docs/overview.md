# The overview

New to the words ClearPing uses? They are [at the end of this page](#words-used-throughout).

**Overview**, at the top of the sidebar, is where ClearPing opens: the whole
network at a glance. It runs from what matters most to what matters least, and
every problem on it is one click from the monitor it was on.

![The overview, with one monitor not answering and one losing packets](screenshots/overview.jpg)

## What is on it

- **A summary** under the title: how many monitors are probed from this server
  and from probe agents, and how many are paused. If anything is wrong, a card
  under it says so, and which monitors.
- **Four figures.** *Answering now* (of the monitors being probed), *Up all
  day* with the average uptime, *Outages, last 24h* with the longest, and
  *Alerts firing*.
- **Last 24 hours.** A strip of quarter hours: green when every monitor probed
  in it answered, amber when some lost packets, queries or requests, red when
  some got no reply at all, and grey when nothing was probed. Click a red or
  amber stretch to list only who had trouble then.
- **Problems in the last 24 hours.** Every monitor that had trouble, whether it
  stopped answering or lost packets, why, for how long, how many times, and
  whether it is still going on: what is going on now comes first, marked
  *Now*. The first two are in view and the rest are one press away, under
  *N more problems*. A probe agent that could not be reached has a row of its
  own, listing its monitors: they took no readings meanwhile, so they are not
  counted as down. Filter by *Not answering* or *Losing packets*. Click one to
  go to that monitor.
- **Your groups**, each as a tile with how many of its monitors are online and
  its uptime today, and how many monitors there are of each kind.
- **Where readings are taken from.** This server and each probe agent, with
  how it is doing, how many monitors it probes and when it was last seen.
- **Routing**, while BGP monitoring is on: the prefixes watched and how each
  stands ([bgp-monitoring.md](bgp-monitoring.md)).

## Where the fault lay

When the line goes down, twenty monitors each have an outage at 12:49, and a
list of twenty outages hides the one thing worth knowing: it was one fault. So
problems that start within a couple of minutes of each other, among monitors
probed from the same place, are one event, and the event says where the fault
probably lay, from what else was answering at the time:

| Says | When |
|---|---|
| *Likely your own network: something inside it went down too* | A monitor on a private address, or a local name, was among them |
| *Only this monitor: everything else probed from here kept answering* | One monitor went wrong while others being probed from the same place did not |
| *Out on the internet: N other monitors went too, while your own network kept answering* | Several monitors failed, and a monitor inside your own network answered throughout |
| *Along with N other monitors probed from here* | Not enough was being probed from that place to say |

For a monitor probed from a probe agent, "here" and "your own network" are that
agent's: the same judgement, made from where it is.

The problems themselves are found the way the AI assistant's report finds them
([mcp.md](mcp.md)). The judgement of where the fault lay is only as good as
what is monitored. Add your router as a monitor as well as addresses beyond it,
and the Overview can tell a fault inside your network from one outside it.

## What is left out

- A spell of packet loss shorter than ten minutes is counted, not listed: a few
  dropped packets now and then are ordinary.
- A closed-port game server check that has never had an answer is left out: all
  it has done is fail, which says nothing about its server.
- A paused monitor is not probed, so it is not counted as answering or not.

## API

`GET /api/overview` answers the same as JSON: each monitor's uptime, the events
with where each fault lay, and how many monitors were watched, down and losing
packets in each quarter of an hour. What is going on right now is in
`GET /api/targets?packetLoss=true`, which the sidebar uses too.

## Words used throughout

The same word means the same thing everywhere in ClearPing, in the dashboard,
these guides and what an assistant is told.

| Word | What it is |
|------|------------|
| **Monitor** | One thing that is measured: an address, a web page, a game server, a DNS lookup. It has a name, a method, an interval, and sits in a group. The API and the assistant tools call it a *target*. |
| **Probe** | A place readings are taken from. A monitor can be measured from one or from several. |
| **Probe agent** | A small ClearPing program on another machine that takes readings from there. It has nothing to do with AI agents. |
| **Local probe** | The probe that is the machine the dashboard runs on. Always there, and called *Local probe* until you name it (Settings, Probes). |
| **Dashboard** | ClearPing itself: the web app you open, and what runs the local probe. |
| **Group** | A folder of monitors, which can sit inside another. |
| **Reading** | One measurement of a monitor from one probe: how many packets came back and how fast. A chart's point is a reading, or an average of several. |
| **Alert** | A condition on monitors, and where to say so when it holds. |
