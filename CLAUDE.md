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
