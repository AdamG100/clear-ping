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
