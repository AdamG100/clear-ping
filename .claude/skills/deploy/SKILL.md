---
name: deploy
description: Deploy ClearPing - check the work, push to main, and confirm the new version is published and running. Use when the user asks to deploy, release, ship, publish or push ClearPing to main, or to check which version is deployed. Work normally reaches main through a pull request that merges itself (see CLAUDE.md), and the version is decided when committing, not here.
---

# Deploying ClearPing

Every push to `main` that changes what goes into the images is a deployment. CI (`.github/workflows/docker.yml`) builds
the Docker image, numbers it, publishes it to `ghcr.io/adamg100/clear-ping` as
`:latest` and `:<version>`, and makes a GitHub release `v<version>`. The live
install (its address in `CLEARPING_URL`, or passed with `--url`) runs `:latest` and shows its version in
the sidebar.

## How the version number works

`MAJOR.MINOR.PATCH`:

- **CI counts it** (`scripts/next-version.mjs`): one more than the highest
  `v*` release tag, as a patch, unless a commit since that release has a
  `Release: minor` or `Release: major` trailer in its message; the biggest
  one asked for wins. Never create or push a `v*` tag by hand: CI does that,
  and a hand-made tag takes a different path through the workflow.
- **The decision is made when committing**, not when deploying, because the
  user usually pushes from GitHub Desktop without this skill. CLAUDE.md says
  when to add the trailer.

`package.json`'s version is only a floor and is otherwise left alone.

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

### 2. Check the version

List what this deploy contains:

```bash
git log --oneline $(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD
```

If the commits deserve a bigger bump than their trailers ask for (see the
table in CLAUDE.md), the trailer is missing: add an empty commit that carries
it, `git commit --allow-empty -m "Release <version>" -m "Release: minor"`,
rather than rewriting commits. Then work out the number this push will get:

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
it knows of an update. `GET <install>/api/version` gives the
same from the server itself. Pass `--url`, or set `CLEARPING_URL`, to say which
install.
