/**
 * The public contract every plugin is written against.
 *
 * Nothing in here may reference the kernel's internals: this package is the
 * only surface a third-party author sees, and its major version is the
 * compatibility boundary. Adding is a minor; changing or removing is a major.
 */

export const PLUGIN_API_VERSION = 1 as const

/* ------------------------------------------------------------------ */
/* Test model — the spine. Plugins extend it, they never redefine it.  */
/* ------------------------------------------------------------------ */

export interface StepDef {
  id?: string
  type: string
  /** Present when a step type nests others (loop, retry, if). */
  steps?: StepDef[]
  /**
   * Checks against this step's own result, evaluated the moment it finishes.
   *
   * These are the `Assertion` of `Suite → Test → Step → Assertion`, so the
   * kernel owns them and a step type never receives them as input — a plugin
   * that closed its schema with `additionalProperties: false` would otherwise
   * reject a block it has no business reading. A failing one makes the step
   * `failed`: the system answered and the answer was wrong, which is a
   * different thing from the step erroring.
   */
  assert?: AssertionDef[]
  /**
   * Annotations the kernel carries and never reads.
   *
   * Reserved here, unlike on a test, because every *other* unknown key on a
   * step already belongs to the plugin that owns its `type` — it is that
   * plugin's input. Writing `owner: mira` beside `url:` would be handed to
   * `plugin-http`, which closes its schema and would reject it, and would be
   * right to. The kernel lifts `meta` out before the schema is checked and
   * before `execute` is called, so a plugin never sees it.
   */
  meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface AssertionDef {
  type: string
  /** Annotations, on the same terms as a step's — see `StepDef.meta`. */
  meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface TestDef {
  /**
   * The test's identity: stable, addressable, and what every event carries.
   *
   * A YAML test writes it as `id`, and the identity is the thing that must
   * not move — a report read next quarter is comparing this run against a
   * name, not against a sentence someone has since reworded.
   */
  name: string
  /**
   * The sentence a human reads, when the identity is not one.
   *
   * `menu.items-create.creates-item` is a good name and a poor headline;
   * "POST /restaurants/{id}/categories/{id}/items creates an item" is the
   * reverse. A report shows this and falls back to `name`.
   */
  title?: string
  tags?: string[]
  /**
   * Why this test is not being run — and the fact that it is not.
   *
   * A reason rather than a flag, because a test parked without one is a test
   * being deleted slowly. It records a gap the suite knows about: an endpoint
   * whose 429 path cannot be reached from a stack configured to survive the
   * rest of the run, a feature behind a flag nobody can turn on in CI. The
   * text is what a reader needs and the only thing that makes the entry worth
   * keeping over `git rm`.
   *
   * It is a field of the spine, not an annotation, and that is the line the
   * whole `meta` design draws: this changes what happens, so it is declared
   * and checked. A pending test is still validated — it is exactly the test
   * that rots unnoticed — it simply does not run, and reports `skipped`.
   */
  pending?: string
  /**
   * The test's givens, resolved once before anything runs and addressable as
   * `${name}` from setup, steps, assertions and cleanup alike.
   *
   * Resolved **in declaration order, one at a time**, each entry bound before
   * the next is read. That is what makes a derived given possible —
   * `email: "speq-${slug}@example.com"` — and it is what makes two entries
   * that generate look like two values rather than one: resolution asks a
   * value provider once per pass, so two `${gen:uuid}` written in a single
   * pass would be a single uuid.
   *
   * Only the kernel can bind these. A step type sees the test through a
   * nested scope that is popped when it returns, so a plugin that tried to
   * seed the test's own frame would lose everything it seeded.
   */
  variables?: Record<string, unknown>
  /**
   * One test, run once per case, each with its own status and its own name.
   *
   * A table of inputs is the single most copied thing in a suite: the same
   * eight steps written five times because the currency differs. Declared
   * here, the kernel expands the test at discovery — before validation,
   * before the run, before anything counts tests — so a case is an ordinary
   * test in every place that matters. `speq validate` checks five tests, the
   * report has five rows, and re-running one is re-running a test.
   *
   * The expansion could have lived in the loader, and for a loader that wants
   * its own table syntax it still can: `load` returns `TestDef[]` and always
   * could. It is on the spine because the *identity* is the part nobody may
   * invent twice — `name[case-id]`, from a declared id and never a position,
   * so inserting a case in the middle does not rename the four below it.
   */
  cases?: CaseDef[]
  /**
   * Steps that bring the test's world into existence, run before `steps`.
   *
   * They run in the test's own scope rather than a nested one, so what they
   * bind is addressable from the body, the assertions and the cleanup alike.
   */
  setup?: StepDef[]
  steps: StepDef[]
  assert?: AssertionDef[]
  /**
   * Steps that take the world back down, run after the test whatever happened
   * to it — including after a step errored, which is exactly when the rows a
   * test created would otherwise be left behind.
   */
  cleanup?: StepDef[]
  /**
   * Everything about the test that is not the test — `owner`, `epic`,
   * `severity`, a ticket number, whatever this team puts in its reports.
   *
   * The kernel carries it and does not read it. It has no opinion on which
   * fields are right, does not validate them, and — the invariant that keeps
   * this from becoming a second control language — **never branches on
   * them**. The moment behaviour follows from a meta key (`retries: 3`,
   * `skip: true`), a suite has control flow that `validate` cannot see, the
   * report cannot explain, and the author cannot find. Behaviour is a step
   * type or a config key: something declared, and something checked.
   *
   * A plugin that needs a field checks it where it reads it, and says so with
   * a `Diagnostic`. A typo in `ownr` costs a missing label in a report; a typo
   * in a step type costs a check that silently did not run. Different prices,
   * different treatment — which is why there is no ninth contribution point
   * for declaring test fields.
   */
  meta?: Record<string, unknown>
  /** Set by the loader; used to address the test from the CLI. */
  source?: string
  /**
   * Set by the kernel when this test came from a `cases` table: the name the
   * table was written under, shared by every case in it.
   *
   * What a report groups five rows back together by. It is not the identity —
   * the identity is `name`, and `name` is what a rerun addresses.
   */
  group?: string
  /**
   * Set by the kernel: the declared suites this test is inside, outermost
   * first, and empty when no directory above it declares anything.
   *
   * Carried on the test rather than handed to the runner beside it, because
   * `speq run --test one.yaml` has to see exactly the chain a full run sees.
   * A test that behaves differently depending on how the run was started is
   * the failure mode this whole milestone exists to remove.
   */
  suites?: SuiteDef[]
}

/**
 * One row of a test's `cases` table.
 *
 * Everything here overrides what the test declares, except `tags` and `meta`,
 * which are merged onto it: a case adds a label, it does not replace the set.
 */
export interface CaseDef {
  /**
   * The case's identity, and the only required field.
   *
   * Written, never counted. An index shifts the day somebody inserts a case
   * above it, and a report read next quarter is comparing this run against a
   * name.
   */
  id: string
  /** The sentence a human reads for this case, when the test's is not it. */
  title?: string
  /** Bound over the test's own givens, before anything in the test runs. */
  variables?: Record<string, unknown>
  /** Parks this one case, on the same terms as `TestDef.pending`. */
  pending?: string
  tags?: string[]
  meta?: Record<string, unknown>
}

/**
 * A group of tests that declares something about all of them.
 *
 * A suite has been a file path since the first commit, which is why nothing
 * could be said about a group of tests except by saying it in each of them.
 * A suite is now whatever declares itself one: a directory holding a manifest
 * is a suite, the files under it belong to it, and suites nest.
 *
 * What a suite declares is inherited **outside-in, nearest wins** — `meta`
 * merged key by key, `tags` unioned, `pending` and `title` taken from the
 * nearest declaration that has one — and a test overrides all of it.
 *
 * Its `setup` and `cleanup` run once for the suite, in a scope of their own
 * that the tests below cannot see. That last part is deliberate and is the
 * one surprise this design refuses to import: a test that could read
 * `${tenant.id}` bound by a suite's setup would be a different test when run
 * alone, and running one test alone is how every failure is investigated.
 * What a suite shares with its tests is a `suite`-scoped resource — declared,
 * named, and set up on demand whether the suite's setup ran or not.
 */
export interface SuiteDef {
  /**
   * The suite's identity: the directory it declares, relative to the project
   * root. Set by the kernel, never by the manifest — a name written by hand is
   * a name that can collide with the directory next to it.
   */
  name: string
  /** The sentence a report shows in place of the path. */
  title?: string
  /** Added to every test below, unioned with what the test declares. */
  tags?: string[]
  /**
   * Parks the whole suite, and every test under it, with one reason.
   *
   * A parked suite does not run its `setup` either: there is nothing to bring
   * into existence for tests that are not going to run.
   */
  pending?: string
  /** Steps run once, before the first test anywhere below this suite. */
  setup?: StepDef[]
  /** Steps run once, after the last test below it, whatever happened to them. */
  cleanup?: StepDef[]
  /** Annotations, on the same terms as a test's — carried, never read. */
  meta?: Record<string, unknown>
  /** Set by the kernel: the manifest file this was read from. */
  source?: string
}

/** Which part of a test a step belongs to. The body has no phase. */
export type TestPhase = 'setup' | 'cleanup'

/** Whatever a step returns is bound by its `id` and addressable as `${id.path}`. */
export type StepResult = Record<string, unknown>

export type StepStatus = 'passed' | 'failed' | 'error' | 'skipped'

export interface StepRecord {
  id: string | undefined
  type: string
  status: StepStatus
  result: StepResult
  message?: string
  durationMs: number
  /** Outcomes of this step's own `assert` block, in the order written. */
  assertions?: (AssertOutcome & { type: string })[]
  /** `setup` or `cleanup` when the step ran outside the body. */
  phase?: TestPhase
  /** Nested records, when the step ran children through `runSteps`. */
  children?: StepRecord[]
}

/* ------------------------------------------------------------------ */
/* Execution context handed to a step's execute()                      */
/* ------------------------------------------------------------------ */

export interface RunStepsOptions {
  /** Variables visible only to the nested steps. */
  vars?: Record<string, unknown>
  /** A label for the nested frame, used in events and reports. */
  label?: string
}

export interface ExecContext {
  /** Resolve a single `${...}` template against the current scope chain. */
  resolve<T = unknown>(template: string): T
  /** Resolve every `${...}` found anywhere inside a value. */
  resolveDeep<T>(value: T): T

  /**
   * Run nested steps in a child variable scope.
   *
   * This is what makes control flow a plugin concern: `loop`, `retry`, `if`
   * and `try/catch` are ordinary step types that call this.
   *
   * One call at a time. A step type may nest — call this from inside a call
   * that is still running, which is what `retry` around a `loop` is — but it
   * may not start a second call beside one already in flight, and the kernel
   * refuses that rather than answering it. A test is the unit speq runs
   * atomically; concurrency is between suites. What is fine, and is usually
   * what was wanted, is concurrent I/O inside a single `execute`: fan out the
   * requests, await them together, return one result. That touches no frame.
   */
  runSteps(steps: StepDef[], options?: RunStepsOptions): Promise<StepRecord[]>

  /** Acquire a resource declared by any loaded plugin. Cached per scope. */
  resource<T = unknown>(name: string): Promise<T>

  /** Configuration for the calling plugin, already validated. */
  config<T = Record<string, unknown>>(): T

  /** Attach a file or blob to the report. */
  attach(name: string, body: string | Uint8Array, contentType?: string): void

  /** Aborted when the step's timeout budget is spent. */
  readonly signal: AbortSignal

  readonly vars: Readonly<Record<string, unknown>>
}

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

export interface AssertContext {
  /** Every step result so far, keyed by step id. */
  readonly results: Readonly<Record<string, StepResult>>
  /** The last step's result — what a bare assertion applies to. */
  readonly last: StepResult | undefined
  resolve<T = unknown>(template: string): T
  resolveDeep<T>(value: T): T
  resource<T = unknown>(name: string): Promise<T>
}

export interface AssertOutcome {
  passed: boolean
  message: string
  expected?: unknown
  actual?: unknown
}

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

export type ResourceScope = 'run' | 'suite' | 'test'

export interface ResourceDef<T = unknown> {
  scope: ResourceScope
  setup(ctx: ResourceContext): T | Promise<T>
  teardown?(value: T, ctx: ResourceContext): void | Promise<void>
}

export interface ResourceContext {
  resource<T = unknown>(name: string): Promise<T>
  config<T = Record<string, unknown>>(): T
}

/* ------------------------------------------------------------------ */
/* Events — the contract every surface consumes                        */
/* ------------------------------------------------------------------ */

/**
 * What a reporter may rely on about the order these arrive in.
 *
 * The union alone was never enough to write a reporter against. Every reporter
 * in this repository was written while runs were sequential, and each one
 * quietly assumed more than that: that the last `suite.started` names the suite
 * the next `test.started` belongs to, that a step event belongs to the test
 * whose header was printed most recently. Those assumptions are adjacency, and
 * adjacency is exactly what suites running at once takes away.
 *
 * So the ordering is written down here, next to the shapes, and it is part of
 * the contract:
 *
 * - **G1** — `run.started` is the first event; `run.finished` is the last.
 * - **G2** — For any test, `test.started` precedes every event naming it and
 *   `test.finished` follows all of them.
 * - **G3** — For any suite, `suite.started` precedes the `test.started` of
 *   every test in it, and `suite.finished` follows every `test.finished`.
 *   Suites nest: a suite's `started` also precedes that of every suite naming
 *   it as `parent`, and its `finished` follows all of theirs.
 * - **G4** — Events of *different* suites may interleave in any order. Within
 *   one suite the stream is totally ordered, and a reporter may rely on that.
 * - **G5** — Within a test, step events are ordered. Nesting is expressed by
 *   `parentId` and `depth`, never by adjacency.
 * - **G6** — Every event belonging to a test names it; a test names its file
 *   once, as `source` on `test.started`; a name identifies a test for the whole
 *   run. Work that belongs to no test — a suite's own setup and cleanup —
 *   names its suite instead. On `step.started`, `step.finished`,
 *   `assertion.evaluated` and `artifact.attached`, exactly one of `test` and
 *   `suite` is set, and a reporter that only knows about tests can skip the
 *   others by asking for `test`.
 *
 * G4 is the one that costs something, and it is deliberately weaker than it
 * would be if tests ran concurrently: a reporter that groups by suite still
 * sees each suite's story in order, and only has to hold more than one story at
 * a time. Buffering per test and flushing on `test.finished` satisfies every
 * one of these without any state a sequential reporter did not already keep.
 */
export type RunEvent =
  | { type: 'run.started'; runId: string; tests: number; at: number }
  | { type: 'suite.started'; suite: string; parent?: string; title?: string; pending?: string }
  | { type: 'test.started'; test: string; source?: string; group?: string; title?: string; meta?: Record<string, unknown> }
  | { type: 'test.skipped'; test: string; reason: string }
  | { type: 'step.started'; test?: string; suite?: string; stepId?: string; stepType: string; parentId?: string; depth: number; phase?: TestPhase; meta?: Record<string, unknown> }
  | { type: 'step.finished'; test?: string; suite?: string; stepId?: string; stepType: string; parentId?: string; depth: number; status: StepStatus; durationMs: number; message?: string; phase?: TestPhase; meta?: Record<string, unknown> }
  /**
   * `expected` and `actual` are carried only when the assertion failed.
   *
   * `AssertOutcome` has had both since the first commit and the event dropped
   * them, so every surface downstream — the console, a UI panel, an agent
   * repairing its own suite — had a sentence and no values, and the only way
   * to see a diff was to run the test again with a proxy in front of it. They
   * are absent on a passing assertion on purpose: a response body per
   * assertion in `events.jsonl` buys nothing, because a diff is a thing you
   * read about a failure.
   */
  | { type: 'assertion.evaluated'; test?: string; suite?: string; assertionType: string; passed: boolean; message: string; stepId?: string; expected?: unknown; actual?: unknown }
  | { type: 'artifact.attached'; test?: string; suite?: string; name: string; contentType: string; bytes: number; path?: string }
  | { type: 'test.finished'; test: string; status: StepStatus; durationMs: number }
  | { type: 'suite.finished'; suite: string }
  | { type: 'run.finished'; runId: string; status: StepStatus; passed: number; failed: number; errored: number; skipped: number; durationMs: number }
  | { type: 'diagnostic'; level: 'info' | 'warn' | 'error'; message: string; source?: string }

export type EventListener = (event: RunEvent) => void

/* ------------------------------------------------------------------ */
/* Loaders — the authoring format is itself a plugin point             */
/* ------------------------------------------------------------------ */

export interface LoaderDef {
  /** Glob-ish suffixes this loader claims, e.g. ['.yaml', '.yml']. */
  extensions: string[]
  load(file: string, content: string): TestDef[] | Promise<TestDef[]>
  /**
   * Basenames, without extension, of the file that describes the directory it
   * sits in rather than being a test — `['suite']`, and `['suite', 'init']`
   * for a loader that also answers to an older spelling. Earlier names win.
   *
   * A file matching one of these is never a test, and the kernel will not
   * pass it to `load`.
   */
  suiteFiles?: string[]
  /**
   * Read one of those files into a suite.
   *
   * Here rather than in the kernel for the same reason `load` is: the
   * authoring format is a plugin point. What a suite *means* — the tree, the
   * identity, the inheritance, when its setup runs — is the kernel's, and a
   * loader that returns the fields is done. `name` and `source` are filled in
   * by the kernel and anything the manifest writes there is ignored.
   */
  loadSuite?(file: string, content: string): SuiteDef | Promise<SuiteDef>
}

/* ------------------------------------------------------------------ */
/* Commands — contributed into whichever surface plugin is loaded      */
/* ------------------------------------------------------------------ */

export interface CommandDef {
  summary: string
  usage?: string
  run(argv: string[]): Promise<number> | number
}

export interface CommandHost {
  register(name: string, def: CommandDef): void
  readonly commands: ReadonlyMap<string, CommandDef>
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export type HookName =
  | 'run:before' | 'run:after'
  | 'suite:before' | 'suite:after'
  | 'test:before' | 'test:after'
  | 'step:before' | 'step:after'

export interface HookPayload {
  test?: string
  /**
   * The suite the hook is firing inside — on every hook that has one, which
   * is all of them but `run:before` and `run:after`.
   *
   * A hook is registered once for the whole run, so two suites running at the
   * same time call the same function. A hook holding per-suite state has to
   * key on something, and the test name is not it.
   */
  suite?: string
  step?: StepDef
  record?: StepRecord
}

/* ------------------------------------------------------------------ */
/* Schemas — plugins describe their inputs so the kernel can validate  */
/* ------------------------------------------------------------------ */

/**
 * A JSON-Schema-shaped object. Kept structural on purpose so a plugin may
 * hand-write it, generate it from zod, or emit it from anything else.
 */
export interface InputSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

/** Marker the kernel substitutes with its own recursive step schema. */
export const STEPS_SCHEMA = { $ref: '#/definitions/steps' } as const

/**
 * One thing a plugin found wrong with a step or an assertion it owns.
 *
 * A plain string is the same as `{ message }`. The kernel supplies the file
 * and the address of the step itself, so a plugin can neither get the location
 * wrong nor have to work it out.
 */
export interface ValidationProblem {
  message: string
  hint?: string
  /** Where *inside* the step or assertion, e.g. `schema` or `body.items[0]`. */
  path?: string
}

export interface ValidateContext {
  /**
   * The test this step or assertion belongs to — absent when it belongs to a
   * suite instead, which a suite's own `setup` and `cleanup` do.
   */
  readonly test?: TestDef
  /** The suite it belongs to, when it is not a test's. Exactly one is set. */
  readonly suite?: SuiteDef
  /** The file it came from, as it will read in the diagnostic. */
  readonly file: string
  /** This plugin's block in speq.yaml, already validated against its schema. */
  config<T = Record<string, unknown>>(): T
}

/**
 * Checks a plugin can make that a schema cannot.
 *
 * `schema` says what shape an input has; this says whether it means anything —
 * that the schema file an assertion names is on disk, that a topic exists in
 * the config, that two mutually exclusive fields are not both set. Without it
 * the only place left to find out is the middle of a run, from a step type
 * that cannot explain which file the mistake is in.
 *
 * **Synchronous on purpose.** `speq validate` and the check in front of every
 * run are expected to cost milliseconds; reading a file here is fine and a
 * network call is not. A validator that throws is reported as a diagnostic
 * against the plugin rather than taken as the whole run's failure.
 */
export type Validator<T> = (subject: T, ctx: ValidateContext) => (string | ValidationProblem)[] | void

/* ------------------------------------------------------------------ */
/* Registration surface                                                */
/* ------------------------------------------------------------------ */

export interface StepTypeDef {
  schema?: InputSchema
  /** Per-step timeout override, in milliseconds. */
  timeoutMs?: number
  /** Checks this step means something, beyond having the right shape. */
  validate?: Validator<StepDef>
  execute(ctx: ExecContext, input: Record<string, unknown>): StepResult | Promise<StepResult>
}

export interface AssertionTypeDef {
  schema?: InputSchema
  /** Checks this assertion means something, beyond having the right shape. */
  validate?: Validator<AssertionDef>
  evaluate(ctx: AssertContext, input: Record<string, unknown>): AssertOutcome | Promise<AssertOutcome>
}

export interface ReporterContext {
  runId: string
  /**
   * The stable directory runs write into — `reports/`, not `reports/<runId>/`.
   *
   * A CI workflow names one fixed path in `upload-artifact`, so a report that
   * moved every run would be unusable there. Undefined when the caller asked
   * for nothing on disk.
   */
  outputDir?: string
  /** This run's own directory, `reports/<runId>/`, holding artifacts and the event log. */
  runDir?: string
}

export interface ReporterDef {
  /**
   * Called once before the first event, with where this run may write.
   *
   * Optional because a reporter that only prints needs none of it — but
   * without it a file-writing reporter would have to guess the path, and
   * `runId` is not known until the run begins.
   */
  init?(ctx: ReporterContext): void | Promise<void>
  /** Called for every event in the run. */
  on(event: RunEvent): void | Promise<void>
  /** Called once after `run.finished`, for writing files. */
  finalize?(): void | Promise<void>
}

export interface ValueProviderDef {
  /**
   * The prefix this provider claims, e.g. `env` for `${env:HOME}`.
   *
   * `meta` is the kernel's and is refused: `${meta:owner}` answers out of the
   * running test's own annotations, so an `x-owner` header needs no plugin.
   */
  prefix: string
  /**
   * Answer one key.
   *
   * May take its time — a secret from a vault, a row from a database. speq
   * asks every provider a step input or an assertion names before the step
   * runs, all of them at once, and awaits them together.
   *
   * Asked once per resolution pass rather than once per `${...}`, so a key
   * written twice in one step is one call: a provider is a lookup, not a
   * generator. The pass is one step wide, so a value that changed between two
   * steps is read again by the second.
   *
   * `ExecContext.resolve` is synchronous by contract and cannot wait: a
   * template a plugin resolves by hand throws rather than handing back a
   * Promise it would put in a request body unnoticed.
   */
  resolve(key: string): unknown | Promise<unknown>
}

/* ------------------------------------------------------------------ */
/* The kernel, as a plugin sees it                                     */
/* ------------------------------------------------------------------ */

export interface Diagnostic {
  /** The test file the problem is in, relative to the project root. */
  file: string
  /** Where inside it, e.g. `steps[2].type`. */
  path: string
  message: string
  hint?: string
}

export interface ArtifactRecord {
  /** The test it was attached from — or the suite, when a suite's own step did. */
  test: string
  name: string
  contentType: string
  bytes: number
  /** Where it was written. Absent when the run has no artifact directory. */
  path?: string
  /** Retained only when nothing was written, so a caller can still read it. */
  body?: string | Uint8Array
}

export interface TestOutcome {
  name: string
  title?: string
  /** The `cases` table this row came from, when it came from one. */
  group?: string
  /** Set when the test did not run, carrying the reason it says. */
  pending?: string
  meta?: Record<string, unknown>
  source?: string
  suite: string
  status: StepStatus
  durationMs: number
  steps: StepRecord[]
  assertions: (AssertOutcome & { type: string })[]
  artifacts: ArtifactRecord[]
}

export interface RunOutcome {
  runId: string
  status: StepStatus
  durationMs: number
  tests: TestOutcome[]
  artifacts: readonly ArtifactRecord[]
  passed: number
  failed: number
  errored: number
  skipped: number
}

export interface DiscoverQuery {
  /** A single file, relative to the project root. */
  test?: string
  /** A single directory, relative to the project root. Defaults to `suites`. */
  suite?: string
  /** Keep only tests carrying at least one of these tags. */
  tags?: string[]
  /**
   * Keep only tests with these exact names, cases included.
   *
   * The other three narrow by where a test lives or what it is labelled, and
   * between them there was no way to say *that one*. Re-running a single
   * failing case is the commonest thing anybody does after reading a report,
   * and until this it meant running the file and watching the other nine.
   */
  names?: string[]
}

export interface RunRequest {
  /** Reporters to drive, by the name their plugin registered. */
  reporters?: readonly string[]
  /**
   * How many suites may be in flight at once. One by default.
   *
   * Concurrency in speq is between suites and nowhere else: a test runs whole,
   * interleaved with nothing, and steps inside a test never overlap. Raising
   * this multiplies the load on the system under test by the same factor, so
   * there is no `auto` — the number belongs to whoever knows what that system
   * can take.
   */
  concurrency?: number
}

export interface RecordedRun {
  runId: string
  dir: string
  at: number
}

/**
 * The running kernel, handed to every plugin as `ctx.host`.
 *
 * It exists so that a plugin never imports the kernel. `plugin-cli` used to
 * open with `import { bootstrap, runTests } from 'speqkit'`, and that
 * one line cost two things. It put the kernel in the plugin's published
 * `dependencies`, so the installer dutifully materialised a second copy of it
 * into the store; and it meant the plugin called `bootstrap()` inside a
 * process that had already booted — so every plugin was loaded twice per
 * invocation, into two registries that knew nothing about each other, and the
 * kernel the user installed was quietly replaced by whatever speq.lock pinned.
 *
 * A plugin is contributed *into* a kernel that is already running. It cannot
 * bring its own, and there is deliberately nothing here to construct one
 * with: this is the session the plugin is executing inside, not a way to
 * start another. What a plugin and a kernel must agree on is the major of
 * this package, checked as `apiVersion` — and nothing else.
 */
export interface Host {
  /** The project root: the directory holding speq.yaml. */
  readonly root: string
  /** `<root>/reports` — where run logs, artifacts and reports are written. */
  readonly reportDir: string
  /** The environment layer in effect, when `--env` or SPEQ_ENV asked for one. */
  readonly env: string | undefined

  /** Ask the registered loaders which tests exist. */
  discover(query?: DiscoverQuery): Promise<TestDef[]>
  /** Check tests against the grammar the loaded plugins define. */
  validate(tests: TestDef[]): Diagnostic[]
  /** Execute tests in this session. */
  run(tests: TestDef[], options?: RunRequest): Promise<RunOutcome>
  /** Runs already recorded under `reportDir`, newest first. */
  runs(): RecordedRun[]
  /** Re-emit a recorded run's events, so reporters render it without rerunning it. */
  replay(run: RecordedRun, reporters: readonly string[]): Promise<readonly RunEvent[]>
}

export interface PluginContext {
  readonly pluginName: string

  /**
   * The kernel this plugin is running inside — see `Host`.
   *
   * A plugin *uses* the kernel; it does not depend on it. Everything a plugin
   * needs from the kernel comes through here, which is why no plugin in this
   * repository has `speqkit` in its package.json.
   */
  readonly host: Host
  /** This plugin's slice of speq.yaml, already validated against its schema. */
  config<T = Record<string, unknown>>(): T

  defineStepType(type: string, def: StepTypeDef): void
  defineAssertion(type: string, def: AssertionTypeDef): void
  defineResource<T>(name: string, def: ResourceDef<T>): void
  defineReporter(name: string, def: ReporterDef): void
  defineValueProvider(name: string, def: ValueProviderDef): void
  defineLoader(name: string, def: LoaderDef): void
  defineHook(name: HookName, fn: (payload: HookPayload) => void | Promise<void>): void

  /**
   * Register a service other plugins may depend on.
   * `plugin-cli` publishes `cli`; anything wanting to add a command injects it.
   */
  provide<T>(service: string, value: T): void

  /**
   * Run `fn` once every plugin has registered, but only if every named
   * service exists. This is how a plugin contributes to a surface that may
   * not be loaded — the plugin stays usable either way.
   */
  inject(services: string[], fn: (resolved: Record<string, unknown>) => void): void

  /** Subscribe to the run's event stream. */
  onEvent(listener: EventListener): void

  readonly schema: { steps: typeof STEPS_SCHEMA }
}

export interface PluginSpec {
  name: string
  /** Major of @speqkit/plugin-api this plugin is written against. */
  apiVersion?: number
  /** Schema for this plugin's block in speq.yaml. */
  configSchema?: InputSchema
  setup(ctx: PluginContext): void | Promise<void>
}

/**
 * Stamps the plugin with the contract major it was *built against*, taken from
 * this copy of the package rather than from the kernel's.
 *
 * That distinction is invisible until plugins start loading from the store,
 * where a plugin brings its own `@speqkit/plugin-api` along. Without the stamp a
 * plugin that omits `apiVersion` inherits the kernel's number and the
 * compatibility check silently agrees with itself.
 */
export function definePlugin(spec: PluginSpec): PluginSpec {
  return { ...spec, apiVersion: spec.apiVersion ?? PLUGIN_API_VERSION }
}
