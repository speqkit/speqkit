# @speq/plugin-api

The only surface a plugin author sees. Types only — no runtime, no kernel
internals, nothing that can drift.

Its major version is the compatibility boundary: the kernel refuses to load a
plugin built against a different major, with a message rather than a crash
halfway through a run. Adding is a minor. Changing or removing is a major.

```ts
import { definePlugin } from '@speq/plugin-api'

export default definePlugin({
  name: 'speq-plugin-example',
  setup(ctx) {
    ctx.defineStepType('example', {
      schema: { type: 'object', properties: { value: {} }, required: ['value'] },
      execute: (exec, input) => ({ echoed: input.value })
    })
  }
})
```

## Stability

**0.x — nothing here is stable.** It changes without warning while the spine is
still being proven against real plugins.

**1.0 will freeze this package for the whole major**, with at least a twelve
month window on the previous one. Until that line is in this README, do not
build anything you cannot afford to rewrite.
