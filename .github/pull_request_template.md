<!--
Commit subjects here are sentences that say what is true after the change,
not labels for the kind of change. No feat:/fix: prefixes. The pull request
title becomes the commit subject when it is squashed, so give it the same
treatment:

    A plugin can check its own inputs before the run, not during it
    Close step zero: one binary that carries its own Node
-->

## What is true after this change



## Why it was allowed

<!-- The diff already shows what. This is the half that is worth reading in a
year: what you decided, and what you decided against. Delete if it is genuinely
a typo fix. -->



## Checks

- [ ] `pnpm typecheck && pnpm build && pnpm test` is green
- [ ] `node scripts/verify-publish.mjs`, if anything touched `exports`,
      `files`, dependencies or a package manifest — the ordinary tests resolve
      through a bundler alias to `src` and cannot see a broken install
- [ ] Tests moved in the same commit as the behaviour

<!-- Only if they apply: -->

- [ ] **An invariant test changed.** `kernel.test.ts`, `gate.test.ts` and
      `reporting.test.ts` state what makes the architecture true; if one had to
      move, say here which invariant moved and why that is allowed.
- [ ] **A version was bumped.** Merging this publishes it. If it is
      `packages/core`, `CHANGELOG.md` needs the heading (a test enforces it) and
      the release cuts binaries, a tag and the Homebrew formula.
- [ ] **`@speqkit/plugin-api` was bumped.** A caret on `0.x` pins the minor, so
      every in-box plugin's peer range moves in this same commit or installs
      start pulling two copies of the contract.
