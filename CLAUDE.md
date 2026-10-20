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

## Security: Better Auth

Everything to do with signing in is Better Auth's (`src/lib/security/auth.ts`)
and its plugins: accounts, passwords, sessions, keys, roles (admin), Authentik
(generic OAuth), authenticator apps (two-factor) and passkeys. Add a feature
by adding the Better Auth plugin that does it, called from ClearPing's own
routes on the server; never write sign-in, session or credential handling by
hand. Better Auth's HTTP endpoints stay closed to the browser (the `before`
hook), so ClearPing's rules always apply.

## UI: Arc

The UI is built from Arc UI (https://uiarc.dev) components in
`src/components/arc/`, installed with `npx shadcn@latest add @uiarc/<name>`.
Use an Arc component wherever one fits before writing UI by hand; the charts
and the traceroute diagram are the custom exceptions. Colours are Arc's tokens
(`globals.css` maps the Tailwind names onto them); dark mode is
`data-theme="dark"` on `<html>`, page `#121212`, surfaces `#1b2024`.

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
