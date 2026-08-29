# @speqkit/test-kit

Test a speq plugin against the real kernel, without a project.

```bash
npm i -D @speqkit/test-kit speqkit
```

```ts
import { afterEach, expect, it } from 'vitest'
import { harness, type Harness } from '@speqkit/test-kit'
import plugin from '../src/index.js'

let kit: Harness
afterEach(async () => { await kit.close() })

it('sends the request it was told to', async () => {
  kit = await harness(plugin, { config: { http: { baseUrl: 'http://localhost:3000' } } })

  const step = await kit.step({ type: 'http', method: 'GET', url: '/health' })

  expect(step.status).toBe('passed')
  expect(step.result.status).toBe(200)
})
```

## There are no fakes in here

A mock `ExecContext` would be a second implementation of
`@speqkit/plugin-api` — written by us, drifting from the first — and the only
thing it could ever prove is that your plugin agrees with our mock. What you
need to know is that the plugin works inside speq.

So the kit assembles the actual `Registry`, the actual `Executor` and the
actual runner, and adds only the two things a plugin cannot get from them by
hand: a project root on disk, and a resource scope held open between calls.

That is also why `speqkit` is a **peer** dependency here. You test against the
kernel you intend to support, and there is one kernel in the tree.

## What a harness gives you

```ts
const kit = await harness(plugin, {
  with: [otherPlugin],   // a surface to contribute into, a step type to wrap
  config: { http: {} },  // your block in speq.yaml, keyed by short name
  root: '/some/dir',     // default: a temp dir, removed on close()
  artifacts: false       // default: attachments stay in memory
})
```

| | |
|---|---|
| `kit.step(def, vars?)` | run one step; returns the record plus what it attached |
| `kit.steps(defs, vars?)` | several, stopping at the first failure |
| `kit.assert(def, { last? })` | evaluate one assertion over what the steps produced |
| `kit.resource(name)` | acquire a resource, in scopes the kit holds open |
| `kit.endTest()` | close and reopen the `test` scope, to watch teardown |
| `kit.run(tests, reporters?)` | whole tests, through the runner |
| `kit.validate(tests)` | the diagnostics a bad test would produce |
| `kit.discover(query?)` | ask your loader what tests exist under the root |
| `kit.file(path, content)` | write a fixture under the root |
| `kit.events`, `kit.eventsOf(type)` | everything the run emitted |
| `kit.host`, `kit.registry`, `kit.root` | the escape hatches |
| `kit.close()` | tear down every scope, remove the temp root |

## Things worth knowing

**Steps share a scope.** `kit.step({ id: 'a', … })` binds its result, so the
next call can say `${a.field}` exactly as a test file does. `kit.endTest()`
clears it.

**`ctx.host` is real.** A hand-built `Registry` has no session, and every
`ctx.host` call on one throws. The kit attaches a host rooted at `kit.root`, so
a plugin that reads `host.root` or calls `host.discover()` is testable.

**Config is keyed by short name.** `@speqkit/plugin-http` and
`speqkit-plugin-http` both read `config.http` — the same rule speq.yaml uses.

**`run()` opens its own scopes**, the way a real run does. A resource you
acquired through `kit.resource()` is not the one a test inside `run()` sees.
That is not a quirk of the kit; it is what happens in a project.

**Assertions resolve their input.** `kit.assert({ type: 'status', expected:
'${a.code}' })` goes through the same resolution the runner applies, so the
assertion you test is the one users write.

## Starting from nothing

```bash
npm create speqkit-plugin my-thing
```

`create-speqkit-plugin` scaffolds a plugin with these tests already written.

MIT.
