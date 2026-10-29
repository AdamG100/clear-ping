# ClearPing

A self-hosted network monitor in the spirit of Smokeping. It probes your
hosts, websites, DNS and game servers on a schedule, from your own network or
from probe agents elsewhere, keeps the history in a single SQLite file, and
draws latency as a spread rather than a single line, so a path that is merely
slow looks different from one that is unstable.

![A target's page: latency spread and packet loss over the last hour](docs/screenshots/target.jpg)

## What it does

- **Five kinds of probe.** ICMP ping, TCP connect, game server query, HTTP(S)
  request and DNS query. Paste a host, `host:port` or a URL and the right one is picked.
- **Game servers.** A game server probe speaks the Steam server query (CS2,
  Rust, ARK, Valheim…), Minecraft Java's and Bedrock's pings and FiveM's
  `getinfo`, and shows the server's name, map and player count along with how
  fast it answers. For games that answer no query at all, such as Call of
  Duty, it times the server's "port unreachable" replies to closed ports
  instead.
- **Probe from anywhere.** A probe agent is a small program on another
  machine, such as a VPS in another country, that takes a target's readings
  from there. The dashboard connects to it over an encrypted, pinned link,
  through a tailnet or the internet.
- **One DNS lookup, several resolvers.** A DNS target can ask Cloudflare,
  Google, Quad9 or any resolver of your own on every probe, over plain DNS,
  DNS over TLS or DNS over HTTPS, and shows what each answered and how fast.
- **Latency as a distribution.** Each probe sends several packets; the chart
  shows where they clustered and how far the outliers reached, with packet loss
  on its own strip underneath. Above it, the round-trip time and jitter are
  drawn as their spread, and the loss as every probe by how much it lost.
- **Packet loss analysis.** When a target loses packets, a folded panel under
  the figures says what kind of loss it is (sporadic, bursts or sustained),
  the hour of day it peaks at, and which other targets lost packets at the
  same time, with the likely source: your local network, your connection or
  ISP, or the target's own path.
- **IPv4 and IPv6.** A hostname can be probed over either family, or over both
  at once and charted as two lines.
- **Nested groups.** Arrange targets into groups inside groups, drag targets
  between them, and collapse a group to one trace for everything in it.
- **Comparison charts.** Put every target in a group on one chart to see
  whether a slowdown hit one of them or all of them.
- **Share links and files.** Tick some targets, or all of them, and get a link
  that holds them, or download them as a JSON file. Someone else pastes the
  link, or chooses the file, in their ClearPing and picks which to add. Neither
  needs the two ClearPings to reach each other, so it works between home
  networks; the file doubles as a backup of what you monitor.
- **Alerts.** One screen for all of them: make an alert, tick the targets it
  watches, and send it to any service [Apprise](https://github.com/caronc/apprise)
  can notify: Discord, Slack, Telegram, email, ntfy, a webhook and over a
  hundred more.
- **Traceroute.** On demand, and automatically at the moment an alert set to
  trace fires (with a wait between traces), which is the only time the route
  through a failure can be captured. Copy one as text or save it as a web page
  to share.
- **Certificate expiry.** HTTPS targets record when their certificate runs
  out, and an alert can watch for it.
- **Accounts and roles.** Admins, editors and viewers; authenticator apps and
  passkeys; single sign-on with Authentik; and keys for scripts. A new account
  can be given a one-time link to choose its own password, so no admin ever
  knows it.
- **Ask an AI assistant.** ClearPing is an MCP server as well. Give Claude,
  or any assistant that speaks MCP, its address and say "gather the logs so I
  can report this to my ISP": it gets every outage with its times, what kept
  working meanwhile and the traceroutes, and writes the report.
- **Phone to wall display.** The layout follows the screen, from a phone held
  upright to an ultrawide monitor, and it installs to a home screen as an app
  on Android and iOS.
- **Nothing else to run.** One process, one SQLite file, no external database.

## Screenshots

Everything in these is generated demo data.

A group on one chart over a day, with the evening slowdown on every line, and
Cloudflare as seen from a probe agent in Frankfurt:

![Four internet targets compared on one chart over 24 hours](docs/screenshots/group-comparison.jpg)

A game server: how fast it answers its query, and what it says about itself:

![A CS2 server's page, with its name, players, map and version](docs/screenshots/game-server.jpg)

Adding a target: the address picks the check (here a DNS resolver), and the
target can be probed from a probe agent:

![The add target page, in four numbered sections](docs/screenshots/add-target.jpg)

Probe agents, and how each is doing:

![The probe agents page, with two online and one offline](docs/screenshots/probe-agents.jpg)

Alerts, each watching the targets ticked for it:

![The alerts screen, with one alert firing](docs/screenshots/alerts.jpg)

An alert being edited: the condition, tracing the route when it fires, where
it is sent, and the targets:

![The alert editor](docs/screenshots/alert-editor.jpg)

Sharing: tick the targets to send, and get a link that holds them:

![The share dialog, with a link made for eleven of fourteen targets](docs/screenshots/share.jpg)

Accounts: a new one gets a link to choose its own password:

![The accounts page, with the new account form open](docs/screenshots/accounts.jpg)

## Quick start

### Docker

```bash
docker run -d --name clearping -p 3000:3000 -v clearping-data:/data ghcr.io/adamg100/clear-ping:latest
```

Then open <http://localhost:3000>. The image contains the web app, the probe
scheduler, `ping` and `traceroute`.

Keep the volume: the database lives at `/data/clearping.db`, and without a
volume the history goes when the container does.

> **Turn sign-in on, or keep it private.** Sign-in is off until you turn it on
> (Settings → Access), and while it is off anyone who can reach ClearPing can use
> all of it, including the tokens in your alerts' notification URLs. Create the
> first account straight away (the setup code is in `docker logs clear_ping`),
> turn sign-in on, and set `CLEARPING_ALLOWED_HOSTS`. If you cannot, keep it
> behind a VPN or a proxy that signs people in.

For Compose, [compose.example.yaml](compose.example.yaml) runs the same image
behind Traefik. Copy it to `compose.yaml` and change the hostname and network
to yours.

### From source

Needs Node.js 26.12.1 or newer, and `ping` and `traceroute` (`tracert` on Windows)
on the machine.

```bash
git clone https://github.com/AdamG100/clear-ping.git
cd clear-ping
npm install
npm run dev
```

Open <http://localhost:3000>. Probing starts with the server. For anything you
rely on, build it and run the prober as its own process; see
[docs/running.md](docs/running.md).

## Using it

### Targets

**Add target** at the bottom of the sidebar opens a page of four numbered
sections: **Target** (the address), **Name** (and its group), **Check** (how
it is probed, and how often) and **Probe from** (this server or a probe agent,
shown once you have one). The address box takes a hostname, an IP address,
`host:port` or a URL, and chooses the check to match; everything else has a
default, so an address and Enter is a whole target. Fields that must be filled
in are marked *Required*. A target is probed every five minutes unless you
change its interval.

Each row in the sidebar shows the target's state, its address and a trace of
its recent readings. Its badges say what it is (IP, DNS, TCP, HTTP, Game), and
a purple *Remote* badge marks one probed from a probe agent. The ⋯ button at
the end of the row copies the address, pauses, edits, duplicates or deletes it.

**Duplicate** opens the add form already filled in from that target, for the
second port on a host or the same check against the next server along. Change
what is different and add it: it is a new target with no history, placed under
the one it was copied from.

On a wide screen the button at the top of the sidebar collapses it to a rail
of icons, to give the page its width, and the same button on the rail brings
it back. The rail keeps one tile for each top-level group, lit by the state of
everything inside it (red if anything in the group is down), along with the
alerts count; clicking a tile opens that group's comparison chart. The choice
is remembered. On a phone or a narrow window the sidebar is a drawer, opened
by the ☰ button at the top left. Tapping a chart shows the reading at that point, and dragging
sideways across it zooms in.

To clear out several targets at once, use the list button at the top of the
sidebar, beside the search. Tick the ones to go, singly or a whole group at a
time, and delete them together. Nothing starts ticked and the button asks
twice: a target's whole history goes with it.

A **paused** target is not probed. Its row and its status light go grey, its
page stops passing judgement on readings nobody has taken since, and it is
counted as paused rather than as online or offline. Its history is kept.

### Groups

**New group** at the foot of the list makes a group: give it a name and, if it
belongs inside another, pick which. It starts empty, ready to be filled.

- The folder button on a group's header makes a new group inside that one.
  Groups nest to any depth.
- Drag a target by its handle onto any group, at any depth. An empty group also
  offers to add a target straight into it.
- A target's group can be chosen when it is added or edited too. **New group…**
  in that list makes one on the spot.
- Drag a group by its handle to reorder it among its neighbours.
- The pencil on a group's header renames it, moves it inside another group
  taking everything in it along, or deletes it. Deleting a group keeps what was
  in it: its targets and the groups inside it move up a level.
- Collapse a group and it shows one trace for the whole group: the mean
  latency of its targets, marked wherever any of them lost packets.
- **Compare** on a group's header puts all its targets, including those in the
  groups inside it, on one chart.

A group stays until it is deleted, whether or not anything is in it.

### Sharing

The share button beside **Add target** makes a link out of your targets, for
someone else's ClearPing to import.

- **Share**: tick the targets to send, single ones or whole groups (they all
  start ticked), and create the link.
- **Import**: paste a link. You are shown what is in it and choose what to add.
  Targets you already monitor are marked and start unticked.

The link is the list itself. Nothing is stored for it and the two
installations never talk to each other, so it works between machines that
cannot reach one another. It carries each target's name, address, probe
settings, interval and group. It carries none of their history and no alerts,
whose notification URLs usually have a password in them. Anyone who has the
link can read what is in it, so send it as you would the list.

Opening a link in a browser brings up the import on the ClearPing the link was
made on, which is what you want when both of you use the same one. For a
different one, paste it under Import there.

### Alerts

**Alerts** at the bottom of the sidebar opens the alerts screen, and shows how
many are firing.

An alert is a condition (stops responding, loss above a threshold, latency,
jitter, or a certificate about to expire), a number of probes in a row it must
hold for, somewhere to send it, and the targets it watches. Tick single targets
or whole groups. Each ticked target fires and clears on its own.

Where it is sent is a list of [Apprise](https://github.com/caronc/apprise) URLs
on the alert, one for each service to notify:

```
discord://webhook_id/webhook_token
tgram://bot_token/chat_id
mailtos://user:password@smtp.example.com?to=oncall@example.com
jsons://hooks.example.com/my-endpoint
```

Any service Apprise supports can be used, and an alert can go to several at
once. The message is written once and Apprise turns it into what each service
takes. With no URLs nothing is sent, and the alert is only shown in the app.

**Send test** sends a sample message so a wrong URL is found before it
matters. Details, what the message says and the finer points are in
[docs/alerting.md](docs/alerting.md).

The Docker image includes Apprise. Running from source, install it with
`pip install "apprise[all-plugins]"`.

### An AI assistant

**Settings → AI assistant** (the cog at the foot of the sidebar) gives the address to
hand to an assistant and what to do with it. For Claude Code that is one
command:

```bash
claude mcp add --transport http clearping http://your-clearping:3000/api/mcp
```

Claude Desktop reaches a ClearPing on your own network through a few lines in
its configuration file, which the dialog writes out for you; see
[docs/mcp.md](docs/mcp.md).

Then ask it in your own words:

- *Gather the logs from the last week so I can report this to my ISP, as a PDF.*
- *Which targets had outages yesterday, and what kept working while they were down?*
- *Is my connection worse in the evenings?*

As it comes it can only read: nothing an assistant does changes a target or
sends anything, and alerts are never shown to it. Give an assistant a key of
its own that may read and write (Settings → Keys) and it can also add
targets, change them, pause them and probe one now (*add my router and 1.1.1.1
as ping targets, in a group called Network*), though never delete one; what it
changes is recorded under its key's name. A key is only taken over HTTPS or
from ClearPing's own network, never in the clear across the internet. What it
can be asked, what the report contains and how the token works are in
[docs/mcp.md](docs/mcp.md).

A report is as good as what is monitored. Add your router as a target as well
as addresses beyond it, and the data can show whether a fault was inside your
network or outside it.

### Probe agents

A probe agent is a small program on another machine, such as a VPS in another
country, that takes readings from there for your dashboard. It is not an AI
agent. Add one under **Settings → Probe agents**, start it with the Docker
command or the Linux install line shown there, and choose it under **Probe
from** on any target. That target's readings then show the network as seen
from that machine, on the same dashboard as everything else, marked *Remote*
in the sidebar.

The page counts how many are online and how many need attention, and lists
each with its status, version and when it was last seen. **Details** on one
has its machine, certificate and targets, and tests its connection, renames it
or changes its address, makes it a new token or removes it.

The dashboard connects to the agent, encrypted and pinned to the agent's own
certificate, with a token for each agent. Over a tailnet such as Tailscale, no
port has to be opened anywhere. While an agent can't be reached its targets
take no readings, so a dead agent never shows up as targets being down. See
[docs/probe-agents.md](docs/probe-agents.md).

### Accounts

**Settings → Accounts** lists who can sign in and what each may do. **Add
account** opens the form for a new one, whose password is set one of two ways:

- **They choose it, with a link.** You get a one-time link to send them, which
  works for 48 hours. They choose their password on the sign-in page, so you
  never know it.
- **I set it now.** You type one and pass it on.

**Password** beside an account does the same for someone who has forgotten
theirs. The primary account, the first one made, resets its own with a code
from the server log instead. Sign-in, roles, second factors and single sign-on
are in [docs/security.md](docs/security.md).

## Upgrading

Pull the new image and recreate the container:

```bash
docker compose pull && docker compose up -d
```

The database is brought up to date by itself when the new version starts. It
records which changes it has already had, applies the ones it has not, each in
a transaction that either completes or leaves the database as it was, and logs
what it did. Nothing needs to be run by hand, and measurement history is kept.
[docs/running.md](docs/running.md#upgrading) has the details, including what
happens if you go back to an older image.

## Configuration

All optional. With Docker, pass them with `-e`.

| Variable | Default | Purpose |
|---|---|---|
| `CLEARPING_DB_PATH` | `./data/clearping.db` (`/data/clearping.db` in the image) | Where the database is kept |
| `CLEARPING_RETENTION_DAYS` | `90` | Days of measurements to keep; `0` keeps everything |
| `TZ` | unset (each viewer's own) | The time zone every time in ClearPing is shown in, as an IANA name such as `Europe/London`: the charts, the tables, the routes, the alerts sent out and the nightly clean-up all go by it. Unset, the page shows each person their own time, and the server keeps UTC |
| `CLEARPING_EXTERNAL_PROBER` | unset | `1` stops the web app scheduling probes, for when `npm run probe` runs as its own process |
| `BETTER_AUTH_SECRET` | made and kept in the database | What sign-in cookies are signed with. Nothing needs it set; set it to keep sessions across a replaced database |
| `CLEARPING_AUTH` | unset | `off` turns sign-in off whatever the dashboard says, and lets a new account be made: for getting back in after a lost password ([docs/security.md](docs/security.md#locked-out)) |
| `CLEARPING_SETUP_CODE` | made at start-up, written to the log | What the first account asks for besides a password, so that whoever reaches a new install first cannot take it over. Read it with `docker logs clear_ping`, or set it yourself |
| `CLEARPING_ALLOWED_HOSTS` | unset (any) | Comma-separated hostnames ClearPing answers to, such as `ping.example.com`; a request addressed to another name is refused. Stops a web page from pointing its own domain at your machine to read the API (DNS rebinding) |
| `CLEARPING_TRUST_PROXY` | `0` | How many proxies in front of ClearPing add to `X-Forwarded-For` (`1` for Traefik). Without it the header is ignored, and sign-in attempts are counted per username only |
| `CLEARPING_MCP_TOKEN` | unset | The single assistant token from before keys were made in the dashboard. Still works, as a key that can change things; keys made in Settings are better, one per assistant |
| `CLEARPING_MCP_ALLOW_HTTP` | unset | `1` takes the token over plain HTTP from anywhere, for when a VPN or tunnel does the encrypting. Otherwise it is taken only over HTTPS or from ClearPing's own network |
| `CLEARPING_PEERINGDB_API_KEY` | unset | A PeeringDB API key, for Routing to read the exchanges' peering LANs with. Without one PeeringDB throttles anonymous reads; ClearPing reads them once a day and keeps a copy, so it is rarely needed ([docs/bgp-monitoring.md](docs/bgp-monitoring.md)) |
| `CLEARPING_UPDATE_CHECK` | on | `off` stops the hourly check of the registry for a newer image. The dashboard then shows the version it runs but not whether it is the latest |

## API

Everything the interface does goes through these.

| | |
|---|---|
| `GET /api/targets` | Every target; `?packetLoss=true` adds latest readings, recent traces, the groups and their order |
| `POST /api/targets` | Add a target |
| `POST /api/targets/import` | Add several at once (`{ targets: [...] }`); all are checked first, and none is added if one is wrong |
| `DELETE /api/targets` | Delete several at once (`{ ids: [...] }`), each with its history |
| `GET`, `PATCH`, `DELETE /api/targets/:id` | Read, change (including pause and group) or delete one |
| `POST /api/targets/:id/probe` | Probe it now |
| `GET /api/targets/:id/measurements` | Its readings, bucketed for a chart (`?hours=` or `?start=&end=`) |
| `GET /api/targets/:id/loss` | Its packet loss analysis over the same period: pattern, hour of day, other targets that lost packets at the same time, likely source (`&tz=` for the hours) |
| `GET`, `POST /api/targets/:id/traceroute` | Its saved routes; trace it now, over `{"family": "ipv4" \| "ipv6" \| "both"}` if given |
| `DELETE /api/targets/:id/traceroute` | Delete one saved route (`?trace=id`) or all but the newest (`?older=1`) |
| `PUT /api/targets/reorder` | Save the order of targets or of groups |
| `POST /api/groups` | Make a group (`{ group }`, a path such as `Home/Network`) |
| `PUT /api/groups` | Rename a group or move it inside another (`{ from, to }`) |
| `DELETE /api/groups` | Delete a group (`{ group }`); what was in it moves up a level |
| `GET /api/compare` | The same period of several targets (`?targets=id,id`); `&split=resolver` gives a DNS target's resolvers a line each (`&family=4` or `6` for one side of a target on both) |
| `GET`, `POST /api/alerts` | Every alert; make one |
| `PATCH`, `DELETE /api/alerts/:id` | Change or delete one |
| `POST /api/alerts/:id/test` | Send its notification URLs a test message |
| `GET /api/probe-agents` | The probe agents targets can be probed from, and whether each can be reached. A target's `probeAgentId` says which it uses (`null` for this server), and is set the same way in `POST` and `PATCH /api/targets` |
| `/api/security/probe-agents/…` | Add, change and remove probe agents, connect to one (`…/:id/connect`) and make it a new token (`…/:id/token`); admins only ([docs/probe-agents.md](docs/probe-agents.md)) |
| `GET /api/bgp` | BGP monitoring: whether it is on, the connection to RIS Live, and every watched prefix with how it stands ([docs/bgp-monitoring.md](docs/bgp-monitoring.md)) |
| `POST`, `PUT /api/bgp` | Watch a prefix (`{ resource, label? }`, a prefix or an IP address); turn monitoring on or off (`{ enabled }`, admins only); set your own network (`{ homeAsns: [64500] }`) |
| `GET /api/bgp/lookup?resource=` | What watching an address or prefix would watch: the announced prefix that holds it, who announces it, and the announced prefixes around it |
| `GET`, `POST`, `PATCH`, `DELETE /api/bgp/:id` | One watched prefix in full, with every update and how your network reaches it; trace into it now from this server and each probe agent (`POST`); rename it (`{ label }`) or take how it is carried now as normal (`{ acceptNormal: true }`); stop watching it |
| `GET /api/scheduler/status` | Whether the scheduler is running and when each target is next due |
| `GET /api/health` | Whether the server is up; open even with sign-in on |
| `POST /api/auth/login`, `/register`, `/logout`; `GET /api/auth/status` | Signing in and out ([docs/security.md](docs/security.md)) |
| `POST /api/auth/password-reset` | A forgotten password: the primary account's code from the server log, or the code in a password link ([docs/security.md](docs/security.md#forgotten-password)) |
| `POST /api/auth/two-factor`, `/passkey` | The code after a password, and signing in with a passkey ([docs/security.md](docs/security.md#second-factors)) |
| `/api/security/…` | Sign-in switches, keys, accounts and their roles (`PATCH /api/security/users/:id`), another account's password or a password link for it (`…/users/:id/password`, `…/users/:id/link`), single sign-on, the activity record, and your own second factors (`/api/security/me`); signed in only, and most of it for admins ([docs/security.md](docs/security.md#roles)) |
| `GET /api/auth/sso/start`, `/callback` | Signing in with Authentik or another OpenID Connect provider |
| `POST /api/auth/sso/logout` | Where the provider says someone signed out there (back-channel logout) |
| `GET /api/version` | The version, commit and build time running, the same for the newest published image, and whether that is an update |
| `POST /api/mcp` | The MCP server an AI assistant connects to; `GET /api/mcp/info` says whether it asks for a token |

## Development

```bash
npm test                   # unit and integration tests
npm run typecheck
npm run lint
npm run build
npm run build:probe-agent  # the probe agent, as one bundled file
```

The tests use temporary SQLite files and a local HTTP server; nothing touches
the network or your real database.

Under `npm run dev` every page opens signed in as a `dev` admin account, so
sign-in never gets in the way while working on it. Set
`CLEARPING_DEV_USER=off` to see the dashboard as someone signed out. A
production build never does this.

Where files go and how they are named is in [docs/structure.md](docs/structure.md).

Built with Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4 and
SQLite.

## Documentation

- [docs/running.md](docs/running.md): running it, Docker, installing it as an app, upgrading, configuration
- [docs/automatic-probing.md](docs/automatic-probing.md): what each kind of probe measures, groups, comparisons, traceroute
- [docs/alerting.md](docs/alerting.md): alerts, and sending them with Apprise
- [docs/probe-agents.md](docs/probe-agents.md): probing targets from other machines, over a tailnet or the internet
- [docs/bgp-monitoring.md](docs/bgp-monitoring.md): watching your own prefixes in BGP, as RIPE RIS's route collectors see them
- [docs/mcp.md](docs/mcp.md): connecting an AI assistant, and the report for an ISP
- [docs/security.md](docs/security.md): sign-in, roles, single sign-on with Authentik, keys for scripts and assistants, and the activity record
- [docs/structure.md](docs/structure.md): for changing ClearPing: where files go, how they are named, and what may import what
