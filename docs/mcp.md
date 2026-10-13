# Connecting an AI assistant (MCP)

ClearPing can be read by an AI assistant over the
[Model Context Protocol](https://modelcontextprotocol.io). Give the assistant
one address and it can answer questions from what ClearPing has recorded, the
way you would by reading the charts:

> Gather the logs from the last week so I can report this to my ISP, as a PDF.

The assistant asks ClearPing for the evidence and writes the report from it.

## Connecting

The address is `/api/mcp` on wherever your ClearPing is reached:

```
http://clearping.lan:3000/api/mcp
```

**Connect an AI assistant**, at the foot of the sidebar, shows the address for
your installation and what to do with it.

**Claude Code.** Once, in a terminal:

```bash
claude mcp add --transport http clearping http://clearping.lan:3000/api/mcp
```

**The Claude apps and claude.ai.** Settings, Connectors, Add custom connector,
and paste the address. These connect from Anthropic's servers and not from your
computer, so the address has to be reachable from the internet. A ClearPing on a
home or office network is not; use Claude Code for one of those. A custom
connector also has no field for a token like ClearPing's, so it cannot connect
to one that asks for a token.

**Any other client.** Add it as a remote server over HTTP (Streamable HTTP):

```json
{
  "mcpServers": {
    "clearping": { "type": "http", "url": "http://clearping.lan:3000/api/mcp" }
  }
}
```

There is nothing else to install or run: it is part of the app.

## What an assistant can do

As it comes, it can read and only read: no tool adds, changes, pauses or probes
a target, and nothing is sent anywhere. Alerts are left out altogether, since
where an alert is sent is usually a URL with a password in it.

| Tool | What it returns |
|---|---|
| `list_targets` | Every target: its address, probe, group, whether it is inside the local network, and how its latest probe went |
| `build_isp_report` | The evidence for a report to an ISP, in one call (below) |
| `get_incidents` | Every outage and spell of loss in a period, across targets, with what the other targets were doing meanwhile |
| `get_target_history` | One target in depth: its figures, its incidents, the gaps in monitoring, and how it did at each hour of the day |
| `get_traceroutes` | Saved routes hop by hop, with the hop at which replies stopped |
| `get_dns_resolvers` | For a DNS target that asks several resolvers: how each did, and what each last answered |

Each takes a period (`hours`, `days`, or `start` and `end`) and a `timezone`
to write times in, which is the time zone of the machine ClearPing runs on
unless another is given. Times are written as local time with the offset from
UTC on the end, `2026-10-13T14:02:00+02:00`, so they read naturally and are
still exact to someone in another zone.

There is also a ready-made prompt, `isp_report`, which is the whole request
written out: gather the evidence, then write it up in the order an ISP's
support desk needs it. It takes how many days to cover, the provider's name
and the format wanted.

### Letting it change things

Set `CLEARPING_MCP_TOKEN` and an assistant that sends the token gets five more
tools:

| Tool | What it does |
|---|---|
| `add_targets` | Starts monitoring new targets, up to 50 at once |
| `update_target` | Changes a target's name, group, interval, address, probe or settings |
| `set_target_paused` | Stops probing a target, or starts again |
| `probe_now` | Takes a reading straight away |
| `run_traceroute` | Traces the route to a target now and saves it |

> Add my router, my ISP's gateway and 1.1.1.1 as ping targets, in a group
> called Network.

A target needs only an address, read the way the form in the app reads it: a
URL is a web page to load, `host:port` a port to connect to, anything else a
ping. Everything added goes through the same check as that form, a list with a
mistake in it is turned away whole, and a target already monitored the same way
is passed over and reported, not added twice.

Two things are left out on purpose. Nothing here **deletes**: a target's whole
history goes with it and does not come back, so that stays a button for a
person to press. Pausing is the way an assistant stops something being
monitored. And **alerts** cannot be seen or changed.

Each of these tools is marked as one that changes something, so a client such
as Claude Code asks you before it runs one. With no token set they do not
exist: the list an assistant is given has only the six that read.

## The report

`build_isp_report` covers the last seven days unless told otherwise, and
returns:

- **How each target did**: probes taken, uptime, loss, latency, and how many
  outages and for how long in all.
- **Every outage**, with the time of the first probe that failed and of the
  probe that found it working again, why the probes failed, and **what the
  other targets were doing meanwhile**.
- **The worst spells of packet loss**, and a count of the rest.
- **The period by hour of day**, for the targets that had the most trouble. A
  line that is fine all morning and drops packets every evening shows here.
- **The traceroutes** saved in the period, those taken automatically as an
  alert fired first: the route through a failure, and the hop where replies
  stopped.
- **How each resolver did**, for DNS targets that ask several.
- **When ClearPing itself was not running**, and what else the data cannot
  show.

An outage is a spell in which at least one probe got no reply at all; a spell
of loss is one in which every probe got a reply and some packets did not. One
healthy probe in the middle does not split an outage in two: it is over when
two probes in a row are healthy.

### What makes the report worth sending

The report is as good as what is monitored. The strongest evidence an ISP can
be given is contrast: your router answering throughout while their gateway and
everything past it did not. That takes a target at each step:

- **your router**, by its address on your network (`192.168.1.1`);
- **the ISP's gateway**, the first hop past the router in a traceroute;
- **one or two addresses out on the internet** (`1.1.1.1`, a site you use).

With the router in the list the report can say the fault was beyond your
network. Without anything inside the local network it says, plainly, that the
data cannot tell a fault in the building from one outside it. A loss alert on
the outside targets is worth having too: a traceroute is saved automatically
when it fires, and that is the only time the route through a failure can be
captured.

The assistant is told to use only figures that are in the data, to keep the
caveats in, and to say so if the period shows no real problem.

## Keeping it to yourself

With no token set, the endpoint is as open as the rest of ClearPing's API,
which has no login: anyone who can reach the app can read it, and nobody can
change anything through it. To ask for a token, set `CLEARPING_MCP_TOKEN` to a
long random value and send it with every request:

```bash
claude mcp add --transport http clearping https://clearping.example.com/api/mcp \
  --header "Authorization: Bearer your-token"
```

A request without it is refused, reading included. The dialog in the sidebar
shows the command with a place for the token when one is set; it is never shown
the token.

### The token is only taken encrypted

A token sent over plain HTTP across the internet can be read by anything on the
way, and whoever reads it can change what you monitor. So with a token set,
ClearPing takes a connection only if it is one of:

- **over HTTPS**, from anywhere. ClearPing in a datacentre and an assistant at
  home is this case: put it behind a proxy that does TLS, as
  [compose.example.yaml](../compose.example.yaml) does with Traefik, and give
  the assistant the `https://` address;
- **at an address on its own network**, over plain HTTP: `localhost`, a private
  address (`192.168…`, `10…`), or a local name (`clearping.lan`, `nas.local`).
  There is no internet in between to listen.

Anything else is refused with `403` before the token is looked at, and the
answer says that a token sent with it should be changed, since it has already
travelled in the clear. The dialog in the sidebar warns of this before it is
tried, when the page itself was opened over plain HTTP at a public address.

How it arrived is read from `X-Forwarded-Proto`, which a proxy has to pass on
(Traefik and Caddy do; nginx needs `proxy_set_header X-Forwarded-Proto $scheme`).
If something else encrypts the connection, a VPN or an SSH tunnel to a public
address, set `CLEARPING_MCP_ALLOW_HTTP=1` to say so.

This is a guard against sending a token in the clear by mistake, not what keeps
a stranger out: the token does that. And it covers the MCP endpoint only. The
app itself has no login, so a ClearPing that is reachable from the internet
needs something in front of it that asks who is there.

A web page is only let through from the address ClearPing itself was reached
at. Any other is refused, so that a website cannot have a visitor's browser
read a ClearPing on their private network.

## How it works

One address, `POST /api/mcp`, taking one JSON-RPC message and answering with
JSON. Nothing is kept between requests and nothing is streamed, so there is no
session, and a `GET` is answered `405`. It speaks protocol revisions
`2025-06-18`, `2025-03-26` and `2024-11-05`. It is written out in
[src/lib/mcp-protocol.ts](../src/lib/mcp-protocol.ts) with no SDK behind it;
the tools are in [src/lib/mcp-tools.ts](../src/lib/mcp-tools.ts), and what
turns readings into incidents in [src/lib/outages.ts](../src/lib/outages.ts).
