# Roadmap

What is on the table, in the order the work has to happen, with the sentence
that decides when each item is finished.

It exists because of one distinction that is easy to lose: **some of this work
is cheap now and expensive after 1.0, and some of it costs the same forever.**
Anything that moves `@speqkit/plugin-api` — the test model, `ExecContext`, or
the `RunEvent` union — is in the first group, because the event stream is
declared sufficient to rebuild a report, so changing it breaks every reporter
at once. That is a minor now and a major later.

## How to read this

Every item carries a **Done when** line written the way a commit subject is
written here: a sentence that says what is true after the change. That sentence
is the acceptance criterion. An item whose sentence cannot be written is not
ready to be taken.

| Marker | Meaning |
| --- | --- |
| **blocks 1.0** | Moves the contract or the event stream. Landing it after 1.0 costs a major. |
| **any time** | Cheap now, cheap later. Ordered by what a stranger hits first, not by size. |

The dependency in one sentence: **M5 unblocked M6, and both unblock most of
M4** — nested suites, parametrization and a device farm were all the same
missing thing, which is scopes that survive being entered twice at once. The
first two have landed; what is left in M4 is the ecosystem itself.

---

## M5 — Suites at once — blocks 1.0 — **done**

**The shape is decided.** Concurrency exists between suites and nowhere else.
The seven sentences below are the decision; the items after them are what the
decision costs.

1. **Inside a test there is no concurrency, and there cannot be.** No step type
   may run two `ctx.runSteps` calls at the same time.
2. **A test is the atomic unit.** It runs whole, interleaved with nothing.
3. **Suites run in parallel** — and once suites nest, the leaves of the tree do.
4. **A suite's `before`/`each`/`after` cannot collide between its own tests**,
   because the tests inside one suite are sequential.
5. **A thousand tests in one suite is a bottleneck**, and the answer to it is
   shards, not a second kind of concurrency.
6. **A live reporter buffers** until what it is holding has a final status, and
   prints it then. A reporter that renders a finished run needs no live output
   at all.
7. **A failed test does not stop the run.** It frees a slot in the pool.

What that buys: the executor is per test, so with (1) and (2) its frames,
`#depth`, `#parentId` and `#phase` are correct as they stand. The variable-scope
item that opened this milestone is gone. What remains is the resource manager,
one refusal, and the sentence that has to be written down.

### The guarantees, to live beside the `RunEvent` union

The decision above is only real once a reporter author can read it. G4 is the
one that costs something, and it is weaker here than it would be under
test-level concurrency — which is the point of deciding it this way.

- **G1** — `run.started` is the first event, `run.finished` the last.
- **G2** — For any test, `test.started` precedes every event naming it and
  `test.finished` follows all of them.
- **G3** — For any suite, `suite.started` precedes the `test.started` of every
  test whose `source` is that suite, and `suite.finished` follows every
  `test.finished` of those tests.
- **G4** — Events of *different suites* may interleave in any order. Within one
  suite the stream is totally ordered, and a reporter may rely on that.
- **G5** — Within a test, step events are ordered. Nesting is expressed by
  `parentId` and `depth`, never by adjacency.
- **G6** — Every event belonging to a test names it; every test names its suite
  once, on `test.started`; a name identifies a test for the whole run.

### The items

- [x] **A resource acquired twice at once is one resource**
  - *Done when:* two suites acquiring the same resource concurrently get one
    value, and every resource that was set up is torn down exactly once.
  - *Where:* `packages/core/src/resources.ts`. Two faults, both load-bearing
    under (3): `#frames` is one stack for the whole kernel, so `close('test')`
    in suite A pops the frame suite B just opened; and `acquire` caches the
    resolved value rather than the promise, so two callers both find the cache
    empty and both call `setup`.
  - *Evidence:* a `test`-scoped resource whose setup takes 20 ms, acquired
    twice at once, reported `SETUPS 2` and `TORN DOWN [2, 2]`. Not one leak:
    resource 1 was never released and resource 2 was released twice.
  - *Done:* frames are a tree, `close` is a method on the frame rather than a
    scope name the manager has to guess, and the cache holds the promise. The
    file's doc comment claimed since the first commit that data isolation under
    parallel execution falls out of this model. It does now.

- [x] **A concurrent `runSteps` is refused, loudly**
  - *Done when:* a step type that starts a second `ctx.runSteps` before its
    first has returned gets an error naming the rule, instead of an answer.
  - *Why this and not documentation:* the contract cannot stop a plugin author
    from writing `Promise.all(ctx.runSteps(a), ctx.runSteps(b))`, and today that
    does not fail — a throwaway `parallel` plugin returned
    `[["branch-1"],["branch-1"]]` where `[["branch-0"],["branch-1"]]` was
    expected, and the step passed. A rule nobody can violate by accident is a
    rule; a rule that returns another branch's data is a trap.
  - *Where:* `packages/core/src/executor.ts`. Nesting stays legal — `loop` and
    `retry` call `runSteps` from inside a running one. What is refused is
    siblings: a call that returns to a different depth than it left from.

- [x] **The promise about `parallel` is withdrawn where it was made**
  - *Done when:* no document or comment tells a plugin author that `parallel` is
    an ordinary step type they may write.
  - *Where:* `packages/core/src/executor.ts` (the `runSteps` doc comment),
    `packages/plugin-api/src/index.ts` (twice — `StepDef.steps` and
    `ExecContext.runSteps`), `packages/plugin-loop/src/index.ts`, and the
    decision table in `docs/architecture/plugin-framework.html`, where
    "Loop, condition, retry, parallel — all plugins" is marked **decided**.
  - *And what replaces it:* the refusal is on concurrent `runSteps`, not on
    concurrent I/O. A step type may fan out fifty requests inside one `execute`
    — it touches no frame doing so. `http.batch` stays writable, and that is
    where nearly all of the real demand for `parallel` was going.

- [x] **A suite hook knows which suite it is in**
  - *Done when:* `test:before`, `test:after`, `step:before` and `step:after`
    carry the suite, so a hook holding per-suite state can key on it.
  - *Where:* `packages/core/src/runner.ts` and `executor.ts` — four call sites.
    `HookPayload.suite` is already declared and is never populated for these
    four, so this costs nothing on the contract. It is the second dead field
    found here, after `RunStepsOptions.label`.
  - *Why it belongs to M5:* a hook is registered once for the whole run, so two
    concurrent suites call the same function. Thesis (4) holds inside a suite
    and says nothing across suites; a hook that cannot name its suite has no
    way to keep the two apart.

- [x] **Concurrency can be asked for**
  - *Done when:* `RunRequest.concurrency` exists and `speq run --workers N`
    reaches it, with 1 the default.
  - *Why 1 forever:* every framework surveyed defaults to the CPU count, because
    their bottleneck is the local processor. Ours is somebody else's service.
    Eight workers is eight times the load on the system under test, and step
    timeouts start firing where they did not fire in sequence — concurrency
    would change verdicts. There is no `auto`.

- [x] **The reporters key on identity**
  - *Done when:* an interleaved stream renders the same report as a sequential
    one.
  - *Where:* `packages/plugin-junit/src/build.ts` holds `#case` and `#suite`,
    one slot each. Fed the stream two concurrent suites produce, it emitted one
    of two tests and dropped the other — and the run still exits non-zero, so
    nobody opens the report to notice. It needs a map keyed by name, and
    `event.source` rather than the last `suite.started`.
  - *And the console:* buffers per **test** and flushes on `test.finished`.
    No suite header, which is where this deviated from the plan: a suite's
    tests are not contiguous in the output any more, so a header printed once
    would head one block and be missing from the next. Adjacency is what this
    milestone takes away, and a reporter must not put it back. Each test's own
    header already carries its source.
  - *Note:* both are wrong today for a reason that has nothing to do with
    concurrency, which is why neither needs a contract change to fix.

- [x] **The report does not depend on who finished first**
  - *Done when:* two runs of the same suites at `--workers 4` produce the same
    report.
  - *Where:* `packages/core/src/runner.ts` — `outcomes.push(await …)` becomes a
    write at the test's own index. The event log stays chronological; the report
    is not the event log.

- [x] **The gate: a plugin from outside proves it**
  - *Done when:* a plugin published from outside this repository, defining a
    `suite`-scoped resource and a suite hook, runs correctly under
    `--workers 4` with no kernel changes — one resource per suite, torn down
    once, and the hook's state never crossing between suites.
  - *Why a gate at all:* the old one was `parallel` itself, and thesis (1)
    forbids it. The claim that this milestone is done cannot be checked from
    inside the repository that makes it. It was believed for months last time
    because nobody had written the plugin.
  - *Done:* `packages/core/test/parallel-gate.test.ts` writes a plain `.mjs`
    plugin — no build, no bundler, no kernel import — into a project under
    `examples/basic`, and drives the real binary at `--workers 4`. Its own
    ledger is the evidence: four tenants for four suites, each torn down once,
    no tenant crossing a suite, each hook counting its own two tests, and every
    suite set up before any was torn down. The JUnit file is read off disk.

- [x] **Shards**
  - *Done when:* `speq run --shard 2/4` runs a quarter of the tests, and four
    shards between them run each test exactly once.
  - *Done:* `--shard i/n` on `run` and on `list`, entirely in `plugin-cli` —
    it touched neither the kernel nor the contract, which is what the item
    claimed and is now true rather than expected. Discovery is already sorted,
    so a shard is a slice of what discovery returned, applied after the four
    selection flags: sharding a selection is a sensible thing to want,
    selecting out of a shard is not. `--shard 2`, `0/4`, `5/4` and `a/b` are
    refused before discovery, on the `--workers` precedent — a machine that
    quietly ran everything after being asked for a quarter is four times the
    work with nothing saying so.
  - *The fork, taken by test:* slicing by file keeps a file whole and leaves a
    thousand tests in one file as one shard — and since M6 a thousand tests in
    one file is a single test with a `cases` table, so that is the case shards
    exist for and it would be the one case they could not split. Slicing by
    test splits a file on a boundary, and its `suite`-scoped resources are then
    set up in both shards.
  - *What made the fork narrower than it looked when it was written:* a
    `suite`-scoped resource binds at the **file**, not at the directory —
    `resources.ts` walks up to the nearest frame of the matching scope, and the
    leaf node opens one. A shard is a separate process, so every *directory*
    suite's setup already runs once per shard whatever the slice is cut by.
    Slicing by file would have bought a rule with two halves; slicing by test
    makes it one sentence — a shard is an independent run, and every suite that
    has work in it opens in it. The pytest surprise is real and is in the
    flag's own documentation.
  - *Contiguous rather than `i % n`*, which is the cheap half of the cost:
    round-robin splits every file with more than one test in it across every
    shard, a contiguous cut splits at most n-1 files in the whole run. Both
    balance by count; the remainder goes to the low shards one test each.
  - *Note:* `reports/<runId>/` is per run and never collides, but `junit.xml`
    is a stable path on purpose — four shards in one working directory
    overwrite one file. Documented rather than worked around: the flag is for
    n machines, and CI is where it is used.

### Not in M5, and deliberately

- **Fail-fast.** Thesis (7) settles it: nothing stops the run. A half-cancelled
  run leaves resources behind, which is the failure mode this milestone exists
  to remove. Out of 1.0, and said out loud rather than left open.
- **Worker processes.** In-process async covers L1–L3 because the work is I/O
  against somebody else's service. Processes buy crash containment, which
  shards already give, and CPU parallelism, which this workload does not use.

## M6 — The spine closes — blocks 1.0 — **done**

Four items, all of which move `RunEvent`. **Land them in one release** so that
reporters break once rather than four times. Each is a field on the spine, in
the same tradition as the four holes already found and closed that way — none
of them opens a ninth contribution point.

*Landed in one release, as written.* The stream moved in four places at once:
`suite.started` gained `parent`, `title` and `pending`; `test.started` gained
`group`; and `step.started`, `step.finished`, `assertion.evaluated` and
`artifact.attached` made `test` optional beside a new `suite`, because a
suite's own setup is work that belongs to no test. G3 and G6 were amended
next to the union rather than left to be discovered.

- [x] **A failed assertion says what it expected and what it got**
  - *Done when:* a reporter can render a diff without re-running the test.
  - *Landed early*, out of order with the rest of M6, because M7's console diff
    could not be written without it and is otherwise pure terminal work. It is
    additive — a reporter that ignores the two keys behaves exactly as before —
    so it does not spend the "reporters break once" budget the other three
    items share. They ride on failure only: a response body per passing
    assertion in `events.jsonl` buys nothing.
  - *Why it matters twice:* a human without a diff is inconvenienced; an agent
    without a diff has nothing to fix.

- [x] **Two tests cannot share a name**
  - *Done when:* `speq validate` reports duplicate test names the way it
    reports duplicate step ids.
  - *Landed early*, with the item above: it moves no event and no type, so it
    spends none of the "reporters break once" budget. The diagnostic names the
    file the first one is in, because that is the only useful thing to say.

- [x] **A suite is a thing, not a file path**
  - *Done when:* a directory can declare its own `setup`, `cleanup`, `meta`,
    `tags` and `pending` once, nested suites inherit them outside-in, and a
    report can show which suite a test belongs to.
  - *Where it stands today:* `groupIntoSuites` derives the suite from
    `test.source`, so a suite is a file. `suite:before` / `suite:after` hooks
    exist but `HookPayload` has no `runSteps`, so a hook can run JavaScript and
    cannot run a declared step. The lifetime already exists —
    `ResourceScope` includes `'suite'` — only the declarative way to use it is
    missing.
  - *Contract:* `SuiteDef` on the spine; `LoaderDef.loadSuite` so the manifest
    is not YAML-only; identity and parent on `suite.started`; and a step event
    that can carry no test at all, since a suite's setup step has none.
  - *Do this first:* give `HookPayload` an executing context and try to write
    it as `@speqkit/plugin-suite`, outside the kernel. If it works, it is the
    strongest demonstration of the whole architecture. If it does not, the exact
    place where the contract gets in the way is the issue CONTRIBUTING asks for.
  - *What that experiment found — it cannot be a plugin, and the reason is
    worth keeping.* An executing context on `HookPayload` would have let a
    plugin run a directory's declared steps, and that was the smaller half.
    The larger half is that a suite is **grouping, identity and inheritance**,
    and all three are decided before any hook fires. `groupIntoSuites` derives
    the group from `test.source` and no contribution point can change it, so a
    `suite:before` hook fires once per *file* and can never fire once per
    directory. Inheritance is worse: a suite's `pending` parks the tests below
    it, and a test's `pending` is settled at discovery — there is no point at
    which a plugin may alter a `TestDef`, and adding one would be a ninth
    contribution point for rewriting the spine, which is the thing this design
    exists to refuse. What stays a plugin is the part that always was: the
    *format*. `LoaderDef.loadSuite` reads the fields out of YAML and stops
    there, so a TypeScript loader declares suites without reimplementing any of
    what they mean.
  - *Done:* a directory holding `suite.yaml` is a suite. Suites nest and are
    opened outside-in and closed inside-out, once each however many of their
    files run at the same time — the node counts the files left below it and
    whoever brings that count to zero closes it, because with `--workers` above
    one the last file to finish is not knowable in advance. `setup` and
    `cleanup` run in the suite's own scope, which the tests below cannot read:
    a test that could see `${tenant.id}` from the directory above it would be a
    different test when run alone. A failed suite setup blocks every test below
    it, reported per test as `error`, with the cleanup still running.
  - *File name:* `suite.yaml`, not `init.yaml` — `speq init` already exists and
    means something else. `init.yaml` is still read, because a project written
    against it would otherwise start running its manifest as an empty test, and
    `speq migrate` now writes the new name.

- [x] **One test, many inputs**
  - *Done when:* a test declares its cases, each case runs as its own test with
    its own status, setup, cleanup and `pending`, and a report can group them
    back together.
  - *What does not need the kernel:* the expansion. `LoaderDef.load` already
    returns `TestDef[]`, so a loader can turn one document into forty tests —
    which is how pytest does it, at collection time.
  - *What does need the kernel:* the declaration (a field on the spine, because
    the kernel never branches on `meta` and this is behaviour), the identity
    scheme, a group field on `test.started`, and a way to address one case —
    `DiscoverQuery` is `{ test?, suite?, tags? }` where `test` is a *file*, so
    re-running a single failing case is impossible even today.
  - *Identity:* `name[case-id]`, from a declared id and never from a position.
    An index shifts the day somebody inserts a case in the middle, and a report
    read next quarter is comparing against a name.
  - *Not `foreach`:* see [Not doing](#not-doing).
  - *Done:* `cases` is a field on the spine and the kernel expands it during
    discovery — before validation and before anything counts tests — so a case
    is an ordinary test in every place that matters. `group` on `test.started`
    and on `TestOutcome` puts the rows back together. Addressing arrived as
    `DiscoverQuery.names` and `--name`, which takes the test's own name rather
    than a file: `speq run --name 'menu.create[jpy]'`.
  - *A malformed table is left unexpanded* and reported by `speq validate`
    instead — a missing id, a duplicate id, an empty table. Expanding first and
    checking afterwards would leave nothing to point at, and two rows called
    `eur` would be two tests with one name.

## M7 — The first five minutes — any time, do first — **done**

Nothing here changes the contract. All of it changes whether a stranger gets
past their first run.

- [x] **The example in the README runs**
  - *Done when:* `examples/basic` validates and runs green, and CI runs it.
  - *Done:* the plugin list gained `assert` and the assertions moved to the
    current vocabulary; the deliberately broken file moved out of `suites/`
    into `broken/`, so the default check is green and the typo is still shown
    being caught with `validate --suite broken`. CI runs `plugins`, `validate`,
    the broken file, and both HTTP suites against a stub on localhost — a gate
    that crosses the public internet reports somebody else's outage as our
    broken example.
  - *Found by running it:* the job went red on a machine that had never built,
    and it was right to. `bin` named `dist/bin.js`, which does not exist when
    install runs, so a fresh clone got twenty "Failed to create bin" warnings
    and no `speq` on its path — invisible to anyone whose second install came
    after a build. The manifest now names a committed launcher.
- [x] **A failed request says which URL failed and why**
  - *Done when:* a connection error names the URL and the underlying cause
    instead of two words.
- [x] **`validate` and `list` honour the flags they are given**
  - *Done when:* `speq validate --test x.yaml` validates that file.
- [ ] **A run can be debugged without a proxy** — *half done*
  - [x] A failed assertion shows a diff in the console: two scalars as a
    comparison, two shapes as a unified diff over their JSON.
  - [ ] `--verbose` shows the exchange. **This one is misfiled here.** A step's
    result never enters the event stream — `step.finished` carries a status, a
    duration and a message and nothing else — so no reporter can print a
    request and a response, whatever flag it is given. It needs the stream to
    carry what a step produced, which is a `RunEvent` change and therefore
    **blocks 1.0**. Two shapes to choose between when M6 is taken: the result
    on `step.finished`, which makes `events.jsonl` as large as every response
    body in the run; or an opt-in, where the step decides what is worth
    recording. The second is almost certainly right, and it is the same
    mechanism a UI panel needs to show an exchange.
- [x] **The untested plugins have tests**
  - *Done when:* `plugin-cli`, `plugin-junit` and `plugin-playwright` are
    covered. The CLI is the reference every plugin author copies.
  - *Note:* the browser tests skip when no browser is installed, since
    `playwright` is an optional peer. One CI job installs chromium and sets
    `SPEQ_REQUIRE_BROWSER=1`, which turns that skip into a failure — otherwise
    "green" and "did not run" look the same from outside.
- [x] **The roadmap ledger matches the code**
  - *Done when:* `docs/architecture/plugins.html` no longer says the contract is
    at 0.5.0 (it is 0.9.0) or that five of nine plugins are written.
  - *Done:* the versions came out of the chips rather than being corrected — a
    version written into HTML by hand rots on the next release — and
    `workspace.test.ts` now checks the part that stays: a package this
    repository publishes has a row, and a row marked written has a package.

## M8 — A surface a machine can read — any time

The bet that a declarative suite is the right artefact in an AI-assisted
workflow rests on one property: a generated test can be checked *before it
runs*. That property is real and currently unreachable from outside the process.

- [ ] **`host.capabilities()`**
  - *Done when:* a caller can enumerate the loaded step types, assertions and
    value providers with their `InputSchema`.
  - *Why:* the schemas exist in the registry and never leave it, so an editor,
    a UI palette and a generated system prompt all have to hardcode a grammar
    that goes stale the moment a plugin is installed. One additive method
    serves all three.
- [ ] **`--json` on `validate`, `list` and `run`, and a `code` on `Diagnostic`**
  - *Done when:* a repair loop can tell "unknown step type" from "broken
    template" without matching substrings in coloured stderr.

## M4 — The ecosystem — continues

- [ ] **`speq import` from Postman and OpenAPI**
  - *Done when:* a collection becomes a suite of YAML files in one command.
  - *Why a command and not a loader:* a collection converted once is your
    suite; a collection converted on every run is a permanent dependency on
    somebody else's format. The loader point makes either possible — this is a
    choice, not a limitation.
- [ ] **One plugin written by somebody else**
  - *Done when:* a plugin this repository did not write and cannot break is
    published and linked. Until then, "the kernel is a loader" is a claim
    rather than a property. Commissioning one is worth more than writing three.
- [ ] **A UI plugin**
  - *Done when:* a panel shows the suite tree, diagnostics as you type, a run
    in progress and past runs — as a plugin, the way `plugin-cli` is one.
  - *Buildable today:* everything above, through `ctx.host` and a reporter, plus
    `events.jsonl` for an out-of-process panel.
  - *Blocked on:* `host.capabilities()` for completion and a step palette, a
    cancellation signal in `RunRequest` for a stop button, and a writing side to
    `LoaderDef` for editing that preserves comments.
- [ ] **Mobile, through Appium**
  - *Done when:* a device driver and a session are resources, and taps and
    assertions are step types — the shape `plugin-playwright` already proved
    with a browser and a page.
  - *Unblocked:* M5 gave it parallel suites and M6 gave it the device matrix —
    a `cases` table is a device per row, and a `suite.yaml` holds the driver
    the rows share. Two smaller facts to
    know first: `acquire` caches one value per name, so a plugin that wants a
    pool of devices builds it itself; and `ArtifactStore.put` writes the whole
    buffer at once, which is fine for a screenshot and not for a video.
- [ ] **Decide the escape hatch into code**
  - *Done when:* either `plugin-ts` exists as a loader, or the README says
    plainly that there are no expressions and the answer is to write a step.
  - *Why it is a decision and not a task:* "stability without a codebase" holds
    exactly as long as the hatch stays shut. Silence reads as an unfinished
    feature either way.

## Not doing

- **A ninth contribution point.** Every gap found so far was closed by a field
  on the spine. Nothing on this roadmap changes that, including the suite and
  the parametrized test.
- **`foreach` as the parametrization mechanism.** `plugin-loop` stops at the
  first failing iteration by design, iterations share the test's scope, a single
  case cannot be parked or re-run, and forty cases collapse into one line in the
  report. Parametrization is the opposite of a loop in all four.
- **Behaviour that follows from `meta`.** Unchanged and unchangeable: the moment
  it does, a suite has control flow `speq validate` cannot see.
- **Competing with Postman for the same user.** The user who does not want to
  write YAML in git is not won by making the YAML better. The ground worth
  holding is the declarative API gate in CI for a polyglot repository: installs
  without a toolchain, catches a typo before the network, extends by plugin
  without a fork. Karate needs a JVM, Tavern is Python-only, Hurl is not
  extensible, Bruno went GUI-first, Step CI is abandoned. That intersection is
  currently held by nobody, and the entry price is M5.
