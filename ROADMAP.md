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
    - *Taken up in M9*, where it is the first item and the one everything
      else there stands on. Left unchecked here, so the ledger does not
      claim a milestone contained something it did not.
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

## M8 — A surface a machine can read — any time — **done**

The bet that a declarative suite is the right artefact in an AI-assisted
workflow rests on one property: a generated test can be checked *before it
runs*. That property was real and unreachable from outside the process.

- [x] **`host.capabilities()`**
  - *Done:* one additive method on `Host`, and `speq capabilities [--json]` in
    front of it. Every step type, assertion, value provider, reporter and
    loader the loaded plugins define, with the `InputSchema` each declared,
    ordered by name so two runs of one project produce the same document.
  - *Why:* the schemas existed in the registry and never left it, so an editor,
    a UI palette and a generated system prompt all had to hardcode a grammar
    that goes stale the moment a plugin is installed — and goes stale
    *silently*, because a suite written against the wrong vocabulary looks
    exactly like a suite with a typo in it.
  - *What is deliberately not in it:* resources. A resource name is something a
    *plugin* asks for and never a word anybody writes in a suite, and this
    document answers "what may I write". `speq plugins` is the other half of
    the question — who is loaded, grouped by owner — and stays what it is.
  - *A command and not a bootstrap command:* the question is about the loaded
    plugins, so it cannot be asked before they are loaded. Same reason `run` is
    a plugin command.
- [x] **`--json` on `validate`, `list` and `run`, and a `code` on `Diagnostic`**
  - *Done:* the code is required on `Diagnostic` and optional on
    `ValidationProblem`, which is the plugin's side. The kernel's sixteen codes
    are bare words; anything a plugin's `validate` found is prefixed with that
    plugin's short name — `http/unknown-topic`, and `http/invalid` when the
    plugin named nothing — so the two sets cannot collide and a plugin that
    starts naming its problems next year cannot take a word the kernel wants.
  - *The rule that makes it worth anything:* the message is written for a
    person and may be reworded in any release; the code is written for a
    program and may not. `kernel.test.ts` pins the whole vocabulary in one
    assertion, which is where a rename gets noticed.
  - *Two decisions in the CLI.* The document goes to **stdout even when the
    news is bad**, including from `run` — stderr keeps what went wrong with the
    *command*, such as a malformed `--shard`, which is a bug in the caller
    rather than a result to read. And `--json` replaces the **default**
    reporter and not a chosen one, so `--json --reporter junit` still writes
    the XML: a document on stdout and a file on disk answer different callers.
  - *What `run --json` carries per test:* the identity, and `failures` —
    present and empty on a green test, so a row's shape does not depend on how
    it came out. `expected` and `actual` are in there; everything else is the
    report, which is already on disk under the `runDir` the document names.

## M9 — What to run, and whose fault it is — any time, after M8 — **done**

M8 made the framework legible to a machine: a grammar it can read, a document
it can parse, a code it can branch on. This milestone is about the workflow a
machine is put to work *inside* — a ticket, a branch, a suite that is red until
somebody makes it green — and about writing down the two ways a team can
arrange that, because the framework already serves both and says so nowhere.

**The caveat it carries, and the reason it is a milestone of its own:** nothing
here may be started before M8, and before the one item M7 marked misfiled and
left behind. That item — a step's result never reaches the event stream — is
adopted below as the first item here, because everything after it reads a
stream and prints what it found. A verdict without evidence is an exit code,
and we have one of those already.

**What is not ours, stated once so it is not re-litigated.** The specification
is not ours, in any format: a Jira ticket, a Spec-Kit repository, an OpenSpec
document, a page in somebody's wiki. We do not read it, do not discover
requirements in it, and do not measure coverage against it. *What* to cover is
the team's decision. Ours is execution — what to run once the work is done and
how to run it. The join between a requirement and a test is a tag somebody
wrote, and there will not be a second one: a YAML test names no source file, so
selecting tests from a diff of the code is not a feature we are missing, it is
a thing this design cannot do and should stop being asked for.

**The flow this serves, which already runs today.** Requirements arrive; a
branch is cut and named for the ticket; tests tagged with the same key are
written into it; whoever implements the feature works in that branch and runs
`speq run --tags <KEY>` locally, fixing the code — or saying the test is wrong;
the PR runs the whole suite in CI. Every step of that is a flag we already
have and a line of shell. Four things break, and they are the items below: the
tag nothing checks, the failure that does not say whose it is, the environment
that was never up being indistinguishable from code that is wrong, and the
amendment to an acceptance test that lands silently in a diff nobody reads as
one.

**What it does not need is a change to the spine.** `TestDef`, `StepDef`,
`SuiteDef` and `AssertionDef` are untouched, and no ninth contribution point is
opened. That is worth stating because the obvious ATDD field — a test declared
red on purpose — was considered and rejected; see *Not in M9*.

*What it did move, three times and additively, is the event stream:* a step's
`detail`, which the first item is about; a test's `tags`, which the third item
found missing while the plugin was being written; and a test's `suite`, which
the eighth item found a reporter guessing at. All three are new fields on
things the kernel produces, all three ride in the same minor — `plugin-api`
0.11.0 — and a reporter that ignores any of them behaves exactly as it did
before.

*The second half of the milestone arrived after the first was done*, and it is
the same question asked of the other reader. Items 1 to 7 are about a machine
being told **what happened**. Items 9 and 10 are about a person or a machine
being told **what is available** — which plugins are installed and what one
line of each looks like, and which blocks and actions this project has already
built. A generated suite is only as good as the vocabulary the generator knew
about, and that vocabulary lived in READMEs on a website that no session can
read, check, or notice going stale.

### The items

- [x] **A step's result reaches the stream** — **blocks 1.0**
  - *Done when:* a reporter can print the request and the response of a failed
    step without the test being run again, and a green run's `events.jsonl` is
    no larger than it is today.
  - *Where it came from:* M7's last unchecked box, which says of itself that it
    is misfiled there. It is here because it is the load-bearing half of
    everything below: an agent told "expected 200, got 500" can write nothing;
    an agent holding the body can write the fix.
  - *Opt-in, as M7 guessed:* the result on every `step.finished` makes the log
    as large as every response body in the run, most of them from steps that
    passed. The step decides what is worth recording — `plugin-http` records
    the exchange, `plugin-loop` has nothing to record — and it is the same
    mechanism the UI panel in M4 needs to show one.
  - *Land it with whatever else still owes the stream a change*, so reporters
    break once. It is the only item in this milestone that costs a major after
    1.0.
  - *Done:* `ExecContext.record(detail)`, with `detail` on `step.finished` and
    on `StepRecord`. It is **buffered rather than returned**, and that turned
    out to be the whole design: the step records the moment the material is in
    hand, and the kernel keeps the value only if the step ends badly. A
    callback handed the step's result could not have answered the case that
    matters most — a request that never comes back has no result to describe it
    — so `plugin-http` writes the request down *before* it opens the socket,
    and a refused connection still says what was attempted.
  - *And what recording it forced:* a run log is a CI artifact, so
    `authorization`, `cookie` and `x-api-key` keep their names and lose their
    values — a request that failed for want of a token has to stay
    distinguishable from one that never carried it — and a recorded body over
    8 KB is cut with the remainder counted out loud. Both belong to the plugin
    that knows what it is recording, not to the kernel, which polices the size
    of an `attach` no more than it polices this.
  - *Consumers, so the mechanism is not another `defineReporter` that nothing
    calls:* `speq run --json` carries it on the failing step, and
    `speq run --verbose` prints it — which is the sentence M7 wrote for this
    item before it knew what it was blocked on.

- [x] **The two ways of working are written down**
  - *Done when:* `docs/` has one page that names both, tells a reader which one
    they are in, and gives the commands for each from the first test to the
    green PR.
  - *Tests first — the ATDD way.* The suite is written from the requirement
    before the code exists, in a branch named for the ticket and tagged with
    it; red is the starting state and green is the definition of done. What the
    page has to say out loud, because every reader asks it: the suite is red on
    purpose, which is why it lives in the branch and not on main, and why it is
    not parked with `pending` — a criterion that does not run is not a gate.
    And that whoever implements the feature may disagree with a test: they
    change it in the same PR, where the diff is read as an amendment to the
    criterion rather than as a fix.
  - *Code first — the ordinary way.* The feature exists and the suite is
    written against it; tags are labels rather than a ticket key, the local
    loop is `--test` and `--name` on the file being worked on, and the gate is
    the whole suite in CI. Nothing about the framework differs. Which of red
    and green is the starting state is the whole of the difference, and the
    page should say that in one sentence rather than implying two tools.
  - *Why one page and not two:* the machinery is identical, two pages drift,
    and a reader who finds only the ATDD one concludes the framework has an
    opinion about their process. It does not — it has an opinion about
    evidence.
  - *Where:* beside `docs/writing-tests.html`, linked from the README, and from
    the quick start on the way out of a first green run.
  - *Done:* `docs/two-ways.html`, in every page's nav, linked from the README
    and from the end of the quick start — where the question it answers
    actually arrives, which is the moment somebody's first run went green and
    they are deciding when to write the next test.
  - *One thing the page found, which was not in this item.* Writing the
    code-first half honestly turns up a cost the tests-first half does not
    have: **a test written against working code is green from its first run,
    and a test that has never been red has not been shown to be able to go
    red.** An assertion on a field that no longer exists passes quietly for
    years. So that direction carries an instruction the other does not need —
    break it once on purpose and watch it report the difference — and the
    contrast is the strongest argument for tests-first that this page makes,
    precisely because it is not made as an argument.

- [x] **A run says whose fault it is**
  - *Done when:* a failed run answers, per test, which of three things to go
    and fix — the code, the test, or the environment — and a run against a
    service that was never up says so once instead of thirty times.
  - *What it adds over `run --json`, which M8 already shipped:* that document
    is the kernel's, carries the failures with their `expected` and `actual`,
    and stops there — correctly, because the kernel does not know what a work
    tag is or what "nothing was listening" looks like. This groups by the tag
    the work is filed under and classifies the failures. `failed` and `error`
    have meant "the answer was wrong" and "something broke" since the first
    commit, and nothing has ever told a caller that this is the line between
    fixing the code and fixing the test.
  - *Where:* a reporter in `@speqkit/plugin-gate`, writing
    `reports/<runId>/gate.json` beside the event log.
  - *Done:* `fix` and `why` on every red test, counted into `blame`, beside a
    `work` roll-up per key and the `unclaimed` tests no key claims. Built out
    of the stream and nothing else, so `speq report --reporter gate` renders a
    recorded run into the same document.
  - *What writing it found, and it needed the contract:* **a test's tags never
    entered the event stream.** A reporter could group by suite, by file and by
    `meta`, and not by the label the run was actually selected with — so
    anything reporting per ticket had to re-discover the project to learn what
    it had just watched run. `test.started` and `TestOutcome` gained `tags`,
    additively, in the same 0.11.0 batch as the step's `detail`. This is the
    fourth time a plugin written against the published contract has found the
    hole nobody inside the kernel could see, after `attach`, the empty
    `AssertContext.results` and the dead `defineReporter`.

- [x] **The work in hand selects itself**
  - *Done when:* `speq gate plan` prints what would run and why, and
    `speq gate` runs it and exits on the verdict.
  - *Honest about the size of it:* turning a branch called `JIRA-123` into
    `--tags JIRA-123` is a line of shell and does not earn a plugin. What earns
    it is the second half of that sentence — *and why*: which key was taken,
    where it was taken from, how many tests it selected, and which tests in the
    branch it did not. A selection nobody can inspect is how a gate comes to
    run nothing and pass.
  - *Done:* `speq gate plan`, `speq gate`, and the key resolved from `--key`,
    then `gate.key`, then the branch — with `plan` naming which of the three
    answered. A key that selects nothing exits 2 and says so rather than
    passing an empty run, which is the failure mode `plan` exists for.
  - *One thing the temporary directory taught:* the first version worked out
    where the project sits inside the repository by subtracting
    `rev-parse --show-toplevel` from `host.root`, and on macOS those two
    disagree — a temp directory is reached through a symlink — so every path
    built from the pair landed outside the repository. `rev-parse
    --show-prefix` answers the same question in git's own terms and cannot
    disagree with itself. The same fault would have hit any checkout reached
    through a symlink.

- [x] **A changed acceptance test is visible where it is reviewed**
  - *Done when:* `speq gate diff` lists the tests added, changed and removed in
    this branch against its base, in a form a PR comment can carry.
  - *Why not a seal and a refusal:* someone who believes an acceptance test is
    wrong is sometimes right, and a gate that forbids the amendment moves the
    argument into a chat window where no reviewer will ever find it. Tests here
    are data, so the amendment is already in the diff; what is missing is that
    nobody reads a YAML diff as a change to the acceptance criteria. Naming
    them makes it loud without making it forbidden — which is the same
    distinction `pending` draws, and for the same reason.
  - *Done:* `speq gate diff [--base]`, with `A...B` rather than `A..B` so
    somebody else's merge does not appear in this branch's diff, and with the
    tests inside each surviving file named — a reviewer reads names, and a
    removed file has none left to read.

- [x] **A test no gate would run is reported**
  - *Done when:* a test that carries no tag the gate selects on is reported by
    name, before it becomes a thing that only ever runs in the full CI suite
    with nobody to own it.
  - *The contract boundary this ran into, which is the reason it is a command
    and not a validator:* a plugin validates the step types and assertions it
    owns, and there is nowhere for it to say anything about a test as a whole.
    `Validator<TestDef>` would be a ninth contribution point, and it would be
    the worst of them — a plugin with an opinion about the spine. So this runs
    as a command in CI beside `speq validate`. Worth an issue recording the
    boundary, in the form CONTRIBUTING asks for, rather than a task to remove
    it.
  - *Done:* `speq gate plan` names them, and `--strict` turns them into exit 2
    for a team that has decided every test answers for something. News by
    default, because a regression suite written the ordinary way has nothing
    but untagged tests and is not wrong to.
  - *The `run:before` hook this item asked for was not written, and should not
    be.* It was written down before the plugin was. `HookPayload` on
    `run:before` names no tests, so the hook would have to re-discover the
    whole project on every run to find out what it was about to warn on — and
    it would then warn about tests the caller had deliberately excluded with
    `--test` or `--tags`. The command knows the selection; the hook does not.

- [x] **Decide how blame is routed**
  - *Done when:* either the classification is a heuristic in the reporter and
    the page says plainly what it gets wrong, or a transport plugin names the
    cause and there is a declared place to put it.
  - *Why it is a decision:* "every step errored with the same message, so the
    environment is down" is writable today over the existing stream and is
    wrong exactly when a service is half-up, which is the case that costs a
    person an afternoon. A cause named by `plugin-http` — connection refused,
    not a 500 — is honest and costs a field somebody has to design, either on
    `StepRecord` or inside the opt-in result of the first item. It is cheap to
    decide while that item is being built and expensive afterwards, which is
    why it is written down here rather than discovered later.
  - *Decided: the heuristic, in the reporter, and it does not read the
    message.* The fork as written assumed the heuristic had to be "every step
    errored with the same message, so the environment is down" — a reading of
    the run as a whole, which is exactly the thing that is wrong when a service
    is half-up. It does not have to be that. The rule shipped is per pair of
    tests: **two tests that broke identically did not both break for their own
    reasons**, because a cause more than one test shares is by definition
    inside none of them. Half-up is then not a special case at all — the tests
    that got through pass, the ones that hit the wall share a cause, and both
    are reported correctly.
  - *What it costs, written into the plugin's README rather than left in the
    source:* a run of one test cannot have a shared anything, so a lone test
    brought down by a service that was never up is reported as `test`. And two
    tests carrying the same bug are reported as `environment`. Both are the
    price of never parsing a message — the approach that would rot the first
    time somebody reworded one.
  - *And the declared field is not needed, which is the better outcome.* No
    `cause` on `StepRecord`, no vocabulary of error kinds for every transport
    plugin to implement and keep in step. `plugin-http` stayed a plugin that
    knows about HTTP, and the routing stayed a plugin that knows about runs.

- [x] **A test names its own suite**
  - *Done when:* no reporter has to keep a "current suite", and a summary built
    at `--workers 4` says the same thing as one built at `--workers 1`.
  - *Where it came from:* found while writing `plugin-gate`, which sidestepped
    it. `plugin-json` took a test's suite from the last `suite.started` it had
    seen, and its `#current` slot took a test's messages from whichever test
    started most recently. Under one worker both are right by accident. Under
    two, tests are filed under the wrong suite and a failure's message lands on
    somebody else's row.
  - *Why it survived:* it is **exactly** the fault M5 fixed in `plugin-junit`,
    and the comment in `plugin-json` asserted the opposite — "the recorded log
    preserves the order, so this holds on replay too", which is true only while
    one suite runs at a time. A reporter is wrong only on the inside: the exit
    code is the runner's and stayed right, so nothing pointed at the report.
  - *Done:* `suite` on `test.started`, and `plugin-json` rebuilt on a map keyed
    by test name. The alternative was dropping `suite` from `summary.json`,
    whose shape is somebody else's contract — so the field stayed and the
    stream learned to answer for it. `plugin-junit` now reads the same field;
    it had been using the file, which was the same answer by accident.

- [x] **A plugin says what it is for, and the session can be asked**
  - *Done when:* somebody who has just run `speq add <plugin>` can find out
    what it does and paste a working line of it without leaving the terminal,
    and the same answer is available as a document to something that is not a
    person.
  - *Why the kernel and not a website:* M8 made the grammar askable — every
    step type and assertion with its schema. What it could not answer is what
    any of it is **for**, or what one working line looks like. That half lived
    in a README on a website: a document a session cannot ask, cannot check,
    and which goes wrong silently the moment somebody renames a step type. The
    generator writing the suite is the reader who suffers most from that, and
    it is the reader least able to go and look.
  - *Done:* `PluginDocs` on `definePlugin` — a summary, a readme link and
    examples, each naming with `for` the capabilities it demonstrates — plus
    `summary` on every contribution def, carried through `host.capabilities()`.
    `speq docs [<name>] [--json]` is a bootstrap command beside `plugins` and
    `doctor`, because it is asked *about* the installation. Every plugin this
    repository publishes declares one, and both gates say so: the workspace
    test for ours, `check-plugin-package.mjs` for a stranger's.
  - *And `speq docs --check`, which is the part that keeps it true.* An example
    naming a step type that no longer exists is an error — that is precisely
    what a rename leaves behind, and precisely what a README on a website
    cannot notice. A capability no example demonstrates is reported and changes
    no exit code: some genuinely need none, and failing on it would buy an
    example per entry rather than an example worth reading.
  - *Optional on the type, required by the gates.* A fixture plugin declared
    inside a test has no documentation and should not have to say so. The
    obligation belongs to a package on its way to a registry, so that is where
    it is enforced — and the scaffold ships the declaration, the README section
    and the test that checks it.

- [x] **The project's own library is discoverable**
  - *Done when:* somebody can ask what blocks, actions and fixtures this
    project already has, and what each has to be called with, without grepping
    for them.
  - *Why it is the other half:* `speq docs` answers what the plugins offer, and
    that answer is identical in every project that installed them. The
    expensive question is the one that differs per project and is written down
    nowhere — a module action is a file somebody wrote last quarter. A
    newcomer and a generator both answer it the same way, by reaching for
    `http` and rebuilding a login that already existed.
  - *Done:* `speq modules [--json]`, contributed by `plugin-use` through
    `ctx.inject(['cli'])`. It lists every action with the properties it
    declares, every block with what it publishes, every fixture with the keys
    it builds, and a `use` step for each, ready to paste.
  - *In the plugin and not the kernel, deliberately.* The kernel does not know
    what a module is, and this needed it not to start: `use` owns the three
    forms, so `use` owns the catalogue. No ninth contribution point, and no
    kernel command that reads a directory a plugin defined.

### Not in M9, and deliberately

- **`expected: fail` on the spine.** The obvious ATDD field, and it is not
  needed: the branch is already the mechanism. A test that is red on purpose
  lives where the code is being written and is green by the time it merges, so
  main is never red by design and there is nothing for the kernel to invert.
  `pending` is not the answer either, in the other direction — it does not run,
  and a criterion that does not run is not a gate. The one case the field would
  serve is an acceptance suite parked on main for a feature nobody has started,
  which is a process a team may choose and can express with a tag and a second
  CI job. A field the kernel branches on is not worth the case that survives.
- **Selecting tests from a diff of the source.** A YAML test names no source
  file. Test-impact analysis is not on this list because it is not reachable
  from this design, and saying so is more useful than leaving it open.
- **Anything that reads a specification.** See the preamble. The tag is the
  join and the team writes it.
- **Gherkin as a loader.** Same answer `speq import` gave the Postman
  collection: a format converted once is your suite, a format converted on
  every run is a permanent dependency on somebody else's grammar.
- **A ninth contribution point.** Unchanged, and this milestone is the second
  time the answer held under pressure.

- **A registry of plugins nobody has installed.** `speq docs` answers out of
  the session, which is what makes its answer true for *this* project. A
  catalogue of plugins that are not loaded is a different thing — a search, and
  a document somebody has to keep — and the npm keyword already carries it.

*One ledger note when `plugin-gate` is written:* `docs/architecture/plugins.html`
needs a row for it, because `workspace.test.ts` checks that a package this
repository publishes has one. *Done.*

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
- [ ] **Freeze `@speqkit/plugin-api` at 1.0**
  - *Done when:* the Stability section of `packages/plugin-api/README.md` says
    the freeze is in effect, and the twelve month window on the previous
    contract starts counting from that sentence.
  - *Why it is last, and why no milestone blocks it any more.* Nothing on this
    roadmap is marked **blocks 1.0** and still open — M5 and M6 closed the two
    that were. What is missing is not a feature but evidence. Every hole found
    in the contract so far was found by writing a plugin against it: `attach`,
    the empty `AssertContext.results`, the dead `defineReporter`, and then
    `tags`, from `plugin-gate`. Four for four. A fifth is not a risk somebody
    imagined, it is the base rate.
  - *So the condition is use, not a date:* **the framework carries a real
    project's suite for long enough that the contract stops moving.** 0.11.0
    moved `RunEvent` three times in one milestone, and the last of the three
    existed because a reporter in this repository was reading adjacency that
    G4 had taken away a milestone earlier. Until a stretch of real use goes by
    without that happening, `0.x` is the honest label and a minor is where a
    break is allowed to live.

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
