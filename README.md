# ClearPing

A self-hosted network monitor in the spirit of Smokeping. It measures your
hosts, websites, DNS and game servers on a schedule, from your own network and
from probe agents anywhere else, keeps the history in a single SQLite file, and
draws latency as a spread rather than a single line, so a path that is merely
slow looks different from one that is unstable.

[![Latest release](https://img.shields.io/github/v/release/AdamG100/clear-ping)](https://github.com/AdamG100/clear-ping/releases)
[![Docker image](https://img.shields.io/badge/image-ghcr.io%2Fadamg100%2Fclear--ping-blue)](https://github.com/AdamG100/clear-ping/pkgs/container/clear-ping)

![The overview: one monitor not answering, a probe agent offline, and the last 24 hours](docs/screenshots/overview.jpg)

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [First steps](#first-steps)
- [Screenshots](#screenshots)
- [Using it](#using-it)
- [Upgrading](#upgrading)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Contributing](#contributing)

## What it does

- **Six kinds of check.** ICMP ping, ARP, TCP connect, game server query,
  HTTP(S) request and DNS lookup. Paste a host, `host:port` or a URL and the
  right one is picked.
- **Latency as a distribution.** Each reading sends several packets; the chart
  shows where they clustered and how far the outliers reached, with packet loss
  on its own strip underneath. A spike to a second among 20 ms readings gets a
  band of its own along the top instead of flattening the rest.
- **An overview.** What is wrong right now, how the last 24 hours went, and
  every monitor that had trouble, with where the fault probably lay: only that
  monitor, your own network, or out on the internet.
- **Measure from anywhere.** A probe agent is a small program on another
  machine, such as a VPS in another country, that takes readings from there.
  The dashboard connects to it over an encrypted, pinned link, through a
  tailnet or the internet.
- **Game servers.** Steam's server query (CS2, Rust, ARK, Valheim…),
  Minecraft Java and Bedrock, and FiveM, with the server's name, map and
  players. For games that answer no query, such as Call of Duty, it times the
  server's replies to a closed port instead. **Game Server Ping** pings a
  game's regions (Valve's relays, Epic's endpoints, Amazon GameLift's beacons)
  from every probe at once.
- **DNS through several resolvers.** Ask Cloudflare, Google, Quad9 or your own
  resolver, over plain DNS, DNS over TLS or DNS over HTTPS, and see what each
  answered and how fast.
- **Packet loss analysis.** Whether loss is sporadic, in bursts or sustained,
  the hour of day it peaks, which other monitors lost packets at the same time,
  and the likely source: your local network, your ISP, or the monitor's path.
- **Alerts** to anything [Apprise](https://github.com/caronc/apprise) can
  notify: Discord, Slack, Telegram, email, ntfy, webhooks and over a hundred
  more. An alert can trace the route at the moment it fires, which is often
  the only time a broken path can be seen.
- **Routing.** Watch your own IP prefixes in BGP, as RIPE RIS's route
  collectors see them, and be told when the way the world reaches them changes.
- **IPv4 and IPv6**, nested groups, comparison charts, certificate expiry,
  traceroute on demand, and share links that copy monitors from one ClearPing
  to another.
- **Accounts and roles.** Admins, editors and viewers; authenticator apps and
  passkeys; single sign-on through any OpenID Connect provider such as
  Authentik; and API keys for scripts and assistants.
- **Ask an AI assistant.** ClearPing is an MCP server. Give Claude, or any
  assistant that speaks MCP, its address and ask "gather the logs so I can
  report this to my ISP".
- **Privacy.** Hide IP addresses and host names on screen, from viewers or
  from everyone, and from AI assistants.
- **Phone to wall display.** The layout follows the screen, and it installs to
  a home screen as an app on Android and iOS.
- **Nothing else to run.** One container, one SQLite file, no external
  database. Images for x64 and 64-bit ARM (Raspberry Pi 4 and 5).

## Quick start

### Docker

```bash
docker run -d --name clearping --restart unless-stopped \
  -p 3000:3000 -v clearping-data:/data \
  ghcr.io/adamg100/clear-ping:latest
```

Open `http://<this machine>:3000`. The image has everything ClearPing uses:
the dashboard, the scheduler that takes readings, `ping`, `traceroute` and
Apprise. Keep the volume: the database lives at `/data/clearping.db`, and
without a volume the history goes when the container does.

### Docker Compose

```bash
curl -o compose.yaml https://raw.githubusercontent.com/AdamG100/clear-ping/main/compose.example.yaml
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d
```

[compose.example.yaml](compose.example.yaml) publishes port 3000 and keeps the
database in `./data`. The container runs as uid 1000, which is why the folder
is handed over first.

### Behind a reverse proxy

To reach ClearPing from outside your network, or install it as an app, serve
it over HTTPS. [docs/reverse-proxy.md](docs/reverse-proxy.md) has it step by
step for **Caddy**, **nginx** (and Nginx Proxy Manager), **Traefik**,
**Cloudflare Tunnel** and **Tailscale**. Whichever you use, set two things on
the container:

```yaml
CLEARPING_ALLOWED_HOSTS: ping.example.com   # the name it is reached at
CLEARPING_TRUST_PROXY: 1                    # one proxy in front
```

### Without Docker

Needs Node.js 26.12.1 or newer, and `ping` and `traceroute` (`tracert` on
Windows) on the machine.

```bash
git clone https://github.com/AdamG100/clear-ping.git
cd clear-ping
npm install
npm run build
npm start
```

For anything you rely on, run the scheduler as its own process so restarting
the dashboard leaves no gap in the readings; see
[docs/running.md](docs/running.md#separate-prober-recommended-for-anything-you-rely-on).
Alerts need Apprise: `pip install "apprise[all-plugins]"`.

## First steps

1. **Create the first account.** The dashboard asks for it the first time it
   is opened. Besides a password it asks for a setup code, so that whoever
   reaches a new install first cannot take it over:

   ```bash
   docker logs clearping 2>&1 | grep -i "setup code"
   ```

2. **Turn sign-in on** under Settings (the cog at the foot of the sidebar) →
   **Access**. Until then anyone who can reach ClearPing can use all of it,
   including the passwords in your alerts' notification URLs. If it never
   leaves your own network you can say so instead, and the prompt goes away.
3. **Add a monitor.** **Add monitor** at the foot of the sidebar: type an
   address and press Enter. Your router and something beyond it, such as
   `1.1.1.1`, are a good start: together they show whether a fault was inside
   your network or outside it.
4. **Make an alert.** **Alerts** → **New alert**, tick the monitors it
   watches, and paste where it should go, such as
   `discord://webhook_id/webhook_token`. **Send test** checks it.
5. **Measure from somewhere else** (optional). Settings → **Probes** → **Add
   probe agent** gives a Docker command or a one-line Linux install to run on
   another machine. See [docs/probe-agents.md](docs/probe-agents.md).

## Screenshots

Everything in these is made-up demo data.

| | |
|---|---|
| ![A monitor's page: median, loss and jitter, with the latency spread underneath](docs/screenshots/target.jpg) **A monitor**, measured from three probes | ![Four monitors on one chart over 24 hours, with the evening slowdown on every line](docs/screenshots/group-comparison.jpg) **A group compared** on one chart |
| ![A day of response times with one spike to over a second in a band along the top](docs/screenshots/spikes.jpg) **A spike** gets a band of its own | ![A CS2 server's page, with its name, players, map and version](docs/screenshots/game-server.jpg) **A game server** and what it says about itself |
| ![The add monitor page, in numbered sections](docs/screenshots/add-target.jpg) **Adding a monitor**: the address is all it needs | ![The probes settings: three probe agents, two online and one offline](docs/screenshots/probe-agents.jpg) **Probe agents** and how each is doing |
| ![The alerts screen, with one alert firing](docs/screenshots/alerts.jpg) **Alerts**, one firing | ![The alert editor](docs/screenshots/alert-editor.jpg) **An alert** being edited |
| ![The share dialog, with every monitor ticked](docs/screenshots/share.jpg) **Sharing** monitors as a link or a file | ![The accounts page, with an admin, an editor and two viewers](docs/screenshots/accounts.jpg) **Accounts** and their roles |
| ![The privacy settings](docs/screenshots/privacy.jpg) **Privacy**: what is shown, kept and asked | ![The maintenance settings, with the steps of a run and its schedule](docs/screenshots/maintenance.jpg) **Maintenance** and its schedule |

## Using it

### The sidebar

From the top: the name and version, with the theme and collapse buttons;
**Overview** and **Tools** (Routing and Game Server Ping); a search over names
and addresses, and a filter for one probe's monitors; how many monitors are
online, offline and paused; then the monitors in their groups. At the foot are
**Add monitor**, **Alerts** (with how many are firing), deleting several
monitors at once, sharing, and Settings.

Each row shows the monitor's state, its address and a trace of its recent
readings. Its badges say what it is (IP, DNS, TCP, HTTP, Game), and a pin with
a number marks one measured from several probes. The ⋯ button copies the
address, pauses, edits, duplicates or deletes it. On a phone the sidebar is a
drawer behind the ☰ button; tapping a chart shows the reading at that point,
and dragging across it zooms in.

### Monitors

**Add monitor** opens a page of numbered sections: the address, a name and
group, how it is checked and how often, and which probes measure it (the local
probe and any probe agents; tick several to compare them). The address box
takes a hostname, an IP address, `host:port` or a URL and picks the check to
match, so an address and Enter is a whole monitor. A monitor is measured every
five minutes unless you change it.

**Duplicate** opens the form filled in from an existing monitor, for the
second port on a host or the same check against the next server. A **paused**
monitor is not measured; its history is kept.

### Groups

**New group** at the foot of the list makes a group. Groups nest to any depth;
drag a monitor by its handle onto any of them. Collapse a group and it shows one
trace for all of it. **Compare** on a group's header puts all its monitors on
one chart, to see whether a slowdown hit one of them or all of them.

### Sharing

The share button makes a link, or a JSON file, out of the monitors you tick.
Someone else pastes the link, or chooses the file, in their own ClearPing and
picks which to add. Nothing is stored for it and the two never talk to each
other, so it works between home networks. It carries each monitor's name,
address, settings and group, never its history or your alerts. The file
doubles as a backup of what you monitor.

### Alerts

An alert is a condition (stops responding, loss, latency, jitter, or a
certificate about to expire), how many readings in a row it must hold for,
where it is sent, and the monitors it watches. Each monitor fires and clears on
its own. Where it is sent is a list of [Apprise](https://github.com/caronc/apprise)
URLs:

```
discord://webhook_id/webhook_token
tgram://bot_token/chat_id
mailtos://user:password@smtp.example.com?to=oncall@example.com
ntfys://ntfy.sh/your-topic
jsons://hooks.example.com/my-endpoint
```

See [docs/alerting.md](docs/alerting.md).

### Probe agents

A probe agent is a small program on another machine that takes readings from
there for your dashboard (it is nothing to do with AI agents). Add one under
**Settings → Probes**, start it with the Docker command or the Linux install
line shown there, and tick it under **Probes** on any monitor. The dashboard
connects to the probe agent, encrypted and pinned to its own certificate, with a
token for each. Over a tailnet such as Tailscale no port has to be opened. While
one cannot be reached its monitors take no readings from there, so a dead
probe agent never looks like monitors being down. See
[docs/probe-agents.md](docs/probe-agents.md).

### Routing

**Tools → Routing** watches IP prefixes in BGP, for networks that announce
their own address space or anyone who wants to know when the way to a server
moves. It is off until an admin turns it on under **Settings → Routing**, and
until then ClearPing asks nothing of RIPE or PeeringDB. See
[docs/bgp-monitoring.md](docs/bgp-monitoring.md).

### Settings

- **Security**: **Access** (whether sign-in is required, whether changing
  things needs sign-in or a key, and which other websites may call the API),
  **Sign-in** (your own password and second factors), **Keys**, **Single
  sign-on**, **Accounts** and **Privacy**.
- **Monitoring**: **Probes** (the local probe and probe agents), **Routing**
  and **Maintenance**.
- **More**: **Activity** (a record of every change and who made it) and **AI
  assistant**.

An admin sees every section; editors and viewers see only their own sign-in and
keys. See [docs/security.md](docs/security.md).

### An AI assistant

**Settings → AI assistant** gives the address to hand to an assistant. For
Claude Code that is one command:

```bash
claude mcp add --transport http clearping http://your-clearping:3000/api/mcp
```

Then ask it in your own words: *gather the logs from the last week so I can
report this to my ISP, as a PDF*, or *is my connection worse in the evenings?*
As it comes it can only read. Give it a key that may read and write and it can
also add, change and pause monitors, though never delete one. See
[docs/mcp.md](docs/mcp.md).

## Upgrading

```bash
docker compose pull && docker compose up -d
```

or, with `docker run`, pull the image, remove the container and run the same
command again. The database is brought up to date by itself when the new
version starts, and history is kept. When a newer version is out, a notice at
the top of the sidebar says so; the version beside the name opens the **patch
notes**. Details, and going back to an older version, are in
[docs/running.md](docs/running.md#upgrading).

## Configuration

All optional. With Docker, pass them with `-e` or under `environment:`.

| Variable | Default | Purpose |
|---|---|---|
| `TZ` | unset (each viewer's own) | The time zone every time is shown in, as an IANA name such as `Europe/London`: charts, tables, alerts and when maintenance runs. Unset, the page shows each person their own time and the server keeps UTC |
| `CLEARPING_ALLOWED_HOSTS` | unset | Comma-separated hostnames ClearPing answers to, such as `ping.example.com`; a request for another name is refused. Unset, IP addresses, `localhost` and private names are answered, and a public domain only with sign-in on ([security.md](docs/security.md#before-anyone-can-reach-it)) |
| `CLEARPING_TRUST_PROXY` | `0` | How many reverse proxies in front of ClearPing add to `X-Forwarded-For` (`1` for one). Without it the header is ignored ([reverse-proxy.md](docs/reverse-proxy.md)) |
| `CLEARPING_DB_PATH` | `./data/clearping.db` (`/data/clearping.db` in the image) | Where the database is kept |
| `CLEARPING_RETENTION_DAYS` | `90` | Days of readings to keep; `0` keeps everything |
| `CLEARPING_SETUP_CODE` | made at start-up, written to the log | What the first account asks for besides a password. Set it yourself to skip reading the log |
| `CLEARPING_AUTH` | unset | `off` turns sign-in off whatever the dashboard says and lets a new account be made: for getting back in after a lost password ([security.md](docs/security.md#locked-out)) |
| `BETTER_AUTH_SECRET` | made and kept in the database | What sign-in cookies are signed with. Set it to keep sessions across a replaced database |
| `CLEARPING_EXTERNAL_PROBER` | unset | `1` stops the dashboard scheduling readings, for when `npm run probe` runs as its own process |
| `CLEARPING_LOG_READINGS` | unset | `1` logs every reading; otherwise only those that lost something |
| `CLEARPING_MCP_ALLOW_HTTP` | unset | `1` takes an assistant's key over plain HTTP from anywhere, for when a VPN or tunnel does the encrypting ([mcp.md](docs/mcp.md)) |
| `CLEARPING_MCP_TOKEN` | unset | The single assistant token from before keys were made in the dashboard. Still works; keys made in Settings are better |
| `CLEARPING_PEERINGDB_API_KEY` | unset | A PeeringDB API key for Routing. Rarely needed ([bgp-monitoring.md](docs/bgp-monitoring.md)) |
| `CLEARPING_UPDATE_CHECK` | on | `off` stops the check for a newer image (also Settings → Privacy) |
| `CLEARPING_APPRISE_BIN` | `apprise` | The Apprise program that sends alerts, when it is not on the `PATH` |
| `CLEARPING_DEV_USER` | unset | `off` stops `npm run dev` signing every page in as a `dev` admin |

## Documentation

- [docs/overview.md](docs/overview.md): the Overview, and how it tells where a fault lay
- [docs/running.md](docs/running.md): running it, Docker, installing it as an app, maintenance, versions and upgrading
- [docs/reverse-proxy.md](docs/reverse-proxy.md): HTTPS with Caddy, nginx, Traefik, Cloudflare Tunnel or Tailscale
- [docs/automatic-probing.md](docs/automatic-probing.md): what each kind of check measures, groups, comparisons, traceroute
- [docs/alerting.md](docs/alerting.md): alerts, and sending them with Apprise
- [docs/probe-agents.md](docs/probe-agents.md): measuring from other machines, over a tailnet or the internet
- [docs/game-server-ping.md](docs/game-server-ping.md): a game's regions pinged from every probe
- [docs/bgp-monitoring.md](docs/bgp-monitoring.md): watching your prefixes in BGP
- [docs/mcp.md](docs/mcp.md): connecting an AI assistant, and the report for an ISP
- [docs/security.md](docs/security.md): sign-in, roles, single sign-on, keys and the activity record
- [docs/api.md](docs/api.md): the HTTP API
- [docs/structure.md](docs/structure.md): for changing ClearPing: where files go and how they are named

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
says how to run it from source, run the tests, and write a commit message
that becomes a good patch note.

Built with Next.js, React, TypeScript, Tailwind CSS, SQLite and
[Better Auth](https://www.better-auth.com), with
[Arc UI](https://uiarc.dev) components.
