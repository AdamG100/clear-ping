# ClearPing

A self-hosted network path monitor in the spirit of Smokeping. It probes your
hosts on a schedule, keeps the history in a single SQLite file, and draws
latency as a spread rather than a single line, so a path that is merely slow
looks different from one that is unstable.

![A target's page: latency spread and packet loss over the last hour](docs/screenshots/target.jpg)

## What it does

- **Four kinds of probe.** ICMP ping, TCP connect, HTTP(S) request and DNS
  query. Paste a host, `host:port` or a URL and the right one is picked.
- **Latency as a distribution.** Each probe sends several packets; the chart
  shows where they clustered and how far the outliers reached, with packet loss
  on its own strip underneath.
- **IPv4 and IPv6.** A hostname can be probed over either family, or over both
  at once and charted as two lines.
- **Nested groups.** Arrange targets into groups inside groups, drag targets
  between them, and collapse a group to one trace for everything in it.
- **Comparison charts.** Put every target in a group on one chart to see
  whether a slowdown hit one of them or all of them.
- **Alerts.** One screen for all of them: make an alert, tick the targets it
  watches, and send it to Discord as an embed (with optional role and user
  mentions) or to any webhook as JSON.
- **Traceroute.** On demand, and automatically at the moment a loss alert
  fires, which is the only time the route through a failure can be captured.
- **Certificate expiry.** HTTPS targets record when their certificate runs
  out, and an alert can watch for it.
- **Phone to wall display.** The layout follows the screen, from a phone held
  upright to an ultrawide monitor, and it installs to a home screen as an app
  on Android and iOS.
- **Nothing else to run.** One process, one SQLite file, no external database.

## Screenshots

Everything in these is generated demo data.

A group on one chart, with one loss strip per target:

![Four targets in a group compared on one chart](docs/screenshots/group-comparison.jpg)

Alerts, each watching the targets ticked for it:

![The alerts screen, with one alert firing](docs/screenshots/alerts.jpg)

An alert being edited: the condition, where it is sent, and the targets:

![The alert editor, set to post to Discord](docs/screenshots/alert-editor.jpg)

## Quick start

### Docker

```bash
docker run -d --name clearping -p 3000:3000 -v clearping-data:/data ghcr.io/adamg100/clear-ping:latest
```

Then open <http://localhost:3000>. The image contains the web app, the probe
scheduler, `ping` and `traceroute`.

Keep the volume: the database lives at `/data/clearping.db`, and without a
volume the history goes when the container does.

For Compose, [compose.example.yaml](compose.example.yaml) runs the same image
behind Traefik. Copy it to `compose.yaml` and change the hostname and network
to yours.

### From source

Needs Node.js 20.9 or newer, and `ping` and `traceroute` (`tracert` on Windows)
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

**Add Target** at the bottom of the sidebar. The address box takes a hostname,
an IP address, `host:port` or a URL, and chooses the probe to match; the rest of
the form has defaults. A target is probed every five minutes unless you change
its interval.

Each row in the sidebar shows the target's state, its address and a trace of
its recent readings. Hovering a row reveals pause, edit and delete; on a
touchscreen they are behind the ⋮ button at the end of the row.

On a wide screen the button at the top of the sidebar collapses it to a rail
of icons, to give the page its width, and the same button on the rail brings
it back. The rail keeps one tile for each top-level group, lit by the state of
everything inside it (red if anything in the group is down), along with the
alerts count; clicking a tile opens that group's comparison chart. The choice
is remembered. On a phone or a narrow window the sidebar is a drawer, opened
by the ☰ button at the top left. Tapping a chart shows the reading at that point, and dragging
sideways across it zooms in.

A **paused** target is not probed. Its row and its status light go grey, its
page stops passing judgement on readings nobody has taken since, and it is
counted as paused rather than as online or offline. Its history is kept.

### Groups

A target's group is chosen when it is added or edited. Typing a new group name
with a `/` in it nests it: `Home/Network` is a group `Network` inside a group
`Home`.

- Drag a target by its handle onto any group, at any depth.
- Drag a group by its handle to reorder it among its neighbours.
- The pencil on a group's header renames it or moves it inside another group,
  taking everything in it along.
- Collapse a group and it shows one trace for the whole group: the mean
  latency of its targets, marked wherever any of them lost packets.
- **Compare** on a group's header puts all its targets, including those in the
  groups inside it, on one chart.

A group exists while there is a target somewhere in it; move the last one out
and it is gone.

### Alerts

**Alerts** at the bottom of the sidebar opens the alerts screen, and shows how
many are firing.

An alert is a condition (stops responding, loss above a threshold, latency,
jitter, or a certificate about to expire), a number of probes in a row it must
hold for, somewhere to send it, and the targets it watches. Tick single targets
or whole groups. Each ticked target fires and clears on its own.

Where it is sent is chosen on the alert:

- **Discord**: paste a Discord webhook URL. Each change is posted as an embed,
  red when the alert fires and green when it clears. Role IDs and user IDs can
  be added, and are mentioned when the alert fires.
- **Webhook**: any other URL receives a JSON payload.
- **Only show it here**: nothing is sent.

**Send test** posts a sample message so a wrong URL or ID is found before it
matters. Details, the payload format and the finer points are in
[docs/alerting.md](docs/alerting.md).

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
| `CLEARPING_EXTERNAL_PROBER` | unset | `1` stops the web app scheduling probes, for when `npm run probe` runs as its own process |

## API

Everything the interface does goes through these.

| | |
|---|---|
| `GET /api/targets` | Every target; `?packetLoss=true` adds latest readings, recent traces and group order |
| `POST /api/targets` | Add a target |
| `GET`, `PATCH`, `DELETE /api/targets/:id` | Read, change (including pause and group) or delete one |
| `POST /api/targets/:id/probe` | Probe it now |
| `GET /api/targets/:id/measurements` | Its readings, bucketed for a chart (`?hours=` or `?start=&end=`) |
| `GET`, `POST /api/targets/:id/traceroute` | Its saved routes; trace it now |
| `PUT /api/targets/reorder` | Save the order of targets or of groups |
| `PUT /api/groups` | Rename a group or move it inside another (`{ from, to }`) |
| `GET /api/compare` | The same period of several targets (`?targets=id,id`) |
| `GET`, `POST /api/alerts` | Every alert; make one |
| `PATCH`, `DELETE /api/alerts/:id` | Change or delete one |
| `POST /api/alerts/:id/test` | Send its destination a test message |
| `GET /api/scheduler/status` | Whether the scheduler is running and when each target is next due |

## Development

```bash
npm test            # unit and integration tests
npm run typecheck
npm run lint
npm run build
```

The tests use temporary SQLite files and a local HTTP server; nothing touches
the network or your real database.

Built with Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4 and
SQLite.

## Documentation

- [docs/running.md](docs/running.md): running it, Docker, installing it as an app, upgrading, configuration
- [docs/automatic-probing.md](docs/automatic-probing.md): what each kind of probe measures, groups, comparisons, traceroute
- [docs/alerting.md](docs/alerting.md): alerts, Discord, webhooks
