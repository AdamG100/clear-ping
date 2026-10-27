@AGENTS.md

## Version numbers

Every push to `main` is released, numbered by CI (`scripts/next-version.mjs`).
The user pushes from GitHub themselves, so the version is decided in the
commit message: when a commit deserves more than a patch, end its message
with a `Release:` trailer beside `Co-Authored-By`.

| What changed | Trailer |
|---|---|
| Fixes, small improvements, docs, internal changes | none (patch) |
| Something new a user would notice: a feature, probe type, setting, API or MCP tool | `Release: minor` |
| An upgrade that needs the user to act: settings renamed or removed, a database change that cannot be undone, an API that behaves differently | `Release: major`, only with the user's agreement |

One trailer is enough for everything going out together: the biggest one asked
for since the last release wins. Do not edit `package.json`'s version or make
`v*` tags.

The commit messages are the patch notes (`scripts/release-notes.mjs`): each
commit's subject and body go onto the GitHub release and into the image, where
the version badge opens them, filed under the part its trailer says (`major`
is "Before you update", `minor` "New", none "Fixes and improvements"). Write
the subject and body for someone running ClearPing, saying what changed for
them; keep file names and internals to a minimum.

## Structure

Where files go, how they are named, and what may import what are in
`docs/structure.md`: read it before adding or moving a file, and go through its
checklist before finishing. In short: a folder names a subject and a file one
thing in it (`src/lib/probes/config.ts`, not `probe-config.ts`), tests sit
beside what they test, `@/` across folders and `./` within one, no barrels.

## Security: Better Auth

Everything to do with signing in is Better Auth's (`src/lib/security/auth.ts`)
and its plugins: accounts, passwords, sessions, keys, roles (admin), Authentik
(generic OAuth), authenticator apps (two-factor) and passkeys. Add a feature
by adding the Better Auth plugin that does it, called from ClearPing's own
routes on the server; never write sign-in, session or credential handling by
hand. Better Auth's HTTP endpoints stay closed to the browser (the `before`
hook), so ClearPing's rules always apply.

## Probe agents

A probe agent (`probe-agent/`) is a small program on another machine that the
dashboard connects to for readings from there (`docs/probe-agents.md`). Never
call it a bare "agent" in the UI or docs: it is a "probe agent", and has
nothing to do with AI agents or the assistant.

- It bundles the dashboard's probe modules (`src/lib/probes/`,
  `src/lib/traceroute/run.ts`, …) with esbuild. Anything those import must
  stay free of the database (`src/lib/db/`), Next.js and Better Auth;
  `scripts/build-probe-agent.mjs` fails the build if any of them gets in. Put
  dashboard-only work in `src/lib/probe-agents/client.ts`, not in the probe modules.
- `src/lib/probe-agents/protocol.ts` is the contract both ends share. Raise
  `PROBE_AGENT_PROTOCOL` when what `/v1/*` takes or gives changes.
- Its token is a pairing secret for a program that has no Better Auth, not a
  sign-in: the routes that manage probe agents are Better Auth admin routes.

## UI: Arc

The UI is built from Arc UI (https://uiarc.dev) components in
`src/components/arc/`, installed with `npx shadcn@latest add @uiarc/<name>`.
Use an Arc component wherever one fits before writing UI by hand; the charts
and the traceroute diagram are the custom exceptions. Colours are Arc's tokens
(`globals.css` maps the Tailwind names onto them); dark mode is
`data-theme="dark"` on `<html>`, page `#0b0c0d`, surfaces `#141719`.

Things that bite:
- Arc's CSS modules are unlayered, so they beat Tailwind utilities: a class
  passed to an Arc component cannot change what its module sets (font, padding,
  height, margin). Wrap it in an element and style that, or use `style`.
- Arc fields take a visible `label`; `SegmentedControl` only says its label to
  a screen reader, so in a form use `SegmentedField` (`src/components/segmented-field.tsx`).
- Inside Arc `TabsContent` text is the secondary colour; give content in a tab
  `text-foreground`, or field labels come out grey.
- Buttons and segmented controls are inline: put each on a line of its own in
  a stacked form, or they sit side by side.
- Notifications are `useToast()` from `@/components/notifications` (Arc's toast stack).
- Some installed Arc files are edited, and `shadcn add --overwrite` would undo
  them: tooltip (dark colours), code-block (no `//` comments in shell),
  expandable-card (a `leading` slot for a status dot), lib/use-copy-feedback
  (copies through `src/lib/clipboard.ts`, which works over plain HTTP), and the fields (input,
  textarea, password, search, number, tag input, select), whose focus border is
  `--focus-color`, the colour of every other focus ring, instead of white.
  Input, textarea, password and select also show a "Required" tag
  (`src/components/required-mark.tsx`) beside the label when given `required`:
  give it to every field that has to be filled in, and `noValidate` to its form
  so ClearPing's own messages are the ones shown.
