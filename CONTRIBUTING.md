# Contributing

## Merge to `main` often — small and green

**Rule:** land work on `main` in small, CI-green increments. A feature branch should not
carry more than a few days of work, and it should never accumulate an entire subsystem before
its first merge.

### Why this rule exists

We have now hit the same failure twice:

1. The contracts work sat on its own branches without merging.
2. `feat/receipt-writer` grew to **51 commits** — essentially the whole application build:
   packages, services, and the web app — while `main` stayed frozen at the 2026-07-09 merge base
   and never moved. Because nothing merged, a single `tsc` error in a proof script
   (`scripts/prove-policy-onchain.ts`) turned every JS workflow red and stayed red across many PR
   runs. The redness was invisible on `main` (main never ran it) and easy to ignore on the PR
   (there was only ever one giant PR). The longer the branch lived, the more the red X read as
   "just the usual," and the harder any eventual merge became.

Long-lived branches hide breakage, defer integration risk to one high-stakes moment, and make
"is the build actually green?" unanswerable. Frequent small merges keep `main` continuously
releasable and surface failures while they are one commit to bisect, not fifty.

### What to do

- **Branch lifetime:** open a branch, land it within a day or three. If a feature is larger,
  split it into independently-mergeable slices (a package, an endpoint, a page) behind the
  existing seams — each slice merges green on its own.
- **Keep `main` green:** every push and PR runs `pnpm typecheck` plus the affected suite
  (`test:canon` / `test:policy` / `test:receipt-writer`) and the contracts pipeline. A branch is
  not mergeable until those are green. Do not merge a red branch "to fix later."
- **Run the gate locally before pushing:** `pnpm typecheck && pnpm test:canon && pnpm test:policy
  && pnpm test:receipt-writer`. `tsc` is repo-wide — a type error in any workspace or script
  fails every JS workflow, so a clean local typecheck is the cheapest way to avoid a red PR.
- **Don't let a branch fall behind `main`:** rebase or merge `main` in regularly so integration
  stays cheap and conflicts stay small.

### Rebasing / merging back

When `main` has moved, `git fetch origin && git rebase origin/main` (or merge it in) before you
push. Resolve conflicts as you go, while the surface is small — never in one big-bang merge at
the end.
