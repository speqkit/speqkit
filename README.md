# speq-next

A test framework that is mostly plugins.

The kernel loads plugins and gets out of the way. HTTP, the CLI, the authoring
format, control flow, reporters — every one of them is a plugin, including the
ones that ship in the box. A tester who needs something we did not build writes
it and publishes it; nothing needs to be agreed with us first.

> Working name. The npm name `speq` is taken by an abandoned placeholder, and
> `@speq-ai/speq` is an unrelated project. See `docs/architecture/`.

## Status

M0 and M1 are built. `plugin-loop` was written against the published API with
**no kernel changes**, which is the gate the design set for itself.

## Try it

```bash
corepack enable && pnpm install
cd examples/basic

node --import tsx ../../packages/core/src/bin.ts plugins   # what is loaded
node --import tsx ../../packages/core/src/bin.ts validate  # catches typos, no network
node --import tsx ../../packages/core/src/bin.ts run --test suites/loop.yaml
```

## Layout

| Package | What it is |
| --- | --- |
| `@speq/plugin-api` | The public contract. Types only. Its major version is the compatibility boundary. |
| `@speq/core` | The kernel and the `speq` bootstrap. Knows no protocol and no UI. |
| `@speq/plugin-yaml` | The default authoring format — and proof the format is a plugin. |
| `@speq/plugin-http` | HTTP steps and the smoke assertion set. |
| `@speq/plugin-cli` | The terminal surface. Publishes the `cli` service. |
| `@speq/plugin-loop` | `loop` and `retry`. Control flow, contributed rather than built in. |

## What the kernel owns

Plugin registry and lifecycle · config with `extends` · the test model
(Suite → Test → Step → Assertion) · execution, `${...}` resolution and the
re-entrant `runSteps` · resources scoped to `run | suite | test` · the event
bus · results and artifacts · validation.

It owns nothing else. There is no protocol, no command, no report format and no
control construct anywhere in `packages/core`.

## The invariants

They are pinned by `packages/core/test/kernel.test.ts`. If one starts failing,
the spine moved and the fix belongs in the kernel, not in the test.

- A step type the kernel has never heard of runs, contributed at load time.
- A plugin nests steps through `ctx.runSteps` in a child variable scope, and
  that scope does not leak back to the parent.
- Resources open once per scope and tear down in reverse order.
- A plugin contributes to a surface that may not be loaded, and stays usable
  when nobody provides it.
- Two plugins cannot claim the same step type.
- A plugin built against a different `plugin-api` major is refused at load.
- A crash inside a plugin is `error`, never `failed`.

## Development

```bash
pnpm install
npx tsc --noEmit    # typecheck
npx vitest run      # architecture tests
```

## License

MIT.
