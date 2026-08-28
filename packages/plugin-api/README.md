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
      schema: { type: 'object', properties: { value: {} }, required: ['value'] },
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
