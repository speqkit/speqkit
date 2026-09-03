# speqkit

A test framework that is mostly plugins.

The kernel loads plugins and gets out of the way. HTTP, the CLI, the authoring
format, control flow, reporters — every one of them is a plugin, including the
ones that ship in the box. A tester who needs something we did not build writes
it and publishes it; nothing needs to be agreed with us first.

> **speqkit** is the project. **`speq`** is the command you type.
>
> The npm scope and the GitHub organisation are [`speqkit`](https://github.com/speqkit);
> the binary is called `speq` because that is what gets typed fifty times a day
> — the same split as `@angular/cli` installing `ng`. The bare npm name `speq`
> belongs to an abandoned 0.0.0 placeholder and `@speq-ai/speq` is an unrelated
> project; neither is us.

Documentation: **<https://speqkit.github.io/speqkit/>** — quick start, the
kernel, [writing declarative tests](https://speqkit.github.io/speqkit/writing-tests.html),
[the two ways teams work with it](https://speqkit.github.io/speqkit/two-ways.html)
— tests before the code or after it — and
[how anything gets released](https://speqkit.github.io/speqkit/releasing.html).

## Status

M0, M1, M2 and the architecture gate are done; M4 has started. Fifteen
packages — the kernel as `speqkit`, the contract and eleven plugins under
`@speqkit`, plus the test kit and the scaffolder — so `npm i -g speqkit`
installs the `speq` binary from the registry rather than from this checkout.

What is next, in the order it has to happen — and which of it is cheap now and
expensive after 1.0 — is in [ROADMAP.md](ROADMAP.md).

`plugin-loop` was written against the published API with **no kernel changes**
— control flow is genuinely a plugin. `plugin-playwright` then exercised the
two parts of the spine the loop never touched, scoped resources and binary
artifacts, and found exactly one thing missing: `attach` took bytes and dropped
them. The plugin-facing call did not change; the kernel now writes the file and
the event carries a `path`. What the gate could *not* produce — screenshot on
failure — is written down in `packages/plugin-playwright/README.md` rather than
worked around.

M2 is the installer: `speq install` resolves against the npm registry over
HTTP, verifies hashes, extracts into `~/.speq` and writes `speq.lock` — without
`npm`, `pnpm` or a `node_modules` in the project. `--frozen`, `add`, `remove`
and `link` work, and a plugin can come from a repository as well as from the
registry: `github:acme/plugin#v2`, `git+ssh://…#main`, or a tarball URL. A ref
is resolved to a commit at install time and only the commit is locked, so
`--frozen` in CI installs what was reviewed rather than wherever a tag has
moved since. See `packages/installer/README.md`.

Step zero is closed too. `scripts/build-binary.mjs` produces one executable
with a pinned Node inside it, so a Go or Python repository can install a test
runner without installing a JavaScript toolchain first. It is not a separate
build of the kernel: `verify-publish.mjs --binary` points the same battery at
the executable with `PATH` emptied, and it has to install from a registry,
load four plugins out of the store and run a suite on a machine where `node`
cannot be reached at all.

The road from "works on my laptop" to "green in CI" is now closed. `--env`
layers an `environments/<name>.yaml` of settings — and only settings, because
the plugin set is what `speq.lock` pins and `--frozen` runs before anyone has
said which environment the run will use. `${env:VAR}` in a config file comes
from the process environment and fails loudly when unset. Reporters are
selected with `--reporter`, and `speq report` re-renders a finished run from
its recorded event log.

That last part closed the third hole of the same kind the gate found twice:
`defineReporter` had been on the contract since the first commit and nothing
had ever called it — the console output went straight to `events.subscribe`,
around the mechanism rather than through it. It is an ordinary reporter now,
and the default one.

The plugin list is settled — see `docs/architecture/plugins.html` for which
plugins are ours and why — and the first one on it is written.
`@speqkit/plugin-use` is composition: shared blocks, module actions and
fixtures, all through one `use` step. It came first because a real suite says
so: in the corpus it was written against, `use` outnumbers the HTTP step it
composes, 179 to 115.

Writing it found the rest of the test model missing. `Suite → Test → Step →
Assertion` had assertions only at the test, and a test had a body but no way to
build a world before it or take one down after — so 204 of the corpus's
assertions and every one of its 50 cleanups had nowhere to go. Both are the
kernel's, not a plugin's: a step type has no business reading an `assert:`
block that is not its input, and a plugin cannot express `finally` without
leaking its child scope back into the caller. Contract 0.6.0 adds
`StepDef.assert`, `TestDef.setup` and `TestDef.cleanup`; `PLUGIN_API_VERSION`
stays 1, and no ninth contribution point was opened. Cleanup runs after the
test whatever happened to it — including after a setup that never finished,
which is exactly when the rows a half-built test created would otherwise be
left behind — and a test that passed but failed to clean up is an `error`,
because the next run inherits what it left.

`@speqkit/plugin-data` is the second: `${gen:…}` for data a test makes up,
`${env:…}` moved out of `plugin-http` where it never belonged, and `${vars:…}`
for the values an environment file sets. Generated values are derived from a
seed rather than drawn from the system random source — the seed is the run id,
so replaying a run's data means copying the string that already names its
report directory, and a single failing test re-run alone sees exactly what it
saw inside the suite.

It also found the last piece of the test model missing. A test had no givens:
nothing could put a value in scope before the first step, because a plugin's
nested scope is popped the moment its step returns. Contract 0.7.0 adds
`TestDef.variables`, resolved **one at a time, in declaration order** — which
is what lets a given be written in terms of the one above it, and what keeps
two generated slugs from being the same slug twice. speq asks a value provider
once per resolution pass, deliberately; a whole block resolved in one pass
would have made the test that proves two tenants stay apart test one tenant
against itself.

`@speqkit/plugin-assert` is the third, and the first one that is deliberately
*wide*: twenty-one words for equality, order, membership, text, presence, size
and shape, over one selector shared by all of them. Wide is not deep — a
vocabulary is language, and language is the half of the line that is ours. A
team that cannot write "at least" or "is one of" writes it as a regex over a
stringified body, and the suite stops saying what it means. `schema` validates
through ajv rather than a subset of our own: a schema generated from OpenAPI
arrives with `oneOf` and `$ref`, and a validator that ignores the keywords it
does not know reports a pass it never performed. Schemas are compiled during
`speq validate`, so a typo in one is found in milliseconds.

`jsonpath` and `body_contains` left `plugin-http` for it, along with `env`
earlier: what is left in the HTTP plugin is the two checks that are actually
about HTTP, the status line and the time on the wire. Both old names still
work, and say what to write instead.

`@speqkit/plugin-json` is the fifth, and the first whose deliverable is a
*shape* rather than a feature: `reports/results/summary.json`, folded out of the
event stream, with the keys a workflow already reads. `totals.pending` is the
same number as `totals.skipped`, which is nobody's idea of a good design and is
exactly the point — a `jq` expression in another repository says
`.totals.pending // 0`, so renaming the key would make that workflow report zero
pending tests instead of failing. The moment somebody parses a shape it stops
being ours to tidy: keys get added, never renamed.

`pending` had to become real for that number to mean anything, and it is a
field of the spine rather than an annotation — it changes what happens, so it
is declared and checked. Contract 0.9.0 takes a *reason*, not a flag: a test
parked without one is a test being deleted slowly, and the reason is the only
thing that makes the entry worth keeping over `git rm`. A pending test is still
validated, because it is precisely the test nobody runs and therefore the one
that rots unnoticed.

`plugin-http` grew the two things the corpus's own "known gaps" section asks
for. **Multipart**, because three upload paths there have no gate test at all —
and the note explaining why says that `multipart`, `formData`, `form`, `files`,
`bodyFile` and `bodyRaw` were every one of them *silently ignored*: the request
went out empty and the test reported passed. Closed schemas mean an unknown key
is a diagnostic before a request goes out, and a part naming a file that is not
on disk is found the same way. And **retrying**, off by default, with two
decisions in the defaults: 429 is not on the list, because a policy that
repeats through a rate limiter makes the test that proves the limiter works
pass whether it exists or not; and only idempotent methods repeat, because a
502 means a gateway answered, not that the origin never saw the POST.

`@speqkit/plugin-yaml` is the fourth, and it closes the loop the corpus opened:
the whole 60-test suite it was designed against now migrates and validates —
`speq migrate` rewrites 66 files, and `speq validate` reports nothing. The
loader grew the decided test form (`id`, `title`, `tags`, `variables`, `setup`,
`steps`, `assert`, `cleanup`) and the codemod turns `{{x}}` into `${x}`,
`type: api` into `type: http`, `$steps.a.response.body` into `${a.body}`, a
folded `bodyFromFixture` into the `use` step it always was, and
`manifest.yaml` plus `environments/*` into a `speq.yaml` with layers. Comments
survive, because a suite this size is documentation as much as it is tests.
What has no successor yet — a suite-level `beforeEach`, a v1 retry policy — is
named by file with what to do instead, never dropped: a codemod that silently
drops what it does not understand leaves a suite that still runs with a guard
that is simply gone.

Contract 0.8.0 adds the field list nobody can close. `link`, `owner`, `epic`,
`severity`, a ticket number — there will be as many of these as there are
teams, so a test's spine is closed and everything outside it becomes `meta`,
which the kernel carries and never reads. On a step it has to be written under
a reserved `meta:`, because every *other* unknown key there belongs to the
plugin that owns the step's `type`; the kernel lifts it out before the schema
is checked. It reaches `test.started` and both step events, so a reporter gets
it for free, and `${meta:owner}` resolves like any other value — an `x-owner`
header on every request needs no plugin. **The kernel never branches on it**,
and that is an invariant rather than an implementation detail: the moment
behaviour follows from an annotation, a suite has control flow that `validate`
cannot see and a report cannot explain. No ninth contribution point was opened
for it, and none will be.

M4 is the ecosystem, and the first pieces are here: `@speqkit/test-kit`
runs a plugin inside the real kernel, `create-speqkit-plugin` scaffolds one with
those tests already written, and a plugin can now check its own inputs before a
run rather than during one — `StepTypeDef.validate` and
`AssertionTypeDef.validate`, contract 0.5.0. Writing the kit found the fourth hole of the
same kind: `AssertContext.results` was documented as every step result so far
and was always empty, and `${a.value}` in an `assert:` block reported that `a`
was not defined. The executor discarded the test's own bindings the moment its
last step finished — before assertions run, and nowhere else. Fixed, with the
two tests that were missing.

`speq run --workers 4` runs four suites at once, from a shared queue: whoever
finishes takes the next, so a suite that fails frees its slot rather than
stopping the run. Concurrency is between suites and nowhere else — a test runs
whole, the tests inside one suite stay sequential, and a step type that starts
a second `runSteps` beside one still running is refused rather than answered.
One worker by default and no `auto`: every other runner defaults to the CPU
count because its bottleneck is the local processor, and speq's is somebody
else's service, where four workers is four times the load and enough for step
timeouts to fire where they did not fire in sequence. The number can change a
verdict, so only the person who knows the system under test picks it.

What it cost is written next to `RunEvent`: events of different suites may
interleave, one suite's never do. Both reporters in the box had been reading
adjacency instead of identity — JUnit held one open case, so an interleaved
stream produced a file with one of two tests in it — and neither needed a
contract change to fix, which is the tell that they were wrong before anything
ran at once.

`speq run --shard 2/4` is the other half of the same answer: `--workers` is one
machine doing more at once, `--shard` is four machines each doing a quarter,
and they compose. The slice is by test and contiguous — by file would keep a
file whole, but a table of a thousand `cases` is one test in one file, so the
case shards exist for would be the one they could not split. A shard is an
independent run: it has its own `events.jsonl` and its own JUnit XML, and every
suite that has work in it opens in it.

A suite is now a thing rather than a file path. A directory holding a
`suite.yaml` is a suite: it has a title, a parent, annotations and tags every
test below it inherits outside-in, a `pending` that parks the lot with one
reason, and a `setup` and `cleanup` that run once — before the first test
anywhere under it and after the last, whatever happened to them. Suites nest,
and `suite.started` names its parent, so a reporter can rebuild the tree
without relying on adjacency. What a suite's setup binds stays in the suite:
a test that could read `${tenant.id}` from the directory above it would be a
different test when run alone, and running one test alone is how every failure
gets looked at. What crosses that line is a `suite`-scoped resource, which is
declared and named. The manifest is read by the loader — `LoaderDef.loadSuite`
— so YAML is where the fields are parsed and nowhere near where they mean
something.

A `cases:` table is one test per row, expanded by the kernel at discovery so a
case is an ordinary test everywhere it matters: `speq validate` checks five,
the report has five rows, and `speq run --name 'menu.create[jpy]'` re-runs one
of them. The id is written and never counted, because an index moves the day
somebody inserts a row above it and a report read next quarter is comparing
against a name.

The bet the whole project rests on — that a declarative suite is the right
artefact when a model writes the first draft — needs a generated test to be
checkable *before* it runs. That was true and unreachable from outside the
process. `speq validate --json` now answers with a document, and every
diagnostic in it carries a **`code`**: `unknown-step-type` is a different thing
from `missing-field`, and telling them apart no longer means matching
substrings of coloured stderr that any release is free to reword. `run` and
`list` take `--json` as well; `run` prints the counts and, per test, what
compared badly.

`speq capabilities` is the other half. Every step type, assertion, value
provider, reporter and loader the loaded plugins define, with the schema each
declared — all of it in the registry since load, and none of it reachable. So
an editor offering completion, a palette in a panel and a system prompt
describing speq to a model each carried a copy of the vocabulary, which went
stale the moment somebody installed a plugin, and went stale *silently*: a
suite written against the wrong vocabulary looks exactly like a suite with a
typo in it.

What that document could not say is what any of it is **for**. `speq docs`
does:

```bash
speq docs                # every plugin: what it is for, what it brought
speq docs http           # one entry, with examples to paste
speq docs --check        # every plugin here says what it is for
speq modules             # the blocks and actions this project already has
```

Both readers of that are worth naming. Somebody who has just run `speq add`
gets an example instead of a website. And a model writing the suite gets the
vocabulary and a working line of each in one call — which matters most, because
it is the reader least able to go and look, and the one whose wrong guess looks
exactly like a typo. `speq docs --check` fails on an example naming a step type
that no longer exists, which is precisely what a rename leaves behind and
precisely what a README on a website cannot notice.

## Writing a plugin

```bash
npm create speqkit-plugin kafka
cd speqkit-plugin-kafka && npm install && npm test
```

The scaffold makes the decisions that are easy to get wrong: the contract is a
peer, nothing depends on the kernel, the step type and the assertion carry
schemas, the `speqkit-plugin` keyword is there so the package can be found, and
a `docs` block is declared so `speq docs kafka` has something to say the moment
somebody installs it.
Its tests use `@speqkit/test-kit`, which assembles the real `Registry`,
`Executor` and runner — there are no fakes to drift, and green means it works
in a project.

```ts
const kit = await harness(plugin, { config: { kafka: { brokers: [] } } })
const step = await kit.step({ type: 'kafka.publish', topic: 'orders' })
expect(step.result.offset).toBe(0)
await kit.close()
```

## Try it

```bash
corepack enable && pnpm install && pnpm build
cd examples/basic

./node_modules/.bin/speq plugins    # the built binary, plain node, no tsx
```

Or against the sources, which is the faster loop while developing:

```bash
cd examples/basic

node --import tsx ../../packages/core/src/bin.ts plugins   # what is loaded
node --import tsx ../../packages/core/src/bin.ts validate  # the suites, green, no network
node --import tsx ../../packages/core/src/bin.ts validate --suite broken   # two typos caught
node --import tsx ../../packages/core/src/bin.ts run --env local --test suites/loop.yaml
node --import tsx ../../packages/core/src/bin.ts run --env ci --reporter console,junit \
  --test suites/health.yaml
node --import tsx ../../packages/core/src/bin.ts report --list   # runs already recorded
node --import tsx ../../packages/core/src/bin.ts report          # re-render one, no re-run

# UI, once a browser exists: pnpm exec playwright install chromium
node --import tsx ../../packages/core/src/bin.ts run --test suites/ui.yaml
```

## Layout

| Package | What it is |
| --- | --- |
| `@speqkit/plugin-api` | The public contract. Types only. Its major version is the compatibility boundary. |
| `speqkit` | The kernel and the `speq` bootstrap. Unscoped, because it is what you install. Knows no protocol and no UI. |
| `@speqkit/installer` | Resolve, verify, store, lock. No npm CLI involved. |
| `@speqkit/plugin-yaml` | The default authoring format, and `speq migrate` — proof the format is a plugin. |
| `@speqkit/plugin-json` | The run as one JSON file, in the shape a workflow reads with `jq`. |
| `@speqkit/plugin-http` | HTTP steps and the smoke assertion set. |
| `@speqkit/plugin-cli` | The terminal surface. Publishes the `cli` service. |
| `@speqkit/plugin-loop` | `loop` and `retry`. Control flow, contributed rather than built in. |
| `@speqkit/plugin-use` | Composition: shared blocks, module actions and fixtures, called with `use`. |
| `@speqkit/plugin-data` | Where values come from: seeded generated data, the environment, project variables. |
| `@speqkit/plugin-assert` | The assertion vocabulary: equality, order, membership, text, presence, size, JSON Schema. |
| `@speqkit/plugin-junit` | JUnit XML for CI, built from the event stream and nothing else. |
| `@speqkit/plugin-playwright` | Browser steps, scoped browser/page resources, screenshot artifacts. Playwright is an optional peer dependency. |
| `@speqkit/test-kit` | Runs a plugin inside the real kernel, so an author can test one without a project. Not a plugin. |
| `create-speqkit-plugin` | `npm create speqkit-plugin <name>` — source, tests and the decisions already made. Not a plugin. |

Every `plugin-*` above depends on `@speqkit/plugin-api` and on nothing else of
ours — never on the kernel. A plugin runs *inside* a kernel and reaches it as
`ctx.host`; one that imports `speqkit` instead ships a second kernel in
its `dependencies`, which the installer will faithfully put in the store and
the plugin will faithfully boot. `packages/core/test/host.test.ts` fails if any
manifest here names the kernel in what a user would install, or if any plugin
source imports it, and `scripts/verify-publish.mjs` fails if one ever reaches
the store. `@speqkit/test-kit` names the kernel deliberately, as a peer: it is
not a plugin, it boots one.

## Using it in a repository that is not a Node project

```bash
brew install speqkit/tap/speqkit    # or: curl -fsSL https://speqkit.github.io/speqkit/install.sh | sh
                                    # or: npm i -g speqkit, if Node is there
                                    # you install speqkit, you type speq
speq init                           # scaffold .speq/
speq add @speqkit/plugin-postgres   # edits speq.yaml, resolves, writes speq.lock
speq install --frozen               # CI: exactly the lock, or fail
speq link ../speqkit-plugin-mine    # a plugin you are writing, no publish needed
speq doctor                         # environment, store, and what came from where
```

Nothing lands in the repository except `.speq/` and `speq.lock`. The plugins
live in `~/.speq`, shared across every project on the machine.

## In CI

```yaml
- run: speq install --frozen                     # exactly the lock, or fail
- run: speq run --env ci --reporter console,junit
- uses: actions/upload-artifact@v7
  if: always()
  with: { name: speq-report, path: .speq/reports/ }
```

`--frozen` fails when `speq.lock` has drifted from `speq.yaml`. The exit code
comes from the spine: 0 passed, 1 failed, 2 the configuration was wrong before
anything ran. A misspelled `--reporter` or a missing `${env:VAR}` is caught
before the first test, not twenty minutes into the suite.

## What the kernel owns

Plugin registry and lifecycle · config with `extends` · the test model
(Suite → Test → Step → Assertion) · execution, `${...}` resolution and the
re-entrant `runSteps` · resources scoped to `run | suite | test` · the event
bus · results, artifacts and the run log · validation.

It owns nothing else. There is no protocol, no command, no report format and no
control construct anywhere in `packages/core`.

## The invariants

They are pinned by `packages/core/test/kernel.test.ts`, `gate.test.ts` and
`reporting.test.ts`. If one starts failing, the spine moved and the fix belongs
in the kernel, not in the test.

- A step type the kernel has never heard of runs, contributed at load time.
- A plugin nests steps through `ctx.runSteps` in a child variable scope, and
  that scope does not leak back to the parent.
- Resources open once per scope and tear down in reverse order.
- A plugin contributes to a surface that may not be loaded, and stays usable
  when nobody provides it.
- Two plugins cannot claim the same step type.
- A plugin built against a different `plugin-api` major is refused at load.
- A crash inside a plugin is `error`, never `failed`.
- All three resource scopes are real: `run` outlives the suite, `suite` outlives
  the test, and the outer ones tear down even when a test blows up.
- A suite opens once however many of its files run at the same time, and closes
  after the last of them — including the suites above that one.
- A suite whose setup did not complete blocks every test below it, says so once,
  and still runs its cleanup.
- Bytes handed to `attach` come back out of the run byte-for-byte, and every
  reporter is told where they went.
- A plugin installed from a registry loads out of the store, with its own
  dependencies resolvable, and `--frozen` reproduces it without a network.
- An environment layers settings and cannot add a plugin, so the lock stays
  true whichever environment runs.
- The event stream alone is enough to build a report: replaying a recorded run
  produces a byte-identical file to watching it live.

## Development

```bash
pnpm install
pnpm build          # tsc project references -> dist, with .d.ts and maps
npx tsc --noEmit    # typecheck
npx vitest run      # architecture tests
```

### Before publishing

```bash
pnpm build && node scripts/verify-publish.mjs
```

The tests run against `src` through a bundler alias, and that is exactly the
arrangement that hid a real bug: `exports` pointed at `.ts`, and Node refuses
to strip types inside `node_modules`, so anything published would not have
loaded at all. `verify-publish.mjs` trusts none of it — it packs the real
tarballs, serves them from a throwaway registry over HTTP (proxying anything
that is not ours to npm, since our packages have ordinary dependencies),
installs them into a throwaway store, and runs the CLI out of `dist` with plain
`node`. Then it pulls the plug on the registry and checks `--frozen` still
replays the lock.

It ends on the author's side of the same question: it scaffolds a plugin with
the packed `create-speqkit-plugin`, reads back the `package.json` npm would be
handed, and drives `@speqkit/test-kit` from `dist` under plain `node`.

### Building the standalone binary

```bash
pnpm build && node scripts/build-binary.mjs
node scripts/verify-publish.mjs --binary build/speq
```

The first command downloads the pinned Node from nodejs.org, checks it against
`SHASUMS256.txt`, bundles `packages/core/dist` into one CommonJS file, and
injects it as a SEA blob. The runtime is downloaded rather than taken from
`process.execPath` for a reason worth knowing before you try to shortcut it: a
package manager's `node` may be a 66 KB stub in front of a shared `libnode`,
with nothing to inject into. The second command is the same battery as above,
pointed at the executable with `PATH` emptied.

### Releasing

Nobody cuts a release. **Bump a version in a `package.json` and merge to
main** — if the gate is green, that version goes to npm, and if
`packages/core`'s version moved, four executables, a GitHub release and the
Homebrew formula follow it.

```bash
node scripts/release-plan.mjs     # what would this commit release?
```

Both questions face outward rather than at this repository — the npm registry
says which versions exist, the git tags on the remote say which releases were
cut — which is what makes a half-finished release safe to simply re-run.
`.github/workflows/release.yml` builds all four targets on native runners:
cross-compiling is not an option, because the SEA blob carries a V8 code cache
valid only for the exact runtime it goes into, and only macOS can re-sign a
Mach-O after injection.

It needs two secrets, set once — `NPM_TOKEN` (an npm *automation* token) and
`HOMEBREW_TAP_TOKEN` (a PAT with `contents: write` on `speqkit/homebrew-tap`).
The [Releasing page](https://speqkit.github.io/speqkit/releasing.html) has the
rest.

### Releasing a plugin — yours, not ours

A plugin whose release is something its author does by hand is a plugin that
gets its fix on the day its author has an afternoon. So the same machinery is
callable from any repository:

```yaml
# .github/workflows/release.yml, in your plugin's repository
jobs:
  release:
    uses: speqkit/speqkit/.github/workflows/plugin-release.yml@main
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`npm create speqkit-plugin` writes that file for you. For the release you do by
hand there is `packaging/release-plugin.sh`, which runs the same checks in the
same order:

```bash
export NPM_TOKEN=npm_xxxxxxxx
curl -fsSL https://speqkit.github.io/speqkit/release-plugin.sh | sh
```

Both paths run `scripts/check-plugin-package.mjs`, which refuses to publish a
package that would not load: `exports` pointing at TypeScript, a `dist` that
`files` does not carry, the kernel in `dependencies`, a missing
`speqkit-plugin` keyword. Every one of those is a bug this project shipped or
caught one commit before shipping, and it runs against any directory:

```bash
node scripts/check-plugin-package.mjs ../speqkit-plugin-kafka
```

## Contributing

Most of what people want to add is a plugin, and a plugin needs nothing from
us: `npm create speqkit-plugin`, then publish it from your own repository with
the workflow the scaffold already wrote. Tell us and we will link it.

For the rest — the kernel, the installer, the binary, the in-box plugins —
[CONTRIBUTING.md](CONTRIBUTING.md) has the setup, how to run the same gate CI
runs, and the two things about the contract that are deliberately closed.
[CHANGELOG.md](CHANGELOG.md) is what each release contained.
[SECURITY.md](SECURITY.md) is where a vulnerability goes, privately, instead of
the issue tracker. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT.
