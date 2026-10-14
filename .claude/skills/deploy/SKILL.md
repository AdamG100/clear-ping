---
name: deploy
description: Deploy ClearPing - check the work, decide the version number, push to main, and confirm the new version is published and running. Use whenever the user asks to deploy, release, ship, publish or push ClearPing to main, or to check which version is deployed.
---

# Deploying ClearPing

Every push to `main` is a deployment. CI (`.github/workflows/docker.yml`) builds
the Docker image, numbers it, publishes it to `ghcr.io/adamg100/clear-ping` as
`:latest` and `:<version>`, and makes a GitHub release `v<version>`. The live
install at https://ping.gnetworx.cloud runs `:latest` and shows its version in
the sidebar.

## How the version number works

`MAJOR.MINOR.PATCH`:

- **PATCH goes up by itself on every deployment.** CI takes the highest
  `vMAJOR.MINOR.*` tag and adds one. Never edit it, and never create or push a
  `v*` tag by hand: CI does both, and a hand-made tag takes a different path
  through the workflow.
- **MAJOR.MINOR come from `package.json`** and only change when someone
  changes them. That is the one decision this skill exists to make every time
  (step 2).

So every deploy does get a new version number; what has to be decided by hand
is only whether it is a patch, or a new minor or major.

## Steps

### 1. Check the work

```bash
git fetch --tags origin
git status -sb
npm test
npm run typecheck
npm run lint
```

- Deploy from `main` only. If the work is on another branch, ask how it should
  reach `main`.
- Uncommitted changes: ask whether they belong in this deploy. Do not commit
  them without being told to.
- If any check fails, stop and report it. A failing build publishes nothing,
  but it also uses up nobody's time if it is caught here.

### 2. Decide the version

List what this deploy contains:

```bash
git log --oneline $(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD
```

Then pick the bump:

| What changed | Bump | How |
|---|---|---|
| Fixes, small improvements, docs, internal changes | **patch** | nothing to do; CI counts it |
| A new feature, a new probe type or setting, a new API or MCP tool, anything a user would notice as new | **minor** | `npm version minor --no-git-tag-version` |
| A change that needs the user to act when upgrading: settings renamed or removed, database changes that cannot be undone, API that behaves differently | **major** | `npm version major --no-git-tag-version` |

`npm version … --no-git-tag-version` sets `package.json` and
`package-lock.json` together and makes no tag. Commit that as its own commit
("Bump version to 0.2.0").

When the choice is not obvious, recommend one and ask. Never bump MAJOR
without the user agreeing.

Then work out the number this push will get:

```bash
node .claude/skills/deploy/release.mjs next
```

### 3. Push

Show the user, then wait for a clear yes, because pushing deploys:

- the commits going out (from step 2),
- the version they will be published as (`next` from the helper),
- that the live server will move to it.

Then `git push origin main`.

### 4. Confirm it published and is running

```bash
node .claude/skills/deploy/release.mjs wait <version> --minutes 30
```

Run it in the background; it polls the registry, then the live server, every
30 seconds, and exits with:

- `DEPLOYED` (0): the live server runs the new version. Done.
- `PUBLISHED, NOT DEPLOYED` (3): the image is out but the server has not
  pulled it. Tell the user to update it:
  `docker compose pull && docker compose up -d`, or `docker pull` and recreate
  the container (`docs/running.md`, *Upgrading*). After that the sidebar badge
  turns green.
- `TIMEOUT` (2): the build failed or is still running. Send the user to the
  "Docker image" workflow run on GitHub; `gh` is not installed on this machine.

A build that passed but has no GitHub release usually means Actions has
read-only access to the repository: Settings → Actions → General → Workflow
permissions → *Read and write*.

## Checking what is deployed

```bash
node .claude/skills/deploy/release.mjs status
```

says the newest published version and what the live server runs, and whether
it knows of an update. `GET https://ping.gnetworx.cloud/api/version` gives the
same from the server itself. Pass `--url` (or set `CLEARPING_URL`) for another
install.
