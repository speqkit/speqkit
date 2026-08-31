# @speqkit/plugin-cli

The terminal surface: `run`, `report`, `validate`, `list`.

```yaml
# speq.yaml
plugins:
  - cli
```

```bash
speq run [--env ci] [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b] [--reporter a,b] [--workers N]
speq report [--run <id>] [--list] [--reporter a,b]
speq validate
speq list
```

## Four flags choose the tests

`--test` takes a file, `--suite` a directory, `--tags` a label. `--name` takes
the test's own name, which is the only one of the four that addresses a single
test:

```bash
speq run --name 'menu.create[jpy]'
```

Reading a report and wanting to re-run exactly that row is the commonest thing
anybody does, and until this flag it meant running the file and watching the
other nine. All four apply to `run`, `validate` and `list` alike.

## It is a plugin, and that is the point

Remove it and the framework still runs — from a VS Code extension, from a TUI,
from someone's own harness. The kernel keeps only the commands that must work
before plugins are loaded (`install`, `add`, `link`, `doctor`); everything a
person thinks of as *using* the framework lives here and could be replaced
wholesale.

It publishes the `cli` service, which is how any other plugin contributes a
command without depending on a terminal existing:

```ts
import type { CommandHost } from '@speqkit/plugin-api'

ctx.inject(['cli'], (services) => {
  const cli = services.cli as CommandHost
  cli.register('db:seed', { summary: 'load fixtures', run: async () => 0 })
})
```

`inject` and not a plain lookup: in VS Code there is no `cli` service, the
callback never fires, and the plugin stays perfectly usable.

## The console output is an ordinary reporter

It used to subscribe to the event bus directly, which meant the default path
went *around* `defineReporter` and left the mechanism untested by anything a
user actually runs. It is now registered as the reporter named `console` and
is the default value of `--reporter`, so the most common command in the
framework exercises the extension point every time.

`--reporter console,junit` drives both. An unknown name fails before the first
test rather than after the last one.

The console reporter holds a test's output until the test is over and then
prints the block whole, because with `--workers` above one two tests are open
at once and printing each event as it arrives puts one test's steps under
another test's header.

A step printed with a suite beside it — `. tenant (http)  suites/menu` —
belongs to that suite rather than to a test: it is the suite's own setup or
cleanup, and there is no test header above it to inherit.

## `--workers N` runs N suites at once

One by default, and one is not a placeholder. Every other runner defaults to
the CPU count because its bottleneck is the local processor; speq's is somebody
else's service, and `--workers 8` is eight times the load on the system under
test. Step timeouts start firing where they did not fire in sequence, which
means the number could change a verdict — so nothing guesses it, and there is
no `auto`.

Concurrency is between suites and nowhere else. A test runs whole, interleaved
with nothing; the tests inside one suite stay sequential, so a suite's hooks
and its `suite`-scoped resources behave exactly as they did. A suite that fails
frees its slot rather than stopping the run.

`--workers 0`, `--workers auto` and `--workers 2.5` are refused before anything
is discovered, rather than quietly falling back to one — a twenty-minute suite
that pretends to obey is worse than one that says no.

## It does not import the kernel

Every command here drives the running session through `ctx.host` —
`discover`, `validate`, `run`, `runs`, `replay`. This package's manifest names
only `@speqkit/plugin-api`, as a peer.

That is not tidiness. Importing `speqkit` put the kernel in this plugin's
published `dependencies`, so `speq install` materialised a second copy into the
store and pinned it in `speq.lock`; and it made this file call `bootstrap()`
inside a process that had already booted one, loading every plugin twice into
two registries that could not see each other. This plugin is what a
third-party plugin gets copied from, so whatever it does, the ecosystem does.

## `--env` and `--speq-root`

Both are parsed by the kernel before dispatch, not here. By the time a command
runs, the session already has the right root and the right environment layered
on top.

MIT.
