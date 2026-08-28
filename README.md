# speq-next

A test framework that is mostly plugins.

The kernel loads plugins and gets out of the way. HTTP, the CLI, the authoring
format, control flow, reporters — every one of them is a plugin, including the
ones that ship in the box. A tester who needs something we did not build writes
it and publishes it; nothing needs to be agreed with us first.

> Working name. The npm name `speq` is taken by an abandoned placeholder, and
> `@speq-ai/speq` is an unrelated project. See `docs/architecture/`.

## Status

M0, M1 and the architecture gate are done; M2 is most of the way there.

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
and `link` work. The standalone binary and `github:` specs do not yet; see
`packages/installer/README.md`.

## Try it

```bash
corepack enable && pnpm install
cd examples/basic

node --import tsx ../../packages/core/src/bin.ts plugins   # what is loaded
node --import tsx ../../packages/core/src/bin.ts validate  # catches typos, no network
node --import tsx ../../packages/core/src/bin.ts run --test suites/loop.yaml

# UI, once a browser exists: pnpm exec playwright install chromium
node --import tsx ../../packages/core/src/bin.ts run --test suites/ui.yaml
```

## Layout

| Package | What it is |
| --- | --- |
| `@speq/plugin-api` | The public contract. Types only. Its major version is the compatibility boundary. |
| `@speq/core` | The kernel and the `speq` bootstrap. Knows no protocol and no UI. |
| `@speq/installer` | Resolve, verify, store, lock. No npm CLI involved. |
| `@speq/plugin-yaml` | The default authoring format — and proof the format is a plugin. |
| `@speq/plugin-http` | HTTP steps and the smoke assertion set. |
| `@speq/plugin-cli` | The terminal surface. Publishes the `cli` service. |
| `@speq/plugin-loop` | `loop` and `retry`. Control flow, contributed rather than built in. |
| `@speq/plugin-playwright` | Browser steps, scoped browser/page resources, screenshot artifacts. Playwright is an optional peer dependency. |

## Using it in a repository that is not a Node project

```bash
speq init                        # scaffold .speq/
speq add @speq/plugin-postgres   # edits speq.yaml, resolves, writes speq.lock
speq install --frozen            # CI: exactly the lock, or fail
speq link ../speq-plugin-mine    # a plugin you are writing, no publish needed
speq doctor                      # environment, store, and what came from where
```

Nothing lands in the repository except `.speq/` and `speq.lock`. The plugins
live in `~/.speq`, shared across every project on the machine.

## What the kernel owns

Plugin registry and lifecycle · config with `extends` · the test model
(Suite → Test → Step → Assertion) · execution, `${...}` resolution and the
re-entrant `runSteps` · resources scoped to `run | suite | test` · the event
bus · results and artifacts · validation.

It owns nothing else. There is no protocol, no command, no report format and no
control construct anywhere in `packages/core`.

## The invariants

They are pinned by `packages/core/test/kernel.test.ts` and `gate.test.ts`. If
one starts failing, the spine moved and the fix belongs in the kernel, not in
the test.

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

## Development

```bash
pnpm install
npx tsc --noEmit    # typecheck
npx vitest run      # architecture tests
```

## License

MIT.
