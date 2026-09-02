# @speqkit/plugin-api

The only surface a plugin author sees. Types only — no runtime, no kernel
internals, nothing that can drift.

Its major version is the compatibility boundary: the kernel refuses to load a
plugin built against a different major, with a message rather than a crash
halfway through a run. Adding is a minor. Changing or removing is a major.

```ts
import { definePlugin } from '@speqkit/plugin-api'

export default definePlugin({
  name: 'speqkit-plugin-example',
  setup(ctx) {
    ctx.defineStepType('example', {
      // What shape the input has …
      schema: { type: 'object', properties: { value: {} }, required: ['value'] },
      // … and whether it means anything. Both run before the suite does.
      validate: (step) => (step.value === '' ? [{ path: 'value', message: "'value' is empty" }] : []),
      execute: (exec, input) => ({ echoed: input.value })
    })
  }
})
```

## A plugin never imports the kernel

This package is the only `@speqkit/*` a plugin may depend on, and it belongs in
`peerDependencies`:

```json
{
  "peerDependencies": { "@speqkit/plugin-api": "^0.4.0" },
  "devDependencies":  { "@speqkit/plugin-api": "^0.4.0" }
}
```

Everything a plugin needs from the running kernel arrives as `ctx.host`:

```ts
setup(ctx) {
  ctx.provide('report-mailer', {
    async rerun() {
      const tests = await ctx.host.discover({ tags: ['smoke'] })
      const outcome = await ctx.host.run(tests, { reporters: ['junit'] })
      return outcome.status
    }
  })
}
```

`ctx.host` is the session the plugin is already executing inside — not a way to
start another, which is why there is no `bootstrap` on it. Reaching for
`speqkit` instead costs two things, both of them silent: the installer
sees a kernel in your `dependencies` and materialises a second copy of it into
the store, and `bootstrap()` inside an already-booted process loads every
plugin a second time into a registry nobody else can see. Whichever kernel then
answers is decided by `speq.lock`, not by the `speq` the user installed.

The kernel and the plugin agree on the major of *this* package, checked as
`apiVersion` when the plugin loads. That is the whole of the compatibility
contract, and it is why a plugin needs no version of the kernel at all.

## Stability

**0.x — nothing here is stable.** It changes without warning while the spine is
still being proven against real plugins.

**1.0 will freeze this package for the whole major**, with at least a twelve
month window on the previous one. Until that line is in this README, do not
build anything you cannot afford to rewrite.

## Changes

Numbered by what is **on npm**: `0.4.0`, `0.9.0`, `0.10.0`. Everything below
`0.4.0` was a change to the contract in this repository before anything was
published from it, and the entry it landed under is kept as written.

**Unreleased** — `Host` gained `capabilities()`, and with it `Capabilities` and
`Capability`: every step type, assertion, value provider, reporter and loader
the loaded plugins define, with the `InputSchema` each declared. The schemas
had been in the registry since the plugin that owns them registered and could
not be reached from outside the process, so an editor offering completion, a
palette in a panel and a system prompt describing speq to a model each carried
a copy of the vocabulary — one that goes stale the moment somebody installs a
plugin, and goes stale silently, because a suite written against the wrong
vocabulary looks exactly like a suite with a typo in it.

Also unreleased: `Diagnostic` gained a required `code` and `ValidationProblem`
an optional one. The message is written for a person and may be reworded in any
release; the code is written for a program and may not — it is what lets a
caller tell a step type that does not exist from one whose input is malformed
without matching substrings of coloured output. The kernel's codes are bare
words; whatever a plugin's own `validate` returns is prefixed by the kernel
with that plugin's short name — `http/unknown-topic`, or `http/invalid` when
the plugin named none — so a plugin can add codes for as long as it likes and
never collide with one the kernel means to use. Added members on things the
kernel produces, so every 0.10.0 plugin still satisfies the contract and
`PLUGIN_API_VERSION` stays at `1`.

**0.10.0** — `SuiteDef` and `CaseDef`; `LoaderDef.suiteFiles` and
`LoaderDef.loadSuite`, so a loader can declare suites without reimplementing
the tree, the identity or the inheritance; `TestDef.cases`, `TestDef.group`
and `TestDef.suites`; `RunRequest.concurrency`; `DiscoverQuery.names`;
`TestOutcome.group`; `ValidateContext.suite`. `suite.started` gained `parent`,
`title` and `pending`, and `test.started` gained `group`. No ninth contribution
point was opened — a suite was tried as a plugin first, and the experiment came
back no: grouping, identity and inheritance are all settled before any hook
fires. `PLUGIN_API_VERSION` stays at `1`.

**0.9.0** — `StepDef.assert`, `TestDef.setup` and `TestDef.cleanup`;
`TestDef.variables`, resolved one at a time in declaration order; `meta`, which
the kernel carries and never reads; and `pending`, which takes a reason rather
than a flag. Four gaps in the model, every one of them closed by a field on the
spine rather than by a new contribution point.

Also in 0.9.0: `StepTypeDef` and `AssertionTypeDef` gained an optional
`validate`, and with it `Validator`, `ValidateContext` and
`ValidationProblem`. A schema settles the shape of an input and nothing more,
so anything a plugin knows *about* an input — that the schema file an assertion
names is on disk, that `over` and `times` exclude each other, that a topic is
one of the configured ones — had nowhere to be said but the middle of a run,
from a step type that cannot name the file the mistake is in. The kernel keeps
the walk and the addressing: a plugin returns messages and, at most, a path
inside its own step. Synchronous on purpose — validation runs in front of every
run and is expected to cost milliseconds, so reading a file is fine and a
network call is not; a validator that throws is reported as a bug in the plugin
and the rest of the diagnostics still come back. Optional members on existing
interfaces, so every 0.4.0 plugin still satisfies the contract and
`PLUGIN_API_VERSION` stays at `1`.

And in 0.9.0, with no change to any type: `ValueProviderDef.resolve` has
always been declared as `unknown | Promise<unknown>`, and the kernel now
honours it. It used to drop the Promise itself into the request body, silently.
A provider is asked once per resolution pass and every key a step needs is
awaited at once; `ExecContext.resolve` stays synchronous, and throws where a
template it is handed names an asynchronous provider.

**0.4.0** — `PluginContext` gained `host`, and with it `Host`, `Diagnostic`,
`ArtifactRecord`, `RunOutcome`, `TestOutcome`, `RecordedRun`, `DiscoverQuery`
and `RunRequest`. A plugin that needed to discover, validate, run or replay
had no way to ask the kernel and so imported `speqkit` — which put the
kernel in the plugin's published `dependencies` and had the installer place a
second copy of it in the store, while the plugin called `bootstrap()` inside a
process that had already booted one. Added members only, so every 0.3.0 plugin
still satisfies the contract and `PLUGIN_API_VERSION` stays at `1`.

**0.3.0** — `ReporterDef` gained an optional `init(ctx)` carrying `runId`,
`outputDir` and `runDir`. A reporter that writes a file could not previously
learn where to write it: the run's directory does not exist until the run
starts. Optional method on an existing interface, so every 0.2.0 reporter still
satisfies it, and `PLUGIN_API_VERSION` stays at `1`.

**0.2.0** — `artifact.attached` gained `path`, set when the run wrote the body
somewhere. Added field, so plugins built against 0.1.0 keep working and
`PLUGIN_API_VERSION` stays at `1`. This is the versioning rule doing its job on
its first real occasion, rather than a rule we only wrote down.
