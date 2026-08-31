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

The dependency in one sentence: **M5 unblocks M6, and both unblock most of
M4** — nested suites, parametrization and a device farm are all the same
missing thing, which is scopes that survive being entered twice at once.

---

## M5 — Frames — blocks 1.0

The kernel's promise that control flow is a plugin — `loop`, `retry`,
`parallel`, `try/catch` are ordinary step types calling `ctx.runSteps` — holds
for the three that run in sequence and does not hold for the fourth.

- [ ] **Variable scopes survive concurrent `runSteps`**
  - *Done when:* two nested runs started at once each see only their own variables.
  - *Where:* `packages/core/src/executor.ts` — `#frames` is one array on the
    instance, pushed with `unshift` and popped with `shift`, so a branch that
    resumes while another branch's frame sits on top reads the wrong frame.
  - *Evidence:* a throwaway `parallel` plugin, written against the published
    API exactly as the design record describes it, with branches sleeping 10 ms
    and 50 ms, returned `[["b"],["a"]]` where `[["a"],["b"]]` was expected.
    Branch `a` read branch `b`'s variable. It did not fail — it read the wrong
    value and passed.
  - *Test:* belongs with the invariants in `packages/core/test/kernel.test.ts`,
    not as a regression test. It is a statement that makes the architecture true.

- [ ] **A resource acquired twice at once is one resource**
  - *Done when:* two tests acquiring the same resource concurrently get one
    value, and every resource that was set up is torn down.
  - *Where:* `packages/core/src/resources.ts` — frames are a stack rather than
    a tree, and `acquire` caches the resolved value rather than the promise, so
    two concurrent acquisitions launch two resources and one is never released.
  - *Note:* the file's own doc comment already claims that data isolation under
    parallel execution falls out of this model. Today it does not. Either the
    code moves or the comment does, and the code is the one that should move.

- [ ] **The shape of parallelism is decided and written down**
  - *Done when:* a reporter can attribute every step to its test without
    depending on the order events arrive in.
  - *Why now:* `RunRequest` carries only `reporters`, so there is no way to ask
    for concurrency at all, and the ordering guarantees of `RunEvent` are
    currently implicit in the fact that nothing runs at the same time. Deciding
    the shape is required before 1.0; shipping the implementation is not.

- [ ] **`parallel` is a plugin, written against the published API**
  - *Done when:* a parallel step type is published from outside this repository
    with no kernel changes, the same way `@speqkit/plugin-loop` was.
  - *Why this is the gate:* it is the only way to know M5 is actually done. The
    claim was believed for months because nobody had written the plugin.

## M6 — The spine closes — blocks 1.0

Four items, all of which move `RunEvent`. **Land them in one release** so that
reporters break once rather than four times. Each is a field on the spine, in
the same tradition as the four holes already found and closed that way — none
of them opens a ninth contribution point.

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

- [ ] **A suite is a thing, not a file path**
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
  - *File name:* `suite.yaml`, not `init.yaml` — `speq init` already exists and
    means something else.

- [ ] **One test, many inputs**
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
  - *Blocked on:* M5 above all — a device farm exists to run in parallel — and
    on suite-level parameterization for a device matrix. Two smaller facts to
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
