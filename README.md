# speqkit

A test framework that is mostly plugins.

The kernel loads plugins and gets out of the way. HTTP, the CLI, the authoring
format, control flow, reporters — every one of them is a plugin, including the
ones that ship in the box. A tester who needs something we did not build writes
it and publishes it; nothing needs to be agreed with us first.

> **speqkit** is the project. **`speq`** is the command you type.
>
> The npm scope and the GitHub organisation are [`speqkit`](https://github.com/speqkit);
> the binary is called `speq` because that is what gets typed fifty times a day
> — the same split as `@angular/cli` installing `ng`. The bare npm name `speq`
> belongs to an abandoned 0.0.0 placeholder and `@speq-ai/speq` is an unrelated
> project; neither is us.

## Status

M0, M1 and the architecture gate are done; M2 is most of the way there.
All nine packages are published — the kernel as `speqkit`, the contract and
the plugins under `@speqkit` — so `npm i -g speqkit` installs the `speq`
binary from the registry rather than from this checkout.

`plugin-loop` was written against the published API with **no kernel changes**
— control flow is genuinely a plugin. `plugin-playwright` then exercised the
two parts of the spine the loop never touched, scoped resources and binary
artifacts, and found exactly one thing missing: `attach` took bytes and dropped
them. The plugin-facing call did not change; the kernel now writes the file and
the event carries a `path`. What the gate could *not* produce — screenshot on
failure — is written down in `packages/plugin-playwright/README.md` rather than
worked around.

M2 is the installer: `speq install` resolves against the npm registry over
HTTP, verifies hashes, extracts into `~/.speq` and writes `speq.lock` — without
`npm`, `pnpm` or a `node_modules` in the project. `--frozen`, `add`, `remove`
and `link` work. `github:` specs do not yet; see
`packages/installer/README.md`.

Step zero is closed too. `scripts/build-binary.mjs` produces one executable
with a pinned Node inside it, so a Go or Python repository can install a test
runner without installing a JavaScript toolchain first. It is not a separate
build of the kernel: `verify-publish.mjs --binary` points the same battery at
the executable with `PATH` emptied, and it has to install from a registry,
load four plugins out of the store and run a suite on a machine where `node`
cannot be reached at all.

The road from "works on my laptop" to "green in CI" is now closed. `--env`
layers an `environments/<name>.yaml` of settings — and only settings, because
the plugin set is what `speq.lock` pins and `--frozen` runs before anyone has
said which environment the run will use. `${env:VAR}` in a config file comes
from the process environment and fails loudly when unset. Reporters are
selected with `--reporter`, and `speq report` re-renders a finished run from
its recorded event log.

That last part closed the third hole of the same kind the gate found twice:
`defineReporter` had been on the contract since the first commit and nothing
had ever called it — the console output went straight to `events.subscribe`,
around the mechanism rather than through it. It is an ordinary reporter now,
and the default one.

## Try it

```bash
corepack enable && pnpm install && pnpm build
cd examples/basic

./node_modules/.bin/speq plugins    # the built binary, plain node, no tsx
```

Or against the sources, which is the faster loop while developing:

```bash
cd examples/basic

node --import tsx ../../packages/core/src/bin.ts plugins   # what is loaded
node --import tsx ../../packages/core/src/bin.ts validate  # catches typos, no network
node --import tsx ../../packages/core/src/bin.ts run --env local --test suites/loop.yaml
node --import tsx ../../packages/core/src/bin.ts run --env ci --reporter console,junit \
  --test suites/health.yaml
node --import tsx ../../packages/core/src/bin.ts report --list   # runs already recorded
node --import tsx ../../packages/core/src/bin.ts report          # re-render one, no re-run

# UI, once a browser exists: pnpm exec playwright install chromium
node --import tsx ../../packages/core/src/bin.ts run --test suites/ui.yaml
```

## Layout

| Package | What it is |
| --- | --- |
| `@speqkit/plugin-api` | The public contract. Types only. Its major version is the compatibility boundary. |
| `speqkit` | The kernel and the `speq` bootstrap. Unscoped, because it is what you install. Knows no protocol and no UI. |
| `@speqkit/installer` | Resolve, verify, store, lock. No npm CLI involved. |
| `@speqkit/plugin-yaml` | The default authoring format — and proof the format is a plugin. |
| `@speqkit/plugin-http` | HTTP steps and the smoke assertion set. |
| `@speqkit/plugin-cli` | The terminal surface. Publishes the `cli` service. |
| `@speqkit/plugin-loop` | `loop` and `retry`. Control flow, contributed rather than built in. |
| `@speqkit/plugin-junit` | JUnit XML for CI, built from the event stream and nothing else. |
| `@speqkit/plugin-playwright` | Browser steps, scoped browser/page resources, screenshot artifacts. Playwright is an optional peer dependency. |

Every `plugin-*` above depends on `@speqkit/plugin-api` and on nothing else of
ours — never on the kernel. A plugin runs *inside* a kernel and reaches it as
`ctx.host`; one that imports `speqkit` instead ships a second kernel in
its `dependencies`, which the installer will faithfully put in the store and
the plugin will faithfully boot. `packages/core/test/host.test.ts` fails if any
manifest here names the kernel, and `scripts/verify-publish.mjs` fails if one
ever reaches the store.

## Using it in a repository that is not a Node project

```bash
brew install speqkit             # or: curl -fsSL .../install.sh | sh
                                 # or: npm i -g speqkit, if Node is there
                                 # you install speqkit, you type speq
speq init                        # scaffold .speq/
speq add @speqkit/plugin-postgres   # edits speq.yaml, resolves, writes speq.lock
speq install --frozen            # CI: exactly the lock, or fail
speq link ../speqkit-plugin-mine    # a plugin you are writing, no publish needed
speq doctor                      # environment, store, and what came from where
```

Nothing lands in the repository except `.speq/` and `speq.lock`. The plugins
live in `~/.speq`, shared across every project on the machine.

## In CI

```yaml
- run: speq install --frozen                     # exactly the lock, or fail
- run: speq run --env ci --reporter console,junit
- uses: actions/upload-artifact@v7
  if: always()
  with: { name: speq-report, path: .speq/reports/ }
```

`--frozen` fails when `speq.lock` has drifted from `speq.yaml`. The exit code
comes from the spine: 0 passed, 1 failed, 2 the configuration was wrong before
anything ran. A misspelled `--reporter` or a missing `${env:VAR}` is caught
before the first test, not twenty minutes into the suite.

## What the kernel owns

Plugin registry and lifecycle · config with `extends` · the test model
(Suite → Test → Step → Assertion) · execution, `${...}` resolution and the
re-entrant `runSteps` · resources scoped to `run | suite | test` · the event
bus · results, artifacts and the run log · validation.

It owns nothing else. There is no protocol, no command, no report format and no
control construct anywhere in `packages/core`.

## The invariants

They are pinned by `packages/core/test/kernel.test.ts`, `gate.test.ts` and
`reporting.test.ts`. If one starts failing, the spine moved and the fix belongs
in the kernel, not in the test.

- A step type the kernel has never heard of runs, contributed at load time.
- A plugin nests steps through `ctx.runSteps` in a child variable scope, and
  that scope does not leak back to the parent.
- Resources open once per scope and tear down in reverse order.
- A plugin contributes to a surface that may not be loaded, and stays usable
  when nobody provides it.
- Two plugins cannot claim the same step type.
- A plugin built against a different `plugin-api` major is refused at load.
- A crash inside a plugin is `error`, never `failed`.
- All three resource scopes are real: `run` outlives the suite, `suite` outlives
  the test, and the outer ones tear down even when a test blows up.
- Bytes handed to `attach` come back out of the run byte-for-byte, and every
  reporter is told where they went.
- A plugin installed from a registry loads out of the store, with its own
  dependencies resolvable, and `--frozen` reproduces it without a network.
- An environment layers settings and cannot add a plugin, so the lock stays
  true whichever environment runs.
- The event stream alone is enough to build a report: replaying a recorded run
  produces a byte-identical file to watching it live.

## Development

```bash
pnpm install
pnpm build          # tsc project references -> dist, with .d.ts and maps
npx tsc --noEmit    # typecheck
npx vitest run      # architecture tests
```

### Before publishing

```bash
pnpm build && node scripts/verify-publish.mjs
```

The tests run against `src` through a bundler alias, and that is exactly the
arrangement that hid a real bug: `exports` pointed at `.ts`, and Node refuses
to strip types inside `node_modules`, so anything published would not have
loaded at all. `verify-publish.mjs` trusts none of it — it packs the real
tarballs, serves them from a throwaway registry over HTTP (proxying anything
that is not ours to npm, since our packages have ordinary dependencies),
installs them into a throwaway store, and runs the CLI out of `dist` with plain
`node`. Then it pulls the plug on the registry and checks `--frozen` still
replays the lock.

### Building the standalone binary

```bash
pnpm build && node scripts/build-binary.mjs
node scripts/verify-publish.mjs --binary build/speq
```

The first command downloads the pinned Node from nodejs.org, checks it against
`SHASUMS256.txt`, bundles `packages/core/dist` into one CommonJS file, and
injects it as a SEA blob. The runtime is downloaded rather than taken from
`process.execPath` for a reason worth knowing before you try to shortcut it: a
package manager's `node` may be a 66 KB stub in front of a shared `libnode`,
with nothing to inject into. The second command is the same battery as above,
pointed at the executable with `PATH` emptied.

Releases are cut by tagging. `.github/workflows/release.yml` builds all four
targets on native runners — cross-compiling is not an option, because the SEA
blob carries a V8 code cache valid only for the exact runtime it goes into,
and only macOS can re-sign a Mach-O after injection.

## License

MIT.
