# Contributing to ClearPing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with what you did, what you expected and what happened instead,
the version (beside the ClearPing name at the top of the sidebar) and how you
run it (Docker, Compose, from source). Logs help: `docker logs clearping`.

Leave out anything private: real IP addresses, host names, keys, and the
passwords inside notification URLs. Use documentation addresses such as
`192.0.2.10` and `example.com` instead.

A security problem goes to the maintainer privately, through GitHub's
**Report a vulnerability** on the Security tab, not in a public issue.

## Running it from source

Needs Node.js 26.12.1 or newer, and `ping` and `traceroute`
(`tracert` on Windows).

```bash
git clone https://github.com/AdamG100/clear-ping.git
cd clear-ping
npm install
npm run dev
```

Open <http://localhost:3000>. Under `npm run dev` every page opens signed in as
a `dev` admin account, so sign-in never gets in the way; set
`CLEARPING_DEV_USER=off` to see the dashboard signed out. A production build
never does this. Alerts need Apprise: `pip install "apprise[all-plugins]"`.

## Checks

```bash
npm test                   # unit and integration tests
npm run typecheck
npm run lint
npm run build
npm run build:probe-agent  # the probe agent, as one bundled file
```

The tests use temporary SQLite files and a local HTTP server; nothing touches
the network or your real database. Every pull request runs the same checks, a
Docker build and a security review.

## How the code is laid out

[docs/structure.md](docs/structure.md) says where files go, how they are named
and what may import what. Read it before adding or moving a file. In short: a
folder names a subject and a file one thing in it, tests sit beside what they
test, `@/` across folders and `./` within one.

A few rules that keep ClearPing consistent:

- **Signing in is Better Auth's.** Accounts, sessions, keys, roles, two-factor,
  passkeys and single sign-on all go through Better Auth and its plugins
  (`src/lib/security/auth.ts`). A new sign-in feature is a Better Auth plugin,
  never hand-written credential handling.
- **The UI is built from [Arc UI](https://uiarc.dev) components** in
  `src/components/arc/`. Use one wherever it fits before writing UI by hand.
- **The probe agent bundles the probe code** (`src/lib/probes/`, …), so that
  code must not import the database, Next.js or Better Auth. The build fails if
  it does. `src/lib/probe-agents/protocol.ts` is the contract between the two
  ends.
- **One word for one thing**, in the UI and the docs: a *monitor* is what is
  measured, a *probe* is where readings are taken from, a *probe agent* is the
  program on another machine, the *local probe* is the dashboard's own machine,
  and a *reading* is one measurement. The API and the MCP tools still say
  *target* for a monitor, and keep doing so. The full list is in
  [docs/overview.md](docs/overview.md).

## Pull requests

Branch from `main`, keep a pull request to one change, and make sure the checks
above pass. Don't squash: each commit's message becomes a line in the patch
notes.

### Commit messages are the patch notes

Every release is numbered and described from its commit messages: each
commit's subject and body appear on the GitHub release and in the dashboard's
patch notes. So write them for someone running ClearPing, in the dashboard's
words, saying what changed for them:

> Show the reading at the point you tap on a chart
>
> On a phone, tapping a chart now shows the reading at that moment, and
> dragging across it zooms in.

The notes are public, so a message carries no real addresses, host names, keys
or names of people, and says nothing about how ClearPing is made (CI, tests,
tooling, file or function names).

Trailers at the end of the message, beside any `Co-Authored-By`, file the note
and set the version:

| Trailer | When |
|---|---|
| none | A fix, a small improvement, docs: a patch release |
| `Release: minor` | Something new a user would notice: a feature, a kind of check, a setting, an API or MCP tool. Give it to every commit that adds something new |
| `Release: major` | Only with the maintainer's agreement: an upgrade that needs the user to act |
| `Notes: internal` | Nothing in it for someone running ClearPing (CI, tests, tooling, these guides): left out of the notes |

Don't edit `package.json`'s version or make `v*` tags; releases are numbered by
CI when a pull request is merged.
