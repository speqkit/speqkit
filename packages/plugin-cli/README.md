# @speqkit/plugin-cli

The terminal surface: `run`, `report`, `validate`, `list`.

```yaml
# speq.yaml
plugins:
  - cli
```

```bash
speq run [--env ci] [--test <file>] [--suite <dir>] [--tags a,b] [--reporter a,b]
speq report [--run <id>] [--list] [--reporter a,b]
speq validate
speq list
```

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
