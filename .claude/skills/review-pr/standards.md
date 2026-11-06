# The ClearPing standard

Apply every section to every changed file. Each rule says what good looks like;
a change that falls short of one is a finding. Where a rule names a file, that
file is the source of truth: read it rather than trusting the summary here.

## Before the code: read the sources

- `CLAUDE.md` and `AGENTS.md`: branches and pull requests, version trailers,
  Better Auth, probe agents, the words, Arc and the things in it that bite.
- `docs/structure.md`: where files go and what may import what, and the
  checklist at its end.
- `docs/security.md`: who may call what, keys, roles, privacy.
- The `docs/*.md` page for the feature the PR touches.

## UI and design

Hold every changed screen to the pages beside it (Overview, Routing, a
monitor's page): a new page looks like it was always there.

- **Arc first.** Every control is an Arc component from `src/components/arc/`
  where one fits (`mcp__ArcUI__search_components` to check). Hand-built UI is
  for what Arc has nothing for: charts, the traceroute diagram.
- **Tokens only.** Colours come from Arc's tokens through the Tailwind names in
  `globals.css` (`text-muted-foreground`, `bg-card`, `text-signal-*`). A hex,
  `rgb()` or Tailwind palette colour (`text-red-500`) in a component is a finding.
  Both themes are checked: dark is `data-theme="dark"`.
- **The page frame.** A page in the main pane uses `PANE`, `PANE_HEADER`,
  `PANE_TITLE` from `dashboard/pane-layout.ts`, and panels are
  `rounded-3xl border border-border bg-card p-4 @2xl/main:p-6`. Layout answers
  to the pane's width (`@…/main:` container variants), not the screen's.
- **Down to a phone.** At 390px wide nothing scrolls sideways, nothing is cut
  off, and every control can be reached and pressed (about 44px). A table with
  a column per item becomes cards or scrolls inside its own panel. Long names,
  addresses and many probes are the cases to try.
- **Aligned.** Controls on one line share a baseline or a bottom edge: a field
  with a label above it sits beside its button with `items-end`, not
  `items-center`.
- **Every state drawn.** Loading (a skeleton the shape of what is coming),
  empty (an `EmptyState` saying what to do), error (an `Alert` saying what
  failed), and for anything that runs: what is happening now, how far along it
  is (`TextShimmer`, `Progress`), and what did not answer.
- **Pressable things look it.** A clickable element is a `button` or a link,
  never a `div` with `onClick` alone, and shows the pointer (the base rule in
  `globals.css` covers buttons, links and ARIA roles; anything else needs
  `cursor-pointer`).
- **Accessible.** Icon-only buttons have an `aria-label`; icons are
  `aria-hidden`; a status that changes is announced once (`role="status"`),
  not on every tick; focus shows only for the keyboard; every animation has a
  reduced-motion path.
- **Copy.** Sentence case, plain words, no em dashes, no eyebrow labels. The
  words in `CLAUDE.md` (monitor, probe, probe agent, local probe, reading) are
  used and the wrong ones are not ("agent" alone, "this server", "3 probes in
  a row").
- **Arc files left alone.** An edit to a file in `src/components/arc/` is added
  to the list of edited Arc files in `CLAUDE.md`, or `shadcn add --overwrite`
  will undo it.

## Performance and resources

ClearPing runs for months on small machines and a dashboard tab stays open for
days. Look for what grows, what keeps running, and what runs too often.

- **Every effect cleans up.** Each `setInterval`, `setTimeout`,
  `addEventListener`, `ResizeObserver`, `IntersectionObserver`, `EventSource`,
  WebSocket, `requestAnimationFrame` and `fetch` started in an effect or a hook
  is stopped in its cleanup (`clearTimeout`, `removeEventListener`,
  `disconnect`, `AbortController.abort()`). A loop of awaited work checks an
  abort signal, and a wait inside it can be cut short by it.
- **Nothing writes after it is gone.** A request answered after the page moved
  on, or after a newer request, is dropped (abort it, or check it is still the
  current one), so an old game's or monitor's data never lands on a new one.
- **Server memory is bounded.** A module-level `Map`, `Set`, array or cache has
  a size limit or an expiry, and is keyed by something finite. A queue has a
  maximum length and refuses past it.
- **Concurrency is limited.** Work fanned out over a list (probes, regions,
  monitors) runs a fixed number at a time, on the server across everyone, not
  per request.
- **Renders stay cheap.** Derived data is computed in `useMemo` from the state
  it depends on, not stored as more state. A list of hundreds of rows does not
  re-render all of them for one cell's change (`memo` the rows, keep updates
  local). No new object or function in a dependency array on every render.
- **Animation pays for itself.** Continuous motion (shimmers, spinners,
  per-frame `motion` values) runs only while visible and only for the few items
  actually busy, never one per row of a long list. CSS transitions over
  JavaScript where either will do.
- **Polling is justified.** An interval that fetches has a reason not to be
  pushed instead, stops while the tab is hidden, and backs off when the
  server is failing.
- **The database is used well.** No query in a loop where one query would do;
  new queries that filter or sort on a column have an index; writes that go
  together are in a transaction; nothing reads a whole table to show a page.
- **No blocking the event loop.** No synchronous file or process calls, and no
  large JSON parse or sort in a request path that runs often.

## Security

- **Sign-in is Better Auth's.** Accounts, sessions, passwords, keys, roles,
  two-factor, passkeys and single sign-on go through Better Auth and its
  plugins (`src/lib/security/auth.ts`), called from ClearPing's routes. Any
  hand-written session, token, password or cookie handling is a must fix.
- **Every route says who may call it.** `src/proxy.ts` lets anyone `GET` when
  sign-in is off, and viewers `GET` when it is on, so a `GET` never changes
  anything, and anything only an admin may see or do calls `requireAdmin` (or
  `requireUser` for an account) from `src/lib/security/http.ts`. A new route is
  checked against the table in `docs/security.md`.
- **Input is checked at the edge.** Every query parameter, path segment and
  body field is validated for type, length and range before it is used, and an
  identifier is looked up, never trusted.
- **No reaching where the caller points.** Anything that sends packets or
  requests (probes, traceroute, webhooks, game ping) reaches only addresses the
  caller is allowed to set, or names a fixed entry by id, as Game Server Ping
  does. A route that takes an address from a viewer and contacts it is an open
  relay and a must fix.
- **No shell.** Processes start with `execFile`/`spawn` and an argument array,
  never a command string, and a host or name passed to one cannot start with
  `-` or carry spaces or shell characters.
- **Nothing injected into the page.** No `dangerouslySetInnerHTML` with data
  that came from outside; links to outside take `rel="noreferrer noopener"`
  and only `http(s)` URLs.
- **Secrets stay secret.** No token, key, password or address of the user's
  own network in code, tests, fixtures, docs or logs (examples use
  documentation ranges: `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
  `2001:db8::/32`, `example.net`). Errors sent to the browser say what failed,
  not stack traces or internals.
- **Privacy holds.** Anything new that shows an address respects Settings →
  Privacy (`Masked` on screen, `src/lib/privacy/` for assistants).
- **The supply chain is read.** A new dependency is needed, maintained and
  pinned in the lockfile; a changed install script, registry or workflow is
  read line by line. A workflow change is merged by hand and says so.
- **Rate and size limits.** Anything a viewer can trigger that costs the server
  (tests, exports, lookups) is limited across everyone, and answers 429 with
  `Retry-After` past the limit.

## House rules

- **Structure.** Files are where `docs/structure.md` says, named for one thing,
  kebab-case, no barrels, `@/` across folders and `./` within one; tests beside
  what they test; no new file past about 800 lines.
- **Probe agents.** Nothing under `src/lib/probes/` or
  `src/lib/traceroute/run.ts` imports the database, Next.js or Better Auth. A
  change to what `/v1/*` takes or gives raises `PROBE_AGENT_PROTOCOL`.
- **Tests.** New logic that can be pure is pure and has a test beside it.
- **Docs.** A change a user would notice updates the `docs/*.md` page for that
  feature and, if it moves something, `docs/structure.md`.
- **Commits are the patch notes.** Each subject and body says what changed for
  someone running ClearPing; a commit that adds something new ends with
  `Release: minor` (`major` only with the owner's agreement). The notes are
  public: a message that names people, a real network, a secret, CI, tests,
  AI tooling, file paths or "this commit" breaks the rules in `CLAUDE.md`
  (Version numbers), and a commit with nothing for users needs
  `Notes: internal`. The PR is not squashed.
