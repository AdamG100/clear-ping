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

That image is published for x64 and for 64-bit ARM (a Raspberry Pi 4 or 5 on a
64-bit OS, an ARM cloud server, Apple silicon), and Docker pulls the one that
matches the machine. 32-bit ARM is not supported.

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

`compose.example.yaml` in the repository root is the same thing as a Compose
file, set up to sit behind Traefik. Copy it to `compose.yaml` and change the
hostname and network to yours.

## Upgrading

Pull the new image and recreate the container. Nothing else is needed:

```bash
docker pull ghcr.io/adamg100/clear-ping:latest
docker rm -f clearping
docker run -d --name clearping -p 3000:3000 -v clearping-data:/data ghcr.io/adamg100/clear-ping:latest
```

or, with Compose, `docker compose pull && docker compose up -d`.

The database stays where it is, in the volume or the directory mounted at
`/data`, and the new version brings it up to date when it starts. Running from
source is the same: pull, install, start.

How that works, for when it matters:

- **It happens at start, before anything is probed or served.** The database
  records which changes it has had (`PRAGMA user_version`), and every change
  newer than that is applied once, in order. The log says which:
  `Database: applied migration 2 (shared alerts)`.
- **Each change is all or nothing.** It runs inside a transaction. If one
  fails, the database is left exactly as it was and the app stops with the
  error, rather than running against a database in a shape it does not expect.
- **Measurement history is never rewritten by an upgrade.** The one upgrade
  that has to rebuild a table (very old databases, from before TCP and HTTP
  probes) first saves a copy next to the database, named
  `clearping.db.before-probe-types-<time>.bak`.
- **With a separate prober**, both processes open the same file and either may
  get there first. The other waits for it and finds nothing left to do.
- **Going back to an older image** works: it starts, and logs that the
  database is newer than it understands. It will not see things that only
  exist in the newer shape. Alerts made on the Alerts screen are an example:
  an image from before that screen looks for alerts where they used to be
  kept, and finds the ones you had then.

For anyone changing the schema: add a function to the list at the bottom of
`src/lib/migrations.ts`. Entries already in the list are never edited, since
databases that have run them will not run them again.
`src/lib/database-migration.test.ts` opens a database in the oldest shape there
is and checks that everything survives the trip to the newest.

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
