# Where things go

How ClearPing's files are laid out, and the rules that keep them that way. Read
it before adding a file, and check a change against the list at the end.

The idea throughout: **a folder names a subject, and a file names one thing
within it.** Anyone looking for the DNS probe, an alert's wording or the
sidebar should be able to guess the path before searching for it.

## The top level

| Path | What it holds |
|------|---------------|
| `src/` | The dashboard: pages, API routes, and the code behind them. |
| `probe-agent/` | The probe agent's own program (its server, certificate, installer). It runs the probe code from `src/lib`. See [probe-agents.md](probe-agents.md). |
| `scripts/` | Programs run by hand or by CI: the probe agent build, version numbering, the standalone prober. A script's test sits beside it. |
| `docker/` | Dockerfiles, their `.dockerignore` files, and what the images install. |
| `docs/` | Guides for people running ClearPing, and this one. |
| `public/` | Files served as they are: icons, the service worker, the offline page. |
| `compose.example.yaml`, `compose.probe-agent.example.yaml` | At the top on purpose: the README tells people to download them by their URL. Do not move them. |
| `data/`, `dist/`, `.next/` | Made while running or building, never committed. |

Nothing else belongs at the top level besides the config files the tools
expect there (`package.json`, `tsconfig.json`, `next.config.ts`, the ESLint,
Vitest and PostCSS configs, `components.json`). An empty or unused folder is
removed, not kept "for later".

## `src/`

```
src/
├── app/              Next.js: pages, API routes, and the components only they use
│   ├── api/          API routes. A route's folder is its URL
│   ├── _components/  The dashboard's components, by area (below)
│   └── <page>/       A page, with any component only it uses beside page.tsx
├── components/       Shared UI: Arc components, and the few made on top of them
├── lib/              Everything that is not UI, by subject (below)
├── types/            Types shared by the dashboard, the API and the probe agent
├── instrumentation.ts
└── proxy.ts
```

### `src/lib/`

| Folder | Subject |
|--------|---------|
| `probes/` | Taking one reading: the probe of each kind (`ping.ts`, `tcp.ts`, `http.ts`, `dns.ts`, `game.ts`), what they share (`result.ts`, `config.ts`, `labels.ts`, `host.ts`, `resolve.ts`, `metrics.ts`) and the dispatcher (`probe.ts`). A probe with helpers of its own gets a folder beside its file: `dns/`, `game/`. |
| `networks/` | Who runs an address: the network that holds it and the exchange it is on (`lookup.ts`), for a monitor's page. |
| `traceroute/` | Running (`run.ts`), reading (`parse.ts`), keeping (`store.ts`) and exporting (`export.ts`) traceroutes. |
| `probe-agents/` | The dashboard's side of probe agents: the protocol both ends share (`protocol.ts`), talking to one (`client.ts`), keeping them (`store.ts`), and checking and installing one. |
| `alerts/` | Alerts and how targets stand against them (`store.ts`), what they say (`delivery.ts`), sending them (`apprise.ts`). |
| `bgp/` | BGP monitoring: following RIS Live (`ris-live.ts`) and asking RIPEstat (`ripestat.ts`), judging a prefix (`assess.ts`), learning what is normal for it (`learn.ts`), the monitor that runs it all (`monitor.ts`), keeping it (`store.ts`), how your networks reach a prefix, from this server and each probe agent (`home.ts`), when a route is flapping (`flapping.ts`), exchanges' peering LANs from PeeringDB (`exchanges.ts`), their members' addresses on them from IXPDB (`ixpdb.ts`), and the pure helpers the pages share (`prefix.ts`, `path.ts`, `collectors.ts`, `countries.ts`, and `scope.ts` for narrowing a prefix's page to a place or an upstream). |
| `db/` | The database: opening and querying it, migrations, maintenance. |
| `targets/` | Targets and groups as data: checking a new one, sharing, actions taken on several, group paths and health, the sidebar's layout. |
| `charts/` | Readings turned into what is drawn: series, ticks, colours. |
| `reports/` | Readings turned into words: outages, evidence for an ISP, where a target's loss is. |
| `mcp/` | The MCP server: the protocol and the tools. |
| `security/` | Sign-in and everything around it, all through Better Auth. |
| `privacy/` | Settings → Privacy (`settings.ts`, with what is in force held in memory in `current.ts`), hiding addresses (`mask.ts`, pure) and hiding them from AI assistants (`assistant.ts`). |
| `__fixtures__/` | Captured output that tests read: ping, traceroute and DNS messages. |

A few modules are about the app as a whole and sit directly in `lib/`:
`init.ts`, `scheduler.ts`, `version.ts`, `time-zone.ts`, `dashboard-pages.ts`,
`app-theme.ts`, `clipboard.ts`. `utils.ts` stays where it is because shadcn
installs Arc components that import it as `@/lib/utils`.

### `src/app/_components/`

| Folder | What is in it |
|--------|---------------|
| `shell/` | What wraps every page: theme, service worker, install prompt, session watcher, the logo. |
| `dashboard/` | The dashboard frame: the page itself, its top bar, panes, skeletons. |
| `sidebar/` | The sidebar and what opens from it: groups, sharing, deleting, the target checklist. |
| `targets/` | A target's page and form, and the panels on it. |
| `charts/` | Charts and what drives them: the smoke trace, comparisons, the time range. |
| `alerts/` | The alerts page. |
| `routing/` | BGP monitoring: the list of watched prefixes and a prefix's page, with its charts, and placeholders shaped like them for while they load (`skeleton.tsx`). |
| `settings/` | The settings page and each of its tabs. |
| `privacy/` | Hiding addresses on screen: whether this page hides them (`use-privacy.ts`) and the component that does (`masked.tsx`). |

A component used by one page only lives beside that page (`app/login/login-form.tsx`),
not here.

### `src/components/`

`arc/` is Arc UI, installed with `npx shadcn@latest add @uiarc/<name>`. Leave
its layout as shadcn makes it. Some of its files are edited (see CLAUDE.md),
so never reinstall over them. Beside it go the few shared components built on
Arc that every area uses (`notifications.tsx`, `segmented-field.tsx`,
`required-mark.tsx`, `error-boundary.tsx`, and `search-results.tsx`, which
every list under a search box is wrapped in).

## Where a new file goes

Ask in this order, and stop at the first yes:

1. **Is it a page or an API route?** `src/app/`, at the path that is its URL.
2. **Is it UI used by one page?** Beside that page.
3. **Is it UI for the dashboard?** `src/app/_components/<area>/`.
4. **Is it a shared UI building block?** Use an Arc component; if none fits,
   `src/components/`.
5. **Is it a type used on both sides of the API, or by the probe agent?**
   `src/types/`.
6. **Otherwise it is logic:** the `src/lib/` folder for its subject. If no
   folder fits and there will be more than one file about it, make a folder for
   the subject. A single module about the app as a whole can sit in `lib/`
   itself.

## Naming

- **kebab-case** for every file and folder: `group-path.ts`, `probe-agents/`.
- **The folder says the subject; the file does not repeat it.**
  `probes/config.ts`, not `probes/probe-config.ts`. `traceroute/parse.ts`, not
  `traceroute/traceroute-parse.ts`. If a file name starts with the same word as
  three of its neighbours, they want a folder.
- **A module that keeps something in the database is `store.ts`** in its
  subject's folder (`alerts/store.ts`, `traceroute/store.ts`,
  `probe-agents/store.ts`).
- **React hooks are `use-<thing>.ts`**, beside the component that uses them.
- **Components are named for what they show** (`stats-cards.tsx`), not for how
  they are built.
- **No `index.ts` barrels.** Import the file that holds the thing, so a search
  for a path finds every use of it.

## Tests

- **Beside what they test**, as `<name>.test.ts`: `probes/config.ts` is tested
  by `probes/config.test.ts`. A test of several modules sits with the one it is
  mostly about, named for what it checks (`db/migration.test.ts`,
  `alerts/integration.test.ts`).
- **Fixtures** shared between tests go in `src/lib/__fixtures__/`.
- Vitest finds tests under `src/`, `probe-agent/` and `scripts/`. A test
  anywhere else is never run.

## Imports

- **`@/` across folders, `./` within one.** `@/lib/probes/host` from a
  component; `./wire` from `probes/dns/transport.ts`; `../result` from
  `probes/dns/` back to `probes/`. Never climb more than one folder up with
  `../`: use `@/` instead. The one exception is a file outside `src/`, which
  `@/` cannot reach (`package.json`, `probe-agent/`).
- **Types from `@/types/<file>`**, which is `src/types/`.

## Boundaries

These are rules about what may import what, and two of them are enforced.

- **The probe agent's code stays free of the dashboard.** `src/lib/probes/`,
  `src/lib/traceroute/run.ts` and `parse.ts`, `src/lib/probe-agents/protocol.ts`
  and anything they import must not reach `src/lib/db/`, Better Auth, Next.js
  or React. `npm run build:probe-agent` fails if they do. Dashboard-only work
  for a probe agent goes in `probe-agents/client.ts` or `store.ts`.
- **Sign-in is Better Auth's.** Everything about accounts, passwords and
  sessions is in `src/lib/security/`, through Better Auth (see CLAUDE.md).
- **Pure modules say so.** A module the browser also runs (form checking,
  labels, chart maths) must not import Node modules or the database. Say it
  in the module's opening comment, as `probes/config.ts` does.
- **API routes are thin.** A route reads the request, checks who is asking,
  calls `src/lib`, and answers. Logic in a route cannot be tested or reused.

## Size

- A folder of more than about **15 files** (tests aside) is doing more than
  one job: split it by subject.
- A file of more than about **800 lines** is due a look. Split a component into
  the parts a reader would name, and logic into the steps it takes.
  `dashboard/dashboard.tsx`, `sidebar/sidebar.tsx` and `settings/settings-page.tsx`
  are over this now, and are the first to split.

## Moving files

- Move with the import paths, the tests, the comments and the docs together.
  Comments and docs name files by path (`see probes/game/query.ts`), so search
  for the old name afterwards.
- Paths named outside the code have to follow too: `scripts/build-probe-agent.mjs`
  (what the agent bundle may not include), `docker/probe-agent.Dockerfile`
  (what it copies into the build), `vitest.config.mts`, `tsconfig.json`,
  CLAUDE.md and links in `docs/`.
- Check with `npm run typecheck`, `npm test`, `npm run lint` and
  `npm run build:probe-agent`, then open the dashboard.

## Checklist for a change

- [ ] Each new file is in the folder its subject says, by the questions above.
- [ ] Its name does not repeat its folder, and is kebab-case.
- [ ] Its test is beside it.
- [ ] Imports use `@/` across folders and `./` within one.
- [ ] Nothing in the probe agent's code reaches the database, sign-in or Next.js.
- [ ] No folder past about 15 files, no new file past about 800 lines.
- [ ] Moved files: no old path left in comments, docs, Dockerfiles or configs.
