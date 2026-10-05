# Running ClearPing

## Single process (simplest)

```bash
npm run dev      # or: npm run build && npm start
```

The probe scheduler starts with the server via `src/instrumentation.ts`, so
probing begins at boot rather than waiting for someone to open the page.

## Separate prober (recommended for anything you rely on)

Run the prober as its own process and point the web app at the same database:

```bash
# terminal 1 — measures continuously, no browser required
npm run probe

# terminal 2 — UI only
CLEARPING_EXTERNAL_PROBER=1 npm run dev
```

Why bother:

- **Probing survives the UI.** Restarting, rebuilding or crashing the web app
  no longer creates a hole in your data.
- **No shared event loop.** Probe timing is not perturbed by request handling.
- **The web app can scale.** Several Next.js workers can serve the UI without
  each one starting its own scheduler and multiplying the probe rate.

Both processes open the same SQLite file. WAL mode is enabled, so the prober
writes while the UI reads without either blocking the other.

## Docker

The image runs the web app and the scheduler in one container, with `ping` and
`traceroute` installed.

```bash
# from the repository root
docker build -f docker/Dockerfile -t clearping .
docker run -d --name clearping -p 3000:3000 -v clearping-data:/data clearping
```

Or pull the one GitHub builds on every push to `main`
(`.github/workflows/docker.yml`):

```bash
docker run -d --name clearping -p 3000:3000 -v clearping-data:/data ghcr.io/adamg100/clear-ping:latest
```

- **Keep the volume.** The database is at `/data/clearping.db`. Without `-v`,
  the measurement history is lost when the container is removed.
- **IPv6 needs IPv6 in the container.** Docker's default network is IPv4 only,
  so IPv6 targets, and the IPv6 half of a target set to *Both*, fail there.
  Either enable IPv6 for the Docker network, or on Linux run the container with
  `--network host`.
- **Latency is measured from inside the container.** With the default bridge
  network that adds a small, constant amount to every reading; `--network host`
  removes it.
- The settings in the table below are passed with `-e`, for example
  `-e CLEARPING_RETENTION_DAYS=30`.

## Configuration

See `.env.example`. All settings are optional.

| Variable | Default | Purpose |
|---|---|---|
| `CLEARPING_DB_PATH` | `./data/clearping.db` | Database location |
| `CLEARPING_RETENTION_DAYS` | `90` | Measurement retention; `0` keeps everything |
| `CLEARPING_EXTERNAL_PROBER` | unset | `1` stops the web app scheduling probes |

## Development

```bash
npm test          # unit and integration tests
npm run typecheck
npm run lint
```

The tests cover the parts where a silent mistake is most costly: `ping` output
parsing for all three platforms, the statistics queries, the chart series
builder, and the alert state machine. They use a temporary SQLite file and a
local HTTP server; nothing touches the network or your real database.
