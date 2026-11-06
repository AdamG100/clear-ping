---
name: review-pr
description: Review a ClearPing pull request against the house standard (UI and design, performance and resource use, security, the repo's own rules) and post the verdict on the PR, asking for what must be fixed. Use when the user asks to review, check or vet a PR (by number, link or branch), or to look again at one after it was updated.
argument-hint: "<PR number, URL or branch>"
---

# Reviewing a ClearPing pull request

The review ends with a reply on the pull request: either it is fit to merge, or
it says exactly what to fix, where, and why. A finding is only worth posting if
it is **verified**: you can name the file and line, say what goes wrong for
someone running ClearPing, and say what the fix is.

The rulebook is [standards.md](standards.md). It points at the repo's own
sources (`CLAUDE.md`, `docs/structure.md`, `docs/security.md`), which stay the
single source of truth; read them as it says.

## 1. Find the pull request

From the argument, or the current branch if none was given:

```bash
gh pr view <pr> --json number,url,title,body,author,isDraft,headRefName,headRefOid,baseRefName,files,commits
gh api user --jq .login        # who is posting, to know if this is your own PR
```

Done when you know its number, its head commit, who wrote it, and every file it
changes. A PR that changes `.github/workflows/` is merged by hand: note it for
the reply.

## 2. Get its code, safely

Review in a worktree, so the user's checkout is left alone:

```bash
git fetch origin pull/<n>/head:review/pr-<n>
git worktree add ../clear-ping-review-<n> review/pr-<n>
```

Before installing anything, read the PR's changes to `package.json`,
`package-lock.json`, `.npmrc`, `scripts/` and `.github/`. A new dependency, a
new install script or a changed registry is a finding in itself. Then install
with scripts off and run the checks from the worktree:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run build:probe-agent   # only when src/lib/probes/, src/lib/traceroute/ or probe-agent/ changed
```

Done when each command has passed or its failure is written down as a finding.

## 3. Read every change in full

For each changed file, read the whole file, not only the diff hunks, and open
what it calls and what calls it, enough to know how it behaves at run time.
Then apply **every** rule in [standards.md](standards.md) to **every** changed
file. Done when each file has been held against each section (UI, performance,
security, house rules) and you can say for each section that it passed or what
failed.

When the PR changes what is on screen, look at it running: start the dev server
from the worktree (another port if one is already running), open the changed
page at desktop width and at 390px wide, and check nothing scrolls sideways
(`document.querySelector('main').scrollWidth > clientWidth`), in light and dark.
Drive its new states too: loading, empty, error, and the long-running and
failed paths.

## 4. Verify, then sort

For each finding: confirm it against the code (or by running it), and drop it
if you cannot. Sort what is left:

- **Must fix**: a bug, a security hole, a leak or runaway CPU, a broken layout
  at phone width, a failing check, or a break of a rule in `CLAUDE.md`.
- **Should fix**: off the house standard in a way a user would notice (spacing,
  copy, an Arc component not used where one fits), or a test missing for new
  logic.
- **Nit**: worth saying once, not worth holding the PR.

## 5. Post the reply

Write the review to a file in the scratchpad, never inline in the shell. One
review, with a comment on each line a finding is about, and a body that lists
them all in order (must fix first), each as: what is wrong, why it matters to
someone running ClearPing, and the fix. End with what was checked and passed.

```bash
# review.json: {"commit_id": "<head sha>", "event": "<EVENT>", "body": "...",
#               "comments": [{"path": "src/...", "line": 42, "side": "RIGHT", "body": "..."}]}
gh api repos/{owner}/{repo}/pulls/<n>/reviews --method POST --input review.json
```

A comment's `line` must be a line the diff shows on the right side; a finding
about anything else goes in the body only.

`EVENT` is:

| Found | Someone else's PR | Your own PR (GitHub refuses the other events) |
|---|---|---|
| Any must fix | `REQUEST_CHANGES` | `COMMENT`, then hold it back: `gh pr ready <n> --undo` |
| Only should fix or nits | `COMMENT` | `COMMENT` |
| Nothing | `APPROVE` | `COMMENT` saying it passed |

The owner's pull requests merge themselves once CI passes (`auto-merge.yml`);
only a draft waits. That is why a must-fix on one is turned back into a draft:
say so in the review, and that marking it ready again releases it once fixed.

## 6. Clean up and report

```bash
git worktree remove ../clear-ping-review-<n>
git branch -D review/pr-<n>
```

Stop any dev server you started. Tell the user the verdict, the review's link,
and the must-fix findings in a line each.

## Reviewing again

When a PR you reviewed has new commits, read your earlier review
(`gh api repos/{owner}/{repo}/pulls/<n>/reviews`), check each finding against the
new head, and review only what changed since, plus whatever the fixes touched.
Say in the new review which findings are fixed and which are not.
