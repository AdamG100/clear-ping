# ClearICMP Automatic Probe Scheduler

## Overview

ClearICMP now includes an automatic probe scheduler that works similarly to **SmokeICMP**. The scheduler automatically probes all active targets at their configured intervals, capturing measurements and storing them for visualization on the graphs.

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

For being told when something breaks rather than having to look, add an alert
rule from the target's Alerts panel — see [alerting.md](./alerting.md).

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
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
);
```

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
3. **Use DNS for domains**: DNS probing is lighter than ping

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
| Probe Types | ICMP, DNS | ICMP, DNS, HTTP, etc. |
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
│   ├── dns.ts              # DNS probe
│   ├── alerts.ts           # Threshold rules and webhook dispatch
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
- [ ] Alert system for downtime/high latency
- [ ] Multiple probe schedules per target
- [ ] Distributed probing from multiple locations
- [ ] Export data to Prometheus/Grafana
- [ ] RRD-style data aggregation for long-term storage
