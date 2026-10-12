# ClearPing Automatic Probe Scheduler

## Overview

ClearPing includes an automatic probe scheduler that works similarly to **Smokeping**. The scheduler automatically probes all active targets at their configured intervals, capturing measurements and storing them for visualization on the graphs.

## How It Works

### Automatic Probing

- When you create a target, you specify a **probe interval** (in seconds)
- The scheduler checks every 10 seconds for targets that need to be probed
- When a target's interval has elapsed, the scheduler automatically:
  1. Executes a probe (ICMP ping or DNS query)
  2. Captures the latency and packet loss
  3. Stores the measurement in the database
  4. Updates the last probe timestamp

### Example

If you set a target to probe every **300 seconds (5 minutes)**:
- The target will be probed automatically every 5 minutes
- Each probe sends 20 ICMP packets (configurable)
- The results are averaged and stored
- The graphs automatically update with new data

## Configuration

### Target Intervals

When creating or editing a target, you can set the probe interval:

```typescript
{
  name: "Google DNS",
  host: "8.8.8.8",
  probeType: "ping",
  interval: 300,  // Probe every 5 minutes (300 seconds)
  status: "active"
}
```

Common intervals:
- `60` - Every 1 minute (frequent monitoring)
- `300` - Every 5 minutes (default, like Smokeping)
- `600` - Every 10 minutes
- `3600` - Every 1 hour

### Ping Configuration

By default, each probe sends **20 pings**, spaced **10 ms** apart, with a **1 second
timeout** per packet. The defaults live in [src/lib/ping.ts](../src/lib/ping.ts):

```typescript
const DEFAULTS = { count: 20, timeout: 1000, interval: 10 };
```

## What Each Kind of Target Measures

The sidebar labels every target `IP`, `DOMAIN`, `TCP`, `HTTP` or `DNS`. The label is
derived from the address and the probe method, and each kind is measured differently:

| Target | Example | What a probe does |
|--------|---------|-------------------|
| **IP** | `1.1.1.1`, `2606:4700:4700::1111` | Pings the address directly with ICMP echo requests. |
| **Domain** | `example.com` | Resolves the name once, then sends every packet of that probe to the one address it returned. |
| **TCP** | `db.internal:5432` | Opens a connection to the port, times the handshake and closes it. 10 attempts per probe. |
| **HTTP** | `https://example.com/health` | Makes the request and checks the answer. 3 requests per probe, each on a fresh connection. |
| **DNS** (server) | `8.8.8.8` with the DNS method | Sends DNS queries straight to that server and times the answers. No ping. |
| **DNS** (name) | `example.com` with the DNS method | Looks the name up through the system resolver and times the answer. No ping. |

The address box accepts a URL or `host:port` and picks the method to match. Whatever
the method, the host is resolved once per probe and the resolved address is shown
next to the target, so the IPv4/IPv6 setting below applies to all of them.

### TCP

For hosts that drop ICMP, and for knowing a service is listening rather than merely
that the machine is up. "Loss" is the share of connection attempts that failed. The
error distinguishes a refused connection (nothing listening) from a timeout
(something dropping the packets).

### HTTP(S)

A response counts as a success when its status is the expected one — any 2xx or 3xx
by default, or exactly the status you set — and, if a keyword is set, the body
contains it. Redirects are not followed: a redirect is an answer from the server
being watched, and following it would measure a different server.

The time recorded is from starting the request to the first byte of the response.
The latest probe's time is also broken down into connect, TLS and server wait, and
for HTTPS the certificate's expiry date is recorded; both are shown above the chart.
An alert can be set on the certificate running out (see [alerting.md](./alerting.md)).

### DNS settings

A **server** target can be told what to ask: the name to look up (default
`example.com`) and the record type (A, AAAA, CNAME, MX, NS, TXT).

Either kind of DNS target can be given an **expected answer**. A reply then only
counts if it includes that value, which turns "does this server answer" into "does
my record still point where it should". TXT records match on a substring, so
`v=spf1` matches an SPF record; everything else must match a whole record.

Why a domain is resolved by the prober rather than handed to `ping`:

- **One address per probe.** `ping example.com` resolves the name again for each
  packet. A name with several records spreads one probe across different servers
  and reports the difference between them as jitter on a path that has none.
- **Resolution failures are reported as such.** A name that stops resolving is
  recorded as `DNS resolution failed …`, not as 100% packet loss with a generic
  error.
- **The address is visible.** The address the last probe measured is stored on the
  target and shown next to its name.

For DNS targets, "packet loss" is the share of queries that went unanswered. A
server replying "no such name" has still answered, so that counts as a success
when the target is a server; when the target is a name, failing to resolve is the
failure being watched for. A name target goes through the operating system's
resolver, cache included, so it measures what applications on this machine
experience rather than one upstream server.

### IPv4 and IPv6

An IP target uses the family of its address. Bracketed (`[2001:db8::1]`) and
scoped link-local (`fe80::1%eth0`) forms are accepted.

A target named by a hostname has an **IP version** setting, whatever it is probed
with (ping, TCP, HTTP or DNS):

| Setting | What is probed |
|---------|----------------|
| *Automatic* | Whichever address the system lists first, as a browser would use. |
| *IPv4 only* | The name's A record. |
| *IPv6 only* | The name's AAAA record. |
| *Both* | Each of them, every time, kept as two separate series. |

A name with no record of a pinned family reports
`no IPv6 address (AAAA record) for …` rather than silently falling back.

**Both** is for watching the two paths to one host side by side. Every round runs
the probe once over IPv4 and once over IPv6 and stores a reading for each. The
target's page opens on a chart with one line per family and has tabs for the full
readings of either one. In the sidebar the target counts as reachable if either
family answers, but its status dot takes the colour of the worse one, so a target
whose IPv6 has gone while IPv4 carries on does not look healthy. The alerts it is
ticked for are judged on the worse of the two readings in each round, and a
traceroute is taken over each family.

Each measurement records the family it was taken over (`measurements.family`, 4 or
6). Readings stored before that column existed are filed, the next time the
database is opened, under the family their target is probed over, so switching an
existing target to *Both* keeps its history on the right line.

On macOS, IPv6 pings go through `ping6`, which has no per-packet timeout flag; a
lost packet there is bounded by the prober's own process timeout instead.

## Groups

Targets are arranged into groups in the sidebar, and a group can sit inside
another to any depth: `Home`, with `Network` inside it, with `Wireless` inside
that.

- **Making one.** A target's group is chosen when it is added or edited. Pick an
  existing group, or type a new one. A `/` in a new group's name puts it inside
  another: `Home/Network` is a group `Network` inside a group `Home`, and both
  are made if they are not there.
- **Moving targets.** Drag a target by its handle onto any group, at any depth,
  or onto *Ungrouped* to take it out of its group.
- **Renaming and moving groups.** The pencil on a group's header renames it or
  puts it inside another group. Everything in it goes with it. Giving it the
  name of a group that already exists merges the two.
- **Ordering.** Drag a group by its handle to reorder it among the groups beside
  it.
- **Collapsing.** A collapsed group shows one trace for everything in it: the
  mean latency of its targets, marked wherever any of them lost packets. Paused
  targets are left out of it.

A group exists only while there is a target somewhere in it. There is nothing to
delete: move its last target out and it is gone.

A group's name cannot contain a `/`, since that is what separates a group from
the one inside it. Groups made before nesting existed whose names had one in
them become a group inside a group when the database is upgraded.

## Comparing Targets

Every group in the sidebar with two or more targets has a Compare button on its
header. It puts the whole group, including the groups inside it, on one chart,
the way a Smokeping multi-host graph does: one median line per target on a shared
time axis and latency scale, so it is plain whether a slowdown hit one of them or
all of them. Put four resolvers in a group and that is a query-time comparison of
the four.

- Under the lines there is a **loss strip per target**, in the same order as the
  legend, marking when each one lost packets (or failed requests, or queries).
- The **legend is a table**: for each line its latest reading and its median,
  average, minimum, maximum, loss and uptime over the period shown. Pointing at a
  row picks its line out; clicking the name opens that target's own page.
- Dragging across the chart zooms in, as on a single target's chart.
- A target set to *Both* IP versions contributes two lines, one per family.

Only the median is drawn. The latency spread that surrounds it on a single
target's chart would bury a dozen overlapping lines, and is one click away.

Groups can mix probe types, but a 400 ms HTTP check and a 2 ms ping share one
scale, so the ping will be a flat line at the bottom. Group like with like.

## Traceroute

The chart shows that packets were lost; a traceroute shows where. Each target has a
**Route** panel listing its recent traces hop by hop: name, address, loss and
latency, in the style of PingPlotter.

- **Trace route** runs one on demand.
- One is taken **automatically when a packet-loss or unreachable alert fires**, which
  is the only time the route through a failure can be captured. This needs an alert
  rule on the target; without one nothing triggers it.

Hop names come from reverse DNS and are looked up after the trace is stored, so the
route appears at once and the names fill in over the following seconds.

A hop that shows 100% loss while later hops answer is a router that forwards traffic
but will not reply to probes. It is labelled as such and is not the fault. The fault
is where replies stop and never resume.

Uses the system `tracert` (Windows) or `traceroute` (Linux, macOS), which must be
installed. Traces are kept for the same retention period as measurements.

## How Packet Loss Is Measured

A probe reports three separate numbers, and it matters that they are not conflated:

| Metric | Meaning |
|--------|---------|
| **Packet loss** | Of the packets this probe sent, the share that got no reply. |
| **Uptime** | Of the probes in a window, the share that got *at least one* reply. |
| **Jitter** | Mean absolute difference between *consecutive* round-trip times (RFC 3550 delay variation). |

A path that drops half its packets on every attempt has **50% packet loss and 100%
uptime**. Reporting only the second number — as a "failed probes / total probes"
calculation does — makes a badly degraded path look perfect.

Two deliberate choices keep the loss figure honest:

- **Every packet in a probe uses the same timeout.** Escalating the timeout partway
  through a run would make later packets more forgiving than earlier ones, so the
  result would depend on packet ordering rather than on the path.
- **Lost packets are not retried.** A retry hides exactly the loss the probe exists
  to measure.

If a probe hits its overall deadline, the packets it never sent are excluded from
both the numerator and the denominator rather than being scored as loss.

## Scheduler Management

### Automatic Startup

The scheduler starts when the server boots, via Next's `register()` hook in
[src/instrumentation.ts](../src/instrumentation.ts).

It used to start lazily on the first API request, which meant no probing
happened until somebody opened the page — close the tab, restart the server,
and monitoring was silently dead until the next visit.

For a deployment you actually depend on, run the prober as a separate process
instead; see [running.md](./running.md).

### API Endpoints

#### Get Scheduler Status
```
GET /api/scheduler/status
```

Returns information about:
- Whether the scheduler is running
- Number of active targets
- Next probe time for each target
- Current probing status

#### Start Scheduler Manually
```
POST /api/scheduler/start
```

Manually starts the scheduler (useful if it was stopped).

### Monitoring

`GET /api/scheduler/status` reports whether the scheduler is running, how many
targets it has scheduled, and when each is next due.

For being told when something breaks rather than having to look, make an alert
on the Alerts screen and tick the targets it should watch. See
[alerting.md](./alerting.md).

## Data Storage

### Database Schema

Measurements are stored in SQLite with the following structure:

```sql
CREATE TABLE measurements (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  latency REAL,
  packet_loss REAL DEFAULT 0,
  jitter REAL,
  success INTEGER NOT NULL,
  error_message TEXT,
  details TEXT,  -- JSON: HTTP status and timings, certificate expiry, DNS answer
  family INTEGER,  -- 4 or 6: the address family the probe ran over
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
);
```

Per-probe settings (port, URL path, expected status, DNS query) are stored as JSON in
`targets.probe_config`, so a probe that needs a new setting does not need a new
column.

A target's group is stored as a path in `targets.group_name`, such as
`Home/Network`; the tree in the sidebar is read off those paths.

The schema is brought up to date automatically whenever the database is opened by
a newer version; see [Upgrading](./running.md#upgrading).

`targets.probe_type` used to carry a `CHECK` constraint listing its allowed
values. SQLite cannot alter a `CHECK`, so on first start after upgrading from a
version that old the table is rebuilt without it (the API validates the value
instead). The rebuild keeps every row, and a snapshot of the database is written
next to it first as `clearping.db.before-probe-types-<timestamp>.bak`. Once you are
satisfied with the upgrade that file can be deleted.

`PRAGMA foreign_keys = ON` is set at startup — without it SQLite ignores the
`ON DELETE CASCADE` above and deleting a target leaves its measurements behind.

### Data Retention

The scheduler runs retention at startup and every six hours, keeping 90 days by
default. Set `CLEARPING_RETENTION_DAYS` to change it, or `0` to keep everything.

This matters more than it sounds: six targets on a five-minute interval produce
roughly 630,000 rows a year.

## Performance Considerations

### Resource Usage

- Each probe sends 20 ICMP packets (a fully unreachable host takes ~20 seconds,
  since every packet must wait out its timeout)
- Ping targets due in the same tick are probed concurrently, up to 8 at a time
- A target already being probed is skipped rather than probed twice
- Database writes are batched for efficiency
- The scheduler uses minimal CPU when idle

### Scalability

The current implementation can handle:
- ✅ Up to 50 targets without issues
- ✅ Intervals as low as 60 seconds
- ⚠️ For 100+ targets, consider adjusting the check interval

### Best Practices

1. **Use appropriate intervals**: Don't probe more frequently than needed
2. **Monitor packet loss**: High packet loss may indicate aggressive probing
3. **Pick the probe for the question**: ping measures the path to a host; a DNS probe measures a resolver, and says nothing about whether the host behind a name is reachable

## Troubleshooting

### Scheduler Not Running

Check the status endpoint:
```bash
curl http://localhost:3000/api/scheduler/status
```

If not running, start it manually:
```bash
curl -X POST http://localhost:3000/api/scheduler/start
```

### No Measurements Appearing

1. Check target status (must be "active")
2. Verify the interval has elapsed since last probe
3. Check server logs for errors
4. Ensure proper network connectivity

### High Packet Loss

If you're seeing unexpected packet loss:
1. Reduce probe frequency (increase interval)
2. Decrease ping count from 20 to 10
3. Check network conditions
4. Verify target host is accessible

## Comparison to Smokeping

| Feature | ClearPing | Smokeping |
|---------|-----------|-----------|
| Default Interval | 300s | 300s |
| Pings per Probe | 20 | 20 |
| Probe Types | ICMP, TCP, HTTP(S), DNS | ICMP, DNS, HTTP, etc. |
| IPv4 / IPv6 | Per target: either, or both side by side | Separate probes (FPing, FPing6) |
| Multi-host graphs | Any sidebar group | Configured per graph |
| Storage | SQLite | RRD files |
| UI | React/Next.js | CGI/Perl |
| Real-time Updates | Yes | Limited |

## Code Structure

```
src/
├── instrumentation.ts      # Server startup hook (starts the scheduler)
├── lib/
│   ├── scheduler.ts        # Probe scheduling and retention
│   ├── init.ts             # Server initialization
│   ├── ping.ts             # ICMP probe (process handling)
│   ├── ping-parse.ts       # ICMP output parsing (platform-specific, tested)
│   ├── tcp.ts              # TCP connect probe
│   ├── http-probe.ts       # HTTP(S) probe, including certificate expiry
│   ├── dns.ts              # DNS probe
│   ├── probe.ts            # Runs a target's probe, once per address family
│   ├── probe-result.ts     # Loss, latency and jitter from a probe's samples
│   ├── probe-config.ts     # Per-probe settings: parsing and validation
│   ├── host.ts             # Address classification (IPv4, IPv6, hostname)
│   ├── resolve.ts          # Name resolution for domain targets
│   ├── traceroute.ts       # Running and storing traceroutes
│   ├── traceroute-parse.ts # Traceroute output parsing (platform-specific, tested)
│   ├── alerts.ts           # Alerts: storage, judging a probe, delivery
│   ├── alert-delivery.ts   # What an alert says, and the notification URLs it is sent to
│   ├── apprise.ts          # Sending a notification, by running Apprise
│   ├── group-path.ts       # Nested groups as paths
│   ├── migrations.ts       # Schema changes applied when the database is opened
│   ├── metrics.ts          # Shared statistics (median, jitter)
│   ├── series.ts           # Chart series and gap detection
│   └── database.ts         # Database operations
scripts/
└── prober.ts               # Standalone probe runner (npm run probe)
└── app/
    ├── api/
    │   ├── scheduler/
    │   │   ├── status/route.ts    # Status endpoint
    │   │   └── start/route.ts     # Start endpoint
    │   └── targets/
    │       └── [id]/
    │           └── probe/route.ts  # Manual probe endpoint
    └── _components/
        └── monitoring/
            └── scheduler-status.tsx  # Status UI component
```

## Future Enhancements

Potential improvements:
- [ ] Web UI for configuring probe intervals
- [ ] Multiple probe schedules per target
- [ ] Distributed probing from multiple locations
- [ ] Export data to Prometheus/Grafana
- [ ] RRD-style data aggregation for long-term storage
