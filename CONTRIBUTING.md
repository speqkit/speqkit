# Contributing

Thank you for looking. Before the setup instructions, the most useful thing
this file can tell you:

## Most contributions do not belong in this repository

speqkit is a kernel that loads plugins. HTTP, the CLI, the authoring format,
control flow, the reporters — every one of them is a plugin, including the ones
that ship in the box. That is not a slogan about extensibility; it is the reason
you can add what you need **without asking us, without a fork, and without
waiting for a review**.

```bash
npm create speqkit-plugin kafka
cd speqkit-plugin-kafka && npm install && npm test
```

The scaffold ships the eight contribution points, tests that run inside the real
kernel, and a release workflow that publishes to npm from your own repository.
Nothing about it needs our permission, and nothing about it is second-class:
`@speqkit/plugin-loop` — `loop` and `retry`, which most frameworks consider
core — was written against the published contract with no kernel changes at all.

| You want to add | Where it goes |
| --- | --- |
| A step type, an assertion, a reporter, a value provider, a loader, a command, a resource, a service | **Your own repository.** Publish it with the `speqkit-plugin` keyword. |
| Support for a protocol, a database, a cloud, a message bus | **Your own repository.** `docs/architecture/plugins.html` lists which plugins we intend to write; everything else is open ground. |
| A field on the test model, a new event, a change to `ctx` | Here — it is the contract. Open an issue first; see [Changing the contract](#changing-the-contract). |
| A bug in the kernel, the installer, the binary, the CLI | Here. |
| A bug in one of the plugins under `packages/` | Here. |

If you publish a plugin, tell us — open an issue and we will link it. A plugin
we did not write and cannot break is the point of the architecture, not an
exception to it.

## Setting up

Node 20 or newer, and pnpm through corepack. Nothing else.

```bash
corepack enable
pnpm install
pnpm build          # tsc project references -> dist, with .d.ts and maps
pnpm typecheck
pnpm test
```

The faster loop while working on the kernel runs against the sources:

```bash
cd examples/basic
node --import tsx ../../packages/core/src/bin.ts validate
node --import tsx ../../packages/core/src/bin.ts run --env local --test suites/loop.yaml
```

## The gate

`.github/workflows/ci.yml` is what every pull request faces, and — literally the
same file, not a copy of it — what decides whether a commit ships. You can run
all of it locally:

```bash
pnpm typecheck && pnpm build && pnpm test
node scripts/verify-publish.mjs           # the one that matters
node scripts/build-binary.mjs && node scripts/verify-publish.mjs --binary build/speq
```

`verify-publish.mjs` is worth understanding before you trust a green `pnpm test`.
The tests resolve `speqkit` and `@speqkit/*` through a bundler alias to `src`,
and that arrangement once hid a bug that would have broken every install:
`exports` pointed at `.ts`, and Node refuses to strip types inside
`node_modules`. So `verify-publish.mjs` trusts none of it — it packs the real
tarballs, serves them from a throwaway registry over HTTP, installs them into a
throwaway store, and runs the CLI out of `dist` with plain `node`. It is the
only step that tests what a stranger would actually install.

CI runs the matrix on Node 20, 22 and 24. A test framework that only runs on the
maintainer's Node is not one.

## The invariants

`packages/core/test/kernel.test.ts`, `gate.test.ts` and `reporting.test.ts` pin
the spine — a step type the kernel has never heard of runs; a child scope does
not leak into its parent; resources tear down in reverse order; a crash inside a
plugin is `error`, never `failed`; the event stream alone is enough to rebuild a
report.

**If one of them starts failing, the fix belongs in the kernel, not in the
test.** They are not regression tests for bugs; they are the statements that make
the architecture true. A pull request that edits one of them to go green needs to
say, in the description, which invariant moved and why that is allowed.

`packages/core/test/workspace.test.ts` is the odd one out: it checks this
repository's own wiring rather than the kernel's. It exists because
`tsconfig.json`'s `paths` map had quietly lost three packages, which made
`pnpm typecheck` pass for everyone who had run `pnpm build` once and fail on
every clean clone.

## Changing the contract

`@speqkit/plugin-api` is the compatibility boundary, and it has two version
numbers that do different jobs:

- **`PLUGIN_API_VERSION`** is an integer. A plugin built against a different one
  is refused at load. It has been `1` since the first commit and changing it
  breaks every published plugin at once.
- **The package's semver** describes what the types offer. While it is `0.x`, a
  caret range pins the *minor* — `^0.4.0` does not accept `0.9.0` — so every
  in-box plugin's peer range has to move with it, in the same commit. A plugin
  left behind makes an install pull two copies of the contract.

Two things about the contract are deliberately closed, and a pull request that
opens either needs an argument rather than a diff:

- **There are eight contribution points and no ninth.** Four separate gaps have
  been found in the model since the first commit — assertions on a step, setup
  and cleanup, test-level variables, arbitrary metadata — and every one of them
  was solved by a field on the spine, never by a new contribution point.
- **The kernel never branches on `meta`.** Anything outside a test's closed spine
  is carried and never read. The moment behaviour follows from an annotation, a
  suite has control flow that `speq validate` cannot see and a report cannot
  explain.

If you have hit a wall the contract does not let you through, open a
*"the contract is in the way"* issue and describe the plugin you were trying to
write. Every hole found so far was found exactly that way.

## Commits and pull requests

Commit subjects here are sentences that say what is true after the change, not
labels for the kind of change:

```
A plugin can check its own inputs before the run, not during it
Close step zero: one binary that carries its own Node
Keep .npmrc out of git
```

No `feat:` / `fix:` prefixes, no ticket numbers. The body, when there is one,
says why it was allowed rather than what the diff already shows. Keep the
subject under about 72 characters.

A pull request is expected to be green on its own — the gate is the same battery
that decides releases, so a red PR is not "CI being flaky", it is a release that
would have failed. Add or move tests in the same commit as the behaviour.

## Releasing

Nobody cuts a release. **Bump a version in a `package.json` and merge to main**
— if the gate is green, that version goes to npm, and if `packages/core`'s
version moved, four executables, a GitHub release and the Homebrew formula
follow it.

```bash
node scripts/release-plan.mjs     # what would this commit release?
```

A kernel bump also needs its heading in `CHANGELOG.md`; a test fails if the
version being released is not named there. The full picture — what decides each
step, how to dry-run it, what to do when it publishes nothing — is on the
[Releasing page](https://speqkit.github.io/speqkit/releasing.html).

## Documentation

`docs/` **is** the site at <https://speqkit.github.io/speqkit/>; it is deployed
by Actions on every push to main that touches it. `scripts/check-site-links.mjs`
fails the build when an internal link or an `#anchor` points at nothing, so a
404 on the site is a broken build rather than a bug report.

The whole site is in English, and so is everything else here — the READMEs, the
comments, the commit messages, the issue tracker. The three architecture
documents are the project's design record: arguments for why something was
allowed, rather than descriptions of what the code does. They were translated
from Russian, so if a passage reads as though it is arguing with somebody who
is not in the room, that is because it once was — say so in an issue and it
gets rewritten.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues go to [SECURITY.md](SECURITY.md) instead of the issue tracker.
