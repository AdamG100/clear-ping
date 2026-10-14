# Running ClearPing

## Single process (simplest)

```bash
npm run dev      # or: npm run build && npm start
```

The probe scheduler starts with the server via `src/instrumentation.ts`, so
probing begins at boot rather than waiting for someone to open the page.

Alerts are sent by [Apprise](https://github.com/caronc/apprise), a Python
program that has to be installed for any to go out:

```bash
pip install "apprise[all-plugins]"
```

If that leaves `apprise` somewhere that is not on the `PATH`, point
`CLEARPING_APPRISE_BIN` at it. Everything else works without it, and the Docker
image comes with it. See [alerting.md](alerting.md).

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

The image runs the web app and the scheduler in one container, with `ping`,
`traceroute` and Apprise installed.

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

## Installing it as an app

ClearPing can be installed to a phone's home screen, or as a desktop app, and
then opens in a window of its own without the browser around it.

On a phone or tablet it offers this itself, in a card along the bottom of the
screen, the first time it is opened. Dismissed, the card does not come back on
that device; the browser's own menu still installs it:

- **Android (Chrome):** the card's *Install* button, or menu → *Add to Home
  screen* → *Install*.
- **iPhone and iPad (Safari):** *Share* → *Add to Home Screen*. iOS gives a
  page no way to do this for you, so there the card says where to tap.
- **Desktop (Chrome, Edge):** the install icon at the end of the address bar.
  No card is shown.

**Android and desktop need HTTPS.** Browsers only offer to install a site, and
only run the part that works offline, on a secure address: `https://`, or
`localhost` on the machine itself. Reached as `http://192.168.1.10:3000` the
app works exactly as it does in a tab, but there is no *Install*, only a plain
shortcut, and on Android the card says so instead of offering. Put it behind a reverse proxy with a certificate
(`compose.example.yaml` does this with Traefik) or a tunnel that provides one.
iOS adds it to the home screen over plain HTTP as well.

Installed, the app still needs the server: every reading is fetched live, and
none are kept on the device. When the server cannot be reached it says so on a
page of its own, and reloads by itself once the server answers.

What makes it installable, for anyone changing it:

- `src/app/manifest.ts` is the name, colours and icons, served as
  `/manifest.webmanifest`.
- `public/icons/` holds the icons. The two `.svg` files are the drawings the
  `.png` files were made from; `icon-maskable` has the margin Android needs to
  crop it to the launcher's shape.
- `src/app/_components/install-prompt.tsx` is the card, and
  `use-install-prompt.ts` beside it decides whether there is anything to
  offer on the device in hand.
- `public/sw.js` is the service worker and `public/offline.html` the page it
  shows. It caches that page and nothing else, on purpose: a stored copy of
  the dashboard would show old readings as if they were current. It is only
  started in a production build.

## Versions

Every push to `main` that builds is a deployment with a number of its own,
`MAJOR.MINOR.PATCH`: one more than the last release. It is a patch unless a
commit going out asks for more, with a line at the end of its message:

```
Release: minor      something new a user would notice
Release: major      an upgrade that needs the user to do something
```

The biggest one asked for among the commits since the last release wins, so
several features pushed together still make one minor release. Nothing has to
be tagged or edited by hand; `node scripts/next-version.mjs --explain` says
what a push would come out as. `package.json`'s version is only a floor:
setting it higher makes that the next version. CI bakes the number
into the image, tags the image with it (`ghcr.io/adamg100/clear-ping:0.1.4`
beside `:latest`), and makes a GitHub release `v0.1.4` listing what changed.
To go back to an earlier one, run its tag instead of `:latest`.

The dashboard shows the version it is running under the ClearPing name in the
sidebar, and once an hour asks the registry what `:latest` is:

- a **green dot** is the latest version;
- an **amber dot** means a newer one has been published; it links to that
  release, and the tooltip says which;
- **reload** means the server has been updated while the page was open.

`GET /api/version` answers the same as JSON. The registry is asked without any
credentials, because the image is public. Set `CLEARPING_UPDATE_CHECK=off` to
never ask, and a build made by hand, not by CI, calls itself a development
build and is not compared with anything.

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
  kept, and finds the ones you had then. In the same way, an image from before
  alerts were sent by Apprise sends each alert where it was going at the time
  of the upgrade, and knows nothing of notification URLs added since.

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
| `CLEARPING_APPRISE_BIN` | `apprise` | The Apprise program that sends alerts, when it is not on the `PATH` |
| `CLEARPING_UPDATE_CHECK` | on | `off` stops the hourly check for a newer image (see [Versions](#versions)) |

## Development

```bash
npm test          # unit and integration tests
npm run typecheck
npm run lint
```

The tests cover the parts where a silent mistake is most costly: `ping` output
parsing for all three platforms, the statistics queries, the chart series
builder, and the alert state machine. They use a temporary SQLite file and a
local HTTP server; nothing touches the network or your real database. The tests
that send a notification through the real Apprise, to that local server, run
when Apprise is installed and are skipped when it is not.
