# @speqkit/plugin-cli

The terminal surface: `run`, `report`, `validate`, `list`, `capabilities`.

```yaml
# speq.yaml
plugins:
  - cli
```

```bash
speq run [--env ci] [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b] [--reporter a,b] [--workers N] [--shard i/n] [--json]
speq report [--run <id>] [--list] [--reporter a,b]
speq validate [--json]
speq list [--shard i/n] [--json]
speq capabilities [--json]
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

## `--shard i/n` gives this machine its slice

`--workers` is one machine doing more at once. `--shard` is n machines each
doing part of it — an independent run apiece, with its own `events.jsonl` and
its own JUnit XML, merged by CI the way it merges everything else. They
compose: `speq run --shard 2/4 --workers 3` is the second quarter, three suites
at a time.

It is not a fifth selection flag. The other four say which tests you care
about; this one says you care about all of them and there are n machines. So it
applies to what discovery returned, and it applies last — sharding a selection
is a sensible thing to want, selecting out of a shard is not:

```bash
speq list --test suites/orders/matrix.yaml --shard 1/2   # half of that file
```

**The slice is by test, not by file**, and the slices are contiguous. Slicing
by file would keep a file whole, but a table of a thousand `cases` is one test
in one file — so the case shards exist for would be the one case they could not
split. What that costs is a file on a boundary, whose `suite`-scoped resources
are then set up in both shards; a contiguous cut pays it for at most n-1 files
in the whole run, where `i % n` would pay it for every file with more than one
test in it. And the cost is already there one level up: a shard is a separate
process, so a directory suite's setup already runs once per shard however the
slice is cut. One sentence covers both — **a shard is an independent run, and
every suite that has work in it opens in it.**

`speq list --shard i/n` takes the flag too, because the property worth checking
— n shards between them run each test exactly once — is checkable without
running anything.

`--shard 2`, `--shard 0/4`, `--shard 5/4` and `--shard a/b` are refused before
discovery. A machine that quietly ran the whole suite after being asked for a
quarter of it is four times the work with nothing saying so.

One thing to know when the shards are on **one** machine: `reports/<runId>/` is
per run and never collides, but `junit.xml` is a stable path on purpose, so four
shards in one working directory overwrite one file. Give each a different
`junit.output`, or do what CI does and put them on four machines.

## `--json` answers a program

`run`, `validate` and `list` each take `--json` and write one document to
stdout instead of prose to the terminal.

```bash
speq validate --json
```

```json
{
  "checked": 12,
  "diagnostics": [
    {
      "file": "suites/orders/create.yaml",
      "path": "steps[0].type",
      "code": "unknown-step-type",
      "message": "unknown step type 'htpp'",
      "hint": " — did you mean 'http'?"
    }
  ]
}
```

**`code` is the field to switch on.** The message is a sentence written for a
person and may be reworded in any release; the code is a slug and may not. It
is what lets a caller tell a step type that does not exist from one whose input
is malformed without matching substrings of coloured stderr — which is the
difference between a generated suite that can be repaired and one that cannot.
The kernel's codes are bare words (`unknown-step-type`, `unknown-assertion`,
`missing-field`, `unknown-field`, `duplicate-test-name`, `duplicate-step-id`,
`test-has-no-steps`, `pending-needs-reason`, `case-has-no-id`, …); anything a
plugin's own `validate` found is prefixed with that plugin's short name —
`http/unknown-topic` — so the two sets can never collide.

`run --json` prints one document when the run is over: the counts, and per test
its identity and its `failures`, present and empty on a green one. What
compared badly is in there, `expected` and `actual` included; everything else —
every step, every artifact — is in the report already written under `runDir`.
It also prints a document when it refuses to start, with `"status": "invalid"`
and the diagnostics, or `"status": "no-tests"`.

Two rules worth knowing. The document goes to **stdout even when the news is
bad** — stderr keeps what went wrong with the *command*, such as a malformed
`--shard`, which is a bug in the caller rather than a result to read. And
`--json` replaces the **default** reporter, not a chosen one: `--json
--reporter junit` still writes the XML, because a document on stdout and a file
on disk answer different callers. Exit codes do not move: 0 passed, 1 something
failed, 2 nothing ran.

## `speq capabilities` is the grammar itself

```bash
speq capabilities          # for you
speq capabilities --json   # for a program
```

Every step type, assertion, value provider, reporter and loader the loaded
plugins define, with the `InputSchema` each declared. In the terminal a star
marks a field the schema requires; the rest of the schema is in `--json`.

The schemas have been in the registry since the plugin that owns them
registered, and could not be reached from outside the process. So an editor
offering completion, a palette in a panel and a system prompt describing speq
to a model each carried a copy of the vocabulary — one that goes stale the
moment somebody installs a plugin, and goes stale *silently*, because a suite
written against the wrong vocabulary looks exactly like a suite with a typo in
it. Asking the session instead means the answer is true for this project.

`speq plugins` is the other half of the same question and stays what it is:
who is loaded, grouped by owner. This one is grouped by kind and carries the
schemas — what may be written, rather than who brought it.

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
