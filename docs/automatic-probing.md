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

By default, each probe sends **20 pings** with a **1 second timeout**. This can be adjusted in [src/lib/ping.ts](../src/lib/ping.ts):

```typescript
const { count = 20, timeout = 1000 } = options;
```

## Scheduler Management

### Automatic Startup

The scheduler starts automatically when the first API request is made to the server. This happens through the initialization system in [src/lib/init.ts](../src/lib/init.ts).

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

The dashboard includes a **Scheduler Status** component that shows:
- ✅ Active/Stopped status
- 📊 Number of scheduled targets
- ⏰ Time until next probe for each target
- 🔄 Currently probing targets (with spinner)
- 📅 Last probe time

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
  success INTEGER NOT NULL,
  error_message TEXT,
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
);
```

### Data Retention

By default, measurements are kept indefinitely. You can implement automatic cleanup using:

```typescript
import { cleanOldMeasurements } from '@/lib/database';

// Keep last 30 days
await cleanOldMeasurements(30);
```

## Performance Considerations

### Resource Usage

- Each probe sends 20 ICMP packets (takes ~20 seconds)
- Probes run sequentially (one at a time per target)
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
3. **Clean old data**: Implement data retention policies for large deployments
4. **Use DNS for domains**: DNS probing is lighter than ping

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
├── lib/
│   ├── scheduler.ts        # Main scheduler logic
│   ├── init.ts            # Server initialization
│   ├── ping.ts            # ICMP ping implementation
│   ├── dns.ts             # DNS probe implementation
│   └── database.ts        # Database operations
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
