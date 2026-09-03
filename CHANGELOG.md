# Changelog

What changed in **the thing you install** — `speqkit`, the kernel behind the
`speq` command. Its version is what names a release: when it moves, four
executables, a GitHub release and the Homebrew formula follow it, and the
plugins that went out alongside are listed under the entry.

The plugins are versioned independently and most releases move only some of
them, so the tables below are the record of what a given `speq` was published
with. A plugin's own README is where its behaviour is documented.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project is on [semantic versioning](https://semver.org/) — pre-1.0, so a
**minor** bump is where a breaking change is allowed to live, and a caret range
on `0.x` pins the minor for exactly that reason.

## [0.5.0] — 2026-09-03

A kernel-only release the day after 0.4.0, and the reason it is one: 0.4.0
gave every diagnostic a `code` so a program need not read prose, and left the
failures that happen *before* validation still answering in prose only. Same
removal, one layer earlier.

### Added

- **A refusal to start carries a code, and `--json` gets a document.**
  `bootstrap()` is four steps — find the project, read the config, load the
  plugins, hand over control — and each of the first three can refuse. Every
  refusal was a bare `Error` printed as prose, so telling "there is no
  speq.yaml here" from "this speq.yaml is from a later build" from "that
  plugin is declared but not installed" meant matching substrings of a
  sentence written for a person and rewordable in any release. 0.4.0 removed
  exactly that obligation from validation by putting a `code` on every
  `Diagnostic`; this is the same removal one layer earlier, on the failures
  that happen before there is a suite to have diagnostics about.
  - **`StartupError`, with `STARTUP_CODES` beside it** — nineteen bare words,
    exported from the kernel so an embedder can branch on one, and pinned by a
    test in one assertion, which is where a rename gets noticed. It is
    deliberately not a `Diagnostic`: a diagnostic names a `file` and a `path`
    inside it because it is about a test somebody wrote, and none of these
    are. Giving them an empty `file` would make every consumer of diagnostics
    handle a case that is not one.
  - **`{"status": "not-started", "error": {"code", "message"}}` on stdout**
    when the caller asked for `--json`. `speq run --json` used to answer a
    wrong `speq.yaml` with an empty stdout, so the script parsing it fell over
    somewhere other than where the problem was. `not-started` rather than
    `error` or `invalid`, both of which are taken and would be ambiguous:
    `error` is a run status meaning the question was never asked, and
    `invalid` carries `diagnostics`, which a caller would look for and find
    missing.
  - **The line is who the news is about.** `plugin-cli` already drew it inside
    a run: a malformed `--shard` stays prose on stderr, because a caller that
    wrote it has a bug in itself rather than a result to read, while anything
    true about the *project* is a document. A config from a later build is a
    fact about the project. A crash is neither, has no code, and gets no
    document — dressing one up as a result would tell a caller the project is
    wrong when the kernel is.
  - Exit codes do not move. A refusal was `2` and stays `2`.

`StartupError` is thrown by the kernel and caught by whoever started it, so
nothing about it is in the plugin contract.

### Published with this release

| Package | Version |
| --- | --- |
| `speqkit` | 0.5.0 |
| `@speqkit/test-kit` | 0.4.0 |
| `create-speqkit-plugin` | 0.4.0 |

Three, not fifteen. The contract did not move, so no plugin's peer range on it
went stale and no plugin had to be republished to keep one current — which is
the whole point of `PLUGIN_API_VERSION` and the package's semver doing
different jobs. What did move is `speqkit`, and the two packages that name a
range on the kernel move with it: `@speqkit/test-kit` peers on it, and
`create-speqkit-plugin` writes it into every project it scaffolds.

## [0.4.0] — 2026-09-03

The release where a run answers a caller that is not a person. `--json` on the
three commands that had none, a code on every diagnostic, the exchange behind a
failed step, the vocabulary as a document that can be asked for rather than
copied, and a plugin that says what it is *for*. They are five shapes of one
question, and the answer to it is what an agent needs in order to write a fix
rather than describe a screenshot of one.

The contract moves again, additively: `Host` gains `capabilities()`,
`Diagnostic` gains a required `code`, a step can put what it was doing into the
event stream, a test carries its tags and its suite there, and a plugin can say
what it is for. Nothing published is broken by any of them — every one is a new
member on something the kernel already produces — but a caret range on `0.x`
pins the minor, so this release moves `@speqkit/plugin-api` and every in-box
plugin's peer range with it, in one commit. A plugin left behind makes an
install pull two copies of the contract.

**This is not 1.0, and `PLUGIN_API_VERSION` stays `1`.** The two numbers do
different jobs and neither one is a freeze. The freeze is the sentence in
`@speqkit/plugin-api`'s README, and it is not written here: `RunEvent` moved
three times in this release alone — `detail`, `tags`, `suite` — and the last of
those exists because two reporters were reading adjacency that G4 had taken
away. A spine that moved three times in one milestone has no business promising
twelve months of anything. `PLUGIN_API_VERSION` is the loadability handshake and
is checked for equality, so moving it would refuse every published plugin at
once and buy nothing, since every change here is an addition.

`@speqkit/plugin-cli` **0.4.0** went out on its own before this, carrying
`--shard`: a plugin's version moves independently, and `speq` loads plugins at
run time rather than baking them into the executable, so a standalone binary
picked it up without being rebuilt.

### Added

- **`speq docs [<name>] [--json] [--check]`** — what a plugin is *for*, and
  what one line of it looks like. `speq plugins` says who is loaded and
  `speq capabilities` says what may be written with the schemas; neither
  answered the question somebody has a minute after `speq add`. That answer
  lived in a README on a website — a document a session cannot ask, cannot
  check, and which is wrong the moment somebody renames a step type. It is a
  bootstrap command beside `plugins` and `doctor`, because it is asked *about*
  the installation.
  - **`PluginDocs` on `definePlugin`** — a summary, a readme link, and examples
    that each name with `for` the capabilities they demonstrate. Plus `summary`
    on every contribution def, so `speq capabilities` now carries a sentence
    beside each schema rather than a shape with no meaning attached. Every
    plugin in the box declares one.
  - **`speq docs --check` is what keeps it true.** An example naming a step
    type that no longer exists is an error, because that is exactly what a
    rename leaves behind. A capability no example demonstrates is reported and
    changes no exit code — some genuinely need none, and failing on it would
    buy an example per entry rather than an example worth reading.
  - **Optional on the type, required by the gates.** A fixture plugin declared
    inside a test has no documentation and should not have to say so, so the
    obligation lands where a package meets a registry:
    `check-plugin-package.mjs` fails a plugin that declares none, and
    `create-speqkit-plugin` scaffolds the block, the README section and the
    test that checks it.
- **`speq modules [--json]`, from `@speqkit/plugin-use`** — the blocks, actions
  and fixtures *this project* has, with what each has to be called with and a
  `use` step ready to paste. `speq docs` answers what the plugins offer, which
  is the same in every project that installed them; this answers the half that
  differs per project and is written down nowhere. A module action is a file
  somebody wrote last quarter, and a newcomer and a generator answer that the
  same way — by reaching for `http` and rebuilding a login that already
  existed. In the plugin rather than the kernel: `use` owns the three forms, so
  `use` owns the catalogue.
- **A test names its own suite** — `suite` on `test.started`. It used to be
  said only by the bracketing, and the bracketing is adjacency, which G4 takes
  away the moment two suites run at once.
  - **This was a live defect in `@speqkit/plugin-json`.** It took a test's
    suite from the last `suite.started` and a test's messages from a single
    `#current` slot, so at `--workers 2` tests were filed under the wrong suite
    and a failure's message landed on somebody else's row. It is exactly the
    fault M5 fixed in `plugin-junit`; it survived here because a reporter is
    only ever wrong on the inside — the run's exit code is the runner's, and it
    stayed right. `summary.json` keeps its `suite` field, whose shape is
    somebody else's contract; the stream learned to answer for it instead.
- **`@speqkit/plugin-gate` 0.1.0** — which tests answer for the work in hand,
  and whose fault it is when they are red. `speq gate plan` prints the
  selection *and why it is that one*; `speq gate` runs it and exits on the
  verdict; `speq gate diff` names what this branch did to the acceptance tests.
  The key comes from `--key`, then `gate.key`, then the branch it is checked
  out on. It defines no step type and no assertion: what a test does belongs to
  the transport plugins, and this is the layer above a run.
  - **It reads no specification, in any format.** A requirement and a test are
    joined by a tag somebody wrote and by nothing else. What to cover is a
    team's decision, and a plugin that read a tracker would be wrong about it
    monthly.
  - **`reports/<runId>/gate.json` routes every red test to `code`, `test` or
    `environment`.** Half of that is not a guess: `failed` and `error` have
    meant "the answer was wrong" and "the question was never asked" since the
    kernel's first commit, and nothing had ever told a caller that this is the
    line between fixing the code and fixing the test. The other half is one
    heuristic, and it does not read the message — two tests that broke
    identically did not both break for their own reasons, because a cause more
    than one test shares is inside none of them. What that gets wrong is in the
    plugin's README rather than in its source.
  - **Written entirely against the published contract**, through a reporter,
    the `cli` service and `ctx.host` — no kernel change, and it found one hole
    in the contract while being written, below.
- **A test's tags reach the stream** — `tags` on `test.started` and on
  `TestOutcome`. A reporter could group by suite, by file and by `meta`, and
  not by the label the run was actually selected with, so anything reporting
  per ticket, per component or per swimlane had to re-discover the project to
  learn what it had just watched run. The set is the effective one, suites and
  cases included, exactly as `--tags` sees it.
- **A failed step says what it was doing** — `ExecContext.record(detail)`, and
  `detail` on `step.finished` and on `StepRecord`. The stream carried a status,
  a duration and a sentence, and never the exchange, so no reporter could print
  a request and a response whatever flag it was given, and the only way to see
  one was to run the test again with a proxy in front of it. A person without
  that is inconvenienced; an agent without it has nothing to write the fix
  from. `@speqkit/plugin-http` records the request beside the response,
  `speq run --json` carries it on the failure, and `speq run --verbose` prints
  it.
  - **The step decides what is worth recording; the kernel decides whether it
    is worth keeping.** The other way to close this was the whole result on
    every `step.finished`, which makes `events.jsonl` as large as every
    response body in the run, nearly all of them from steps that passed. A
    recorded value is dropped when the step passes, so a green run writes the
    log it always wrote.
  - **Recorded before the work, not after it.** A callback handed the step's
    result could not answer the case that matters most: a request that never
    comes back has no result to describe it. `plugin-http` writes the request
    down before it opens the socket, so a refused connection still says what
    was attempted.
  - **Secrets do not travel.** `authorization`, `cookie`, `x-api-key` and their
    neighbours keep their names and lose their values, because a run log is a
    CI artifact read by people who had no part in the run — and a request that
    failed for want of a token has to stay distinguishable from one that never
    carried it. A body over 8 KB is cut, with the remainder counted out loud.
- **`speq capabilities [--json]` and `host.capabilities()`** — every step type,
  assertion, value provider, reporter and loader the loaded plugins define,
  with the `InputSchema` each declared. All of it has been in the registry
  since the plugin that owns it registered, and none of it could be reached
  from outside the process — so an editor offering completion, a palette in a
  panel and a system prompt describing speq to a model each carried a copy of
  the vocabulary. That copy goes stale the moment somebody installs a plugin,
  and goes stale *silently*, because a suite written against the wrong
  vocabulary looks exactly like a suite with a typo in it. Ordered by name, so
  two runs of one project produce the same document and a diff between two of
  them means something.
  - Resources are deliberately not in it: a resource name is something a
    *plugin* asks for, never a word anybody writes in a suite, and this
    document answers "what may I write". `speq plugins` is the other half of
    the question — who is loaded, grouped by owner — and is unchanged.
- **`--json` on `run`, `validate` and `list`** — one document on stdout instead
  of prose. `validate` answers `{ checked, diagnostics }`; `list` gives the
  identities and not the steps, since the steps are in the file it names;
  `run` gives the counts and, per test, `failures` — present and empty on a
  green test, with `expected` and `actual` on what compared badly. Everything
  else stays in the report already written under the `runDir` the document
  names.
  - The document goes to stdout **even when the news is bad**, including from
    `run`, which also answers `{"status": "invalid"}` with the diagnostics and
    `{"status": "no-tests"}` rather than refusing in prose. stderr keeps what
    went wrong with the *command* — a malformed `--shard` — which is a bug in
    the caller rather than a result to read. Exit codes do not move.
  - `--json` replaces the **default** reporter, not a chosen one:
    `--json --reporter junit` still writes the XML, because a document on
    stdout and a file on disk answer different callers.
- **`code` on every `Diagnostic`** — `unknown-step-type` is now a different
  thing from `missing-field` without matching substrings of coloured stderr.
  The message is written for a person and may be reworded in any release; the
  code is written for a program and may not. The kernel's sixteen are bare
  words; anything a plugin's own `validate` found is prefixed with that
  plugin's short name — `http/unknown-topic`, or `http/invalid` when the plugin
  named none — so the two sets cannot collide, and a plugin that starts naming
  its problems next year cannot take a word the kernel wants. `ValidationProblem`
  gains an optional `code` for that, and the scaffolded plugin now writes one.
- **`speq run --shard i/n`** — n machines each taking a slice, where
  `--workers` is one machine doing more at once. They compose. Entirely in
  `plugin-cli`: it touches neither the kernel nor the contract, because
  discovery is already sorted and a shard is a slice of what it returned,
  applied after the four selection flags. `speq list --shard i/n` takes the
  flag too, since the property worth checking — n shards between them run each
  test exactly once — is checkable without running anything. `--shard 2`,
  `0/4`, `5/4` and `a/b` are refused before discovery: a machine that quietly
  ran the whole suite after being asked for a quarter is four times the work
  with nothing saying so.
  - **The slice is by test, contiguous.** By file would keep a file whole and
    leave a thousand tests in one file as one shard — and since `cases` a
    thousand tests in one file is a *single test*, so that is the case shards
    exist for and it would be the one they could not split. What it costs is a
    file on a boundary, whose `suite`-scoped resources are then set up in both
    shards. That cost is already there one level up: a shard is a separate
    process, so a directory suite's setup already runs once per shard however
    the slice is cut. One sentence covers both — a shard is an independent run,
    and every suite that has work in it opens in it. Contiguous rather than
    `i % n` because round-robin splits *every* multi-test file across every
    shard, while a contiguous cut splits at most n-1 files in the whole run.
  - `reports/<runId>/` is per run and never collides, but `junit.xml` is a
    stable path on purpose, so shards sharing one working directory overwrite
    one file. The flag is for n machines; on one, give each a different
    `junit.output`.

### Published with this release

| Package | Version |
| --- | --- |
| `speqkit` | 0.4.0 |
| `@speqkit/plugin-api` | 0.11.0 |
| `@speqkit/plugin-cli` | 0.5.0 |
| `@speqkit/plugin-yaml` | 0.4.0 |
| `@speqkit/plugin-http` | 0.4.0 |
| `@speqkit/plugin-loop` | 0.4.0 |
| `@speqkit/plugin-junit` | 0.4.0 |
| `@speqkit/plugin-playwright` | 0.4.0 |
| `@speqkit/plugin-use` | 0.3.0 |
| `@speqkit/plugin-data` | 0.3.0 |
| `@speqkit/plugin-assert` | 0.3.0 |
| `@speqkit/plugin-json` | 0.3.0 |
| `@speqkit/plugin-gate` | 0.1.0 |
| `@speqkit/test-kit` | 0.3.0 |
| `create-speqkit-plugin` | 0.3.0 |

Every plugin moves, including the four whose own behaviour did not change. A
caret range on `0.x` pins the minor, so a plugin that stayed behind would keep
asking npm for `^0.10.0` and a fresh `speq install` would fetch a second copy
of the contract to satisfy it — correct, loadable, and pointless on disk.
`scripts/release-plan.mjs` reports that state rather than trusting anyone to
remember it.

`@speqkit/installer` stays at 0.2.0: nothing in it changed, and it is the one
package here with no peer range on the contract to keep current.

## [0.3.0] — 2026-09-02

The release where a run stops doing one thing at a time, and a suite stops being
a file path. Both move `RunEvent`, so they went out together: a reporter written
against 0.2.0 breaks once here rather than twice.

### Added

- **Suites run at once — `speq run --workers N`.** Concurrency is between suites
  and nowhere else: a test is atomic, a suite's tests stay sequential, and the
  suites are pulled from a shared cursor rather than a partition, so a suite that
  fails frees its slot immediately and nothing waits for the slowest slice. The
  default is **one**, and it is not a placeholder for a better default arriving
  later — every runner surveyed defaults to the CPU count because its bottleneck
  is the local processor, and speq's is somebody else's service. `--workers 8` is
  eight times the load on the system under test and can change a verdict. There
  is no `auto`, and `--workers 0`, `auto` and `2.5` are refused before discovery
  rather than quietly falling back to one.
- **Six ordering guarantees, G1–G6**, written beside the `RunEvent` union,
  because that is where a reporter author looks. G4 is the one that costs
  something and is deliberately weak: events of different suites interleave;
  events of one suite never do.
- **A suite is a thing.** A directory holding a `suite.yaml` is a suite. It has a
  title, a parent, tags and annotations inherited outside-in with the nearest
  declaration winning, a `pending` that parks everything below it with one
  reason, and a `setup` and `cleanup` that run **once** — before the first test
  anywhere beneath it and after the last, whatever happened to them. Suites nest.
  What a suite's setup binds stays in the suite: a test that could read
  `${tenant.id}` from the directory above it would be a different test when run
  alone, and running one test alone is how every failure gets looked at. What
  crosses that line is a `suite`-scoped resource, which is declared and named.
- **`cases` — one test, many inputs.** A table of inputs expands during
  discovery, before validation and before anything counts tests, so a case is an
  ordinary test everywhere it matters: five names `speq validate` checks, five
  rows in the report, and one of them re-runnable. The id is written, never
  counted — an index moves the day somebody inserts a row above it. A malformed
  table is left unexpanded and reported by `validate`, so there is something to
  point at.
- **`speq run --name a,b`** — the fourth selection flag. The other three say
  where to look or what to look for; after reading a report, what anybody wants
  is that row.
- **`expected` and `actual` on `assertion.evaluated`.** `AssertOutcome` has
  carried both since the first commit and the event dropped them, so every
  surface downstream had a sentence and no values. The console now renders two
  scalars as a comparison and two shapes as a unified diff. They ride on failure
  only: a response body per passing assertion buys nothing.
- **Contract 0.9.0 → 0.10.0**: `SuiteDef` and `CaseDef`; `LoaderDef.suiteFiles`
  and `LoaderDef.loadSuite`, so a loader can declare suites without
  reimplementing the tree, the identity or the inheritance; `TestDef.cases`,
  `TestDef.group` and `TestDef.suites`; `RunRequest.concurrency`;
  `DiscoverQuery.names`; `TestOutcome.group`; `ValidateContext.suite`.
  `suite.started` gained `parent`, `title` and `pending`, and `test.started`
  gained `group`. `PLUGIN_API_VERSION` stays `1` and no ninth contribution point
  was opened — a suite was tried as a plugin first, and the experiment came back
  no: grouping, identity and inheritance are all settled before any hook fires.
- **`@speqkit/test-kit`, `@speqkit/plugin-cli`, `@speqkit/plugin-junit` and
  `@speqkit/plugin-playwright` have tests of their own.** The CLI is the plugin
  every author copies and playwright is half the architecture gate; both were
  claims rather than properties. One CI job installs chromium and sets
  `SPEQ_REQUIRE_BROWSER=1`, because otherwise "green" and "did not run" look the
  same from outside.

### Changed

- **Both reporters read identity instead of adjacency**, which they were wrong
  about before this release for reasons that have nothing to do with
  concurrency. JUnit keyed nothing and held one open case, so a second
  `test.started` overwrote the first and the file came out with one of two tests
  in it — while the run still exited non-zero, so nobody opened the report to
  notice. It now keys open cases by test name and takes the suite from the event.
  The console printed each event as it arrived, which reads perfectly while one
  test runs and turns to noise the moment two do; it now holds a test's lines and
  prints the block whole. Held per **test**, not per suite: a suite at eight
  workers is minutes of silence, and a suite's tests are no longer contiguous.
- **`init.yaml` is now `suite.yaml`.** The old name is still read, because a
  project written against it would otherwise start running its manifest as an
  empty test, and `speq migrate` writes the new one.
- **`step.started`, `step.finished`, `assertion.evaluated` and
  `artifact.attached` made `test` optional, beside a new `suite`**, because a
  suite's own setup and cleanup belong to no test. Exactly one of the two is
  set. G3 and G6 were amended next to the union. JUnit writes no element for the
  suites in the middle that hold no cases; the console prints a suite's own steps
  with the suite beside them, since there is no test header above them.
- **`parallel` is not a step type anybody can write, and the promise is
  withdrawn where it was made** — six documents, one of them a decision table
  marked decided. A `parallel` plugin would have to run two `runSteps` calls at
  once, and that is now refused. What is refused is concurrent `runSteps`, not
  concurrent I/O: a step type may fan out fifty requests inside one `execute`,
  and `http.batch` stays writable. That is where nearly all the real demand was
  going.
- **A concurrent `runSteps` is refused where the mistake is.** Both calls used to
  share one frame stack, so the second branch's bindings landed in the first
  branch's frame and a throwaway `parallel` plugin got the same branch twice —
  passing. The wrong answer surfaced in an assertion three steps later with
  nothing pointing back. Nesting is untouched: `loop` and `retry` call `runSteps`
  from inside a running one and always will. What is refused is siblings.
- **Every in-box plugin's minor moved with the contract's.** A caret on `0.x`
  pins the minor, so a plugin left at its old version would make an install fetch
  a second, older copy of `@speqkit/plugin-api`. Nothing about the four plugins
  with no other change changed except the range they ask for.

### Fixed

- **Resource frames were one stack for the whole kernel, and the cache held the
  resolved value.** Both are fine for a sequential run and neither survives two
  suites at a time: `close` popped whatever was innermost, which could be another
  suite's frame, and two callers arriving inside a setup's window both set the
  resource up. Measured on a 20ms setup acquired twice: two setups, one resource
  never released and the other released twice. Frames are now a tree, each handed
  to whoever runs inside it, and the cache holds the **promise**, written before
  anything is awaited — so the window is not narrower, it is gone.
- **`HookPayload.suite` was declared since the first commit and populated for
  `suite:before` and `suite:after` only** — not for the four hooks a plugin
  holding per-suite state actually fires on. A hook is registered once for the
  whole run, so under `--workers` the same function is called by two suites at
  once and had no way to keep them apart.
- **Two tests could share a name.** Every event a run emits is keyed by the
  test's name and nothing checked it was unique, so the second test overwrote the
  first: one line where there should have been two, with no sign anything was
  lost.
- **A fresh clone had no `speq` to run.** `bin` named `./dist/bin.js`, and a
  package manager links nothing when that file is not there yet — so the first
  install printed twenty "Failed to create bin" warnings and left nothing on the
  path, and the second install, the one after a build, silently fixed it. The
  manifest now names a committed file that imports the built entry.
- **`speq validate` and `speq list` ignored `--test`, `--suite` and `--tags` in
  silence**, and checked the whole project instead. A checking command that
  answers a different question than the one it was asked is worse than one that
  refuses, because the answer looks right.
- **`plugin-http` rethrew `TypeError: fetch failed` unchanged**, which is what
  undici says for a refused connection, an unresolvable host, a bad certificate
  and a closed socket alike — so a suite pointed at the wrong port reported four
  words and no port. The sentence and the errno were on `err.cause` the whole
  time; they are now in the message, with the original kept as its cause.
- **`examples/basic` had been red**, and nothing in CI executed it: `jsonpath`
  moved into `plugin-assert` and the example's plugin list never followed. The
  deliberately broken file moved out of `suites/` so the default check is green
  and the typo is still shown being caught. The run goes against a stub on
  localhost, because a gate that crosses the public internet reports somebody
  else's outage as our broken example.

### Published with this release

| Package | Version |
| --- | --- |
| `speqkit` | 0.3.0 |
| `@speqkit/plugin-api` | 0.10.0 |
| `@speqkit/plugin-yaml` | 0.3.0 |
| `@speqkit/plugin-http` | 0.3.0 |
| `@speqkit/plugin-cli` | 0.3.0 |
| `@speqkit/plugin-loop` | 0.3.0 |
| `@speqkit/plugin-junit` | 0.3.0 |
| `@speqkit/plugin-playwright` | 0.3.0 |
| `@speqkit/plugin-use` | 0.2.0 |
| `@speqkit/plugin-data` | 0.2.0 |
| `@speqkit/plugin-assert` | 0.2.0 |
| `@speqkit/plugin-json` | 0.2.0 |
| `@speqkit/test-kit` | 0.2.0 |
| `create-speqkit-plugin` | 0.2.0 |

`@speqkit/installer` stays at 0.2.0: nothing in it changed, and it is the one
package here with no peer range on the contract to keep current.

## [0.2.0] — 2026-08-31

The release that made releasing not a thing anyone does. Also the first one you
can install without a JavaScript toolchain on the machine at all.

### Added

- **Standalone executables**, one per platform, each with a pinned Node runtime
  inside it — `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. A Go or
  Python repository can install a test runner without installing a JavaScript
  toolchain first.
- **`brew install speqkit/tap/speqkit`**, and
  `curl -fsSL https://speqkit.github.io/speqkit/install.sh | sh` for machines
  without Homebrew. The script verifies the archive against a published sha256
  and refuses to install one it cannot check.
- **`@speqkit/plugin-use`** — composition: shared blocks, module actions and
  fixtures, all through one `use` step.
- **`@speqkit/plugin-data`** — `${gen:…}` for data a test makes up, `${env:…}`
  moved out of `plugin-http` where it never belonged, and `${vars:…}` for the
  values an environment file sets. Generated values are derived from the run id
  rather than the system random source, so replaying a run's data means copying
  the string that already names its report directory.
- **`@speqkit/plugin-assert`** — twenty-one words for equality, order,
  membership, text, presence, size and shape, over one selector shared by all of
  them. `schema` validates through ajv rather than a subset of our own.
- **`@speqkit/plugin-json`** — `reports/results/summary.json`, folded out of the
  event stream, in the shape a workflow already reads with `jq`.
- **`@speqkit/test-kit`** — runs a plugin inside the real kernel, so an author
  can test one without a project. Not a plugin: it boots one.
- **`create-speqkit-plugin`** — `npm create speqkit-plugin <name>` scaffolds a
  plugin with its tests, its schemas and its release workflow already written.
- **Plugins from a repository**, not only a registry: `github:acme/plugin#v2`,
  `git+ssh://…#main`, or a tarball URL. A ref resolves to a commit at install
  time and only the commit is locked, so `--frozen` in CI installs what was
  reviewed rather than wherever a tag has moved since.
- **Multipart requests and retrying** in `plugin-http`. Retrying is off by
  default, and when on it leaves 429 alone and repeats only idempotent methods.
- **Contract 0.5.0 → 0.9.0**: `StepTypeDef.validate` and
  `AssertionTypeDef.validate` (a plugin checks its own inputs before the run,
  not during it); `StepDef.assert`, `TestDef.setup`, `TestDef.cleanup`;
  `TestDef.variables`, resolved one at a time in declaration order; `meta`, which
  the kernel carries and never reads; and `pending`, which takes a reason rather
  than a flag. `PLUGIN_API_VERSION` stays `1` and no ninth contribution point
  was opened.
- **A value provider may answer asynchronously** — a secret from a vault, a row
  from a database — without making resolution async for anything else.
- **The documentation site** at <https://speqkit.github.io/speqkit/>, with a
  build that fails when an internal link points at nothing.
- **Delivery, end to end.** Bump a version in a `package.json`, merge to main,
  and if the gate is green that version is on npm — with provenance — and a
  kernel bump takes the binaries, the release and the tap with it. Plugin
  authors get the same machinery as a reusable workflow they can call from their
  own repository.

### Changed

- `jsonpath` and `body_contains` moved from `plugin-http` to `plugin-assert`,
  and `env` moved to `plugin-data`. What is left in the HTTP plugin is the two
  checks that are actually about HTTP. **The old names still work** and say what
  to write instead.
- `speq migrate` and the YAML loader now carry the decided test form — `id`,
  `title`, `tags`, `variables`, `setup`, `steps`, `assert`, `cleanup` — and the
  60-test suite this framework was designed against migrates and validates
  clean. What has no successor is named by file with what to do instead, never
  silently dropped.

### Fixed

- `attach` took bytes and dropped them. The plugin-facing call is unchanged; the
  kernel now writes the file and the event carries a `path`.
- `AssertContext.results` was documented as every step result so far and was
  always empty, so `${a.value}` in an `assert:` block reported that `a` was not
  defined. The executor was discarding the test's own bindings the moment its
  last step finished — before assertions run.
- `tsconfig.json`'s `paths` map had lost three packages, which made
  `pnpm typecheck` pass for anyone who had run `pnpm build` once and fail on
  every clean clone. A test now fails when a fourth goes missing.

### Published with this release

| Package | Version |
| --- | --- |
| `speqkit` | 0.2.0 |
| `@speqkit/plugin-api` | 0.9.0 |
| `@speqkit/installer` | 0.2.0 |
| `@speqkit/plugin-yaml` | 0.2.0 |
| `@speqkit/plugin-http` | 0.2.0 |
| `@speqkit/plugin-cli` | 0.2.0 |
| `@speqkit/plugin-loop` | 0.2.0 |
| `@speqkit/plugin-junit` | 0.2.0 |
| `@speqkit/plugin-playwright` | 0.2.0 |
| `@speqkit/plugin-use` | 0.1.0 |
| `@speqkit/plugin-data` | 0.1.0 |
| `@speqkit/plugin-assert` | 0.1.0 |
| `@speqkit/plugin-json` | 0.1.0 |
| `@speqkit/test-kit` | 0.1.0 |
| `create-speqkit-plugin` | 0.1.0 |

## [0.1.0] — 2026-08-28

The first packages on npm: the kernel, the contract at 0.4.0, the installer and
six plugins — `yaml`, `http`, `cli`, `loop`, `junit`, `playwright`. Published by
hand, before the pipeline existed, which is why there is no `v0.1.0` tag and no
GitHub release to go with it. There were no executables yet: installing speq
meant having Node.

[Unreleased]: https://github.com/speqkit/speqkit/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/speqkit/speqkit/releases/tag/v0.5.0
[0.4.0]: https://github.com/speqkit/speqkit/releases/tag/v0.4.0
[0.3.0]: https://github.com/speqkit/speqkit/releases/tag/v0.3.0
[0.2.0]: https://github.com/speqkit/speqkit/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/speqkit/v/0.1.0
