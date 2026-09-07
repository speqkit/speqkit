# @speqkit/plugin-ui

The project in a browser.

```yaml
# speq.yaml
plugins:
  - cli     # this contributes a command, so the command surface has to be there
  - ui
```

```bash
speq ui
# speq ui: http://127.0.0.1:53412/
#          ctrl-c to stop
```

## What it is for

A suite in `.speq/` is a directory of YAML, and everything about it that is not
literally in the file is invisible in an editor:

- which plugin owns `browser.open`, and what its input is allowed to be
- which suite a test inherits its tags from, and what a `cases` row expanded into
- what `speq validate` thinks of the file you are looking at, right now
- whether this test has been red for a week, or red once

Every one of those is a question the running session can answer. Until there is
somewhere to ask them, the answer is to read our source.

## Three views

**Project** — the suite tree on the left, with a dot for the newest recorded
run and a strip for the last dozen. Pick a test and you get what it says: its
tags, the suites it is inside, its variables, `setup` / `steps` / `cleanup` /
`assert` — **and against every one of them, the plugin that contributed that
word, with that plugin's own sentence about what it does.** The raw file is one
click away, and anything `validate` has to say about it is at the bottom.

**Runs** — every `events.jsonl` under `reports/`, newest first. Open one and it
is the whole run: suites, tests, the nested step tree, `what it did` for any
step that recorded a `detail`, expected against actual on each failing
assertion, and the screenshots served out of that run's own directory. Failing
tests are already open. Any test links back to itself in the Project view,
which is the move somebody makes every single time they read a failure.

**Plugins** — the grammar, as a document. Every loaded plugin, where this
session found it, what it contributes and the JSON Schema of each input, with
the examples it ships. This is `speq capabilities` and `speq docs`, laid out.

## It is a plugin, and that is the point

`plugin-cli` is a plugin; so is this. It reaches for exactly the verbs the CLI
reaches for — `host.discover()`, `host.validate()`, `host.capabilities()`,
`host.runs()` — and not one thing more. If a surface that is not the terminal
had needed a ninth contribution point, that would have been a hole in the
contract; it did not.

The server runs **in the session that already loaded the plugins**. A separate
program reading `.speq/` off disk would have to re-implement discovery, the
loaders and the plugin resolution to answer one question about a step type, and
would answer it differently from the kernel the moment either changed. Here the
page asks the same `ctx.host` the CLI asks, so what it shows is what a run
would do.

## Read-only, on purpose

There is no Run button. `RunRequest` has no cancellation signal, so a button in
a browser would start something against a real system that the browser cannot
stop — and a suite against a real system is exactly the thing you want to be
able to stop. The roadmap names that as the blocker for the stop button, and a
start button without one is worse than neither.

## What it serves, and to whom

It binds `127.0.0.1`, and that default deserves a sentence rather than a
shrug: this serves **the source of every test in the project and every response
body every run recorded**, with no authentication, to whoever asks. On a shared
network that is the whole project.

```bash
speq ui --port 4000 --no-open
speq ui --host 0.0.0.0        # says out loud what you have just done
```

```yaml
ui:
  port: 4000
  open: false
```

Three things the server does about it:

- Every path is resolved and then checked to be *inside* the directory it
  belongs to — `..` arrives encoded, doubled and through symlinks, and only
  asking where the path actually landed answers all three at once.
- Nothing but `GET` is answered at all.
- `x-content-type-options: nosniff` on everything, and an artifact captured as
  `.html` is served as `text/plain`. An artifact is a file the system under test
  produced; served as HTML on this origin it would run next to everything else
  the page can read.

The page itself is built with `createElement` and `textContent` throughout,
never string concatenation — for the same reason.

## Reading a report somebody downloaded from CI

```bash
unzip speq-report.zip -d .speq/
speq ui
```

A `reports/` directory is self-describing: the runs, the artifacts and the
event logs are all in it. Unpack it into the project and every run in it is one
this can open, screenshots included.

## Nothing to build

The page is one HTML document with the styles and the script inline. No
bundler, no framework, no CDN — a `<script src>` pointing at somebody else's
server is a panel that goes blank on an aeroplane and on a build agent with no
egress, and a build step between this repository and a working `speq ui` is a
build step that will one day be stale in somebody's install.
