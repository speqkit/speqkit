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
  /**
   * What the step recorded about itself, kept only when it did not pass.
   *
   * `result` is what the step returned and what `${id.…}` addresses. This is
   * whatever the step type judged a reader would need in order to understand a
   * failure — for an HTTP step, the request beside the response, since the
   * request is no part of what the step returns. Written with
   * `ExecContext.record`; dropped by the kernel when the step passed, because
   * evidence is a thing you read about a failure.
   */
  detail?: unknown
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

  /**
   * Keep what this step would need in order to explain itself, if it turns out
   * badly.
   *
   * A step's result never entered the event stream, so no reporter could print
   * the request and the response of a step that failed — whatever flag it was
   * given — and the only way to see an exchange was to run the test again with
   * a proxy in front of it. Putting the whole result on every `step.finished`
   * was the other way to close that, and it makes `events.jsonl` as large as
   * every response body in the run, nearly all of them from steps that passed.
   *
   * So the step decides what is worth recording and the kernel decides whether
   * it is worth keeping: the value is dropped when the step passes, and rides
   * on `step.finished` when it does not. Call it the moment the material is in
   * hand rather than at the end — a call made before a request that never
   * comes back is exactly the one worth having, and a step that throws has no
   * other way left to say what it was doing.
   *
   * Called twice, the last value wins. What goes in has to survive
   * `JSON.stringify`, because it is written to the run log. Redact secrets
   * here — a recorded `authorization` header is a credential in a CI artifact
   * — and keep it small enough that somebody will read it.
   */
  record(detail: unknown): void

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
 *   and its suite once, as `source` and `suite` on `test.started`; a name
 *   identifies a test for the whole run. Work that belongs to no test — a suite's own setup and cleanup —
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
  /**
   * `suite` is the suite this test belongs to, said by the test itself.
   *
   * It used to be said only by the bracketing: the last `suite.started` named
   * the suite the next `test.started` was in. That is adjacency, G4 takes it
   * away, and two reporters in this repository were reading it — one of them
   * after the same fault had already been fixed in the other. A test now
   * carries its own answer, and no reporter has to hold a "current suite"
   * again.
   *
   * `tags` is what `--tags` selects on, and it was the one thing about a test
   * that the stream never said.
   *
   * A reporter could group by suite, by file and by `meta`, and not by the
   * label the run was actually chosen with — so anything reporting per ticket,
   * per component or per swimlane had to re-discover the project to find out
   * what it had just watched run. Absent when the test carries none, on the
   * same terms as `meta`.
   */
  | { type: 'test.started'; test: string; suite?: string; source?: string; group?: string; title?: string; tags?: string[]; meta?: Record<string, unknown> }
  | { type: 'test.skipped'; test: string; reason: string }
  | { type: 'step.started'; test?: string; suite?: string; stepId?: string; stepType: string; parentId?: string; depth: number; phase?: TestPhase; meta?: Record<string, unknown> }
  /**
   * `detail` is what the step recorded about itself, and rides only when the
   * step did not pass — on the same terms, and for the same reason, as
   * `expected` and `actual` below.
   *
   * It is the one thing the stream never carried: a status, a duration and a
   * sentence say that a step failed and never what it did. A reporter can now
   * print the exchange, and a repair loop reading `events.jsonl` has the body
   * it needs to write the fix rather than a sentence about it. Its shape
   * belongs to the step type that wrote it — see `ExecContext.record`.
   */
  | { type: 'step.finished'; test?: string; suite?: string; stepId?: string; stepType: string; parentId?: string; depth: number; status: StepStatus; durationMs: number; message?: string; detail?: unknown; phase?: TestPhase; meta?: Record<string, unknown> }
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
  /** One sentence: what it reads a test out of. See `StepTypeDef.summary`. */
  summary?: string
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
  /**
   * A stable slug for what is wrong, e.g. `unknown-topic`.
   *
   * The kernel namespaces it with this plugin's short name — `http/unknown-topic`
   * — so a plugin may name as many kinds of problem as it likes without ever
   * colliding with the kernel's or another plugin's. Optional: a plugin that
   * gives none says `http/invalid`, which is still enough to tell whose check
   * failed.
   */
  code?: string
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
  /**
   * One sentence: what writing this step does.
   *
   * It rides on `speq capabilities`, where the schema has always been and the
   * sentence never was — so a reader, or a model being told what this project
   * can write, had a shape with no meaning attached to it. See `PluginDocs`.
   */
  summary?: string
  schema?: InputSchema
  /** Per-step timeout override, in milliseconds. */
  timeoutMs?: number
  /** Checks this step means something, beyond having the right shape. */
  validate?: Validator<StepDef>
  execute(ctx: ExecContext, input: Record<string, unknown>): StepResult | Promise<StepResult>
}

export interface AssertionTypeDef {
  /** One sentence: what this assertion claims. See `StepTypeDef.summary`. */
  summary?: string
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
  /** One sentence: what it produces, and where. See `StepTypeDef.summary`. */
  summary?: string
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
  /** One sentence: what it answers with. See `StepTypeDef.summary`. */
  summary?: string
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
  /**
   * What is wrong, as a slug: `unknown-step-type`, `missing-field`,
   * `duplicate-test-name`.
   *
   * The message beside it is written for a person and may be reworded in any
   * release; this is written for a program and may not. Without it the only
   * way to tell a step type that does not exist from one whose input is
   * malformed was to match substrings of coloured stderr — which is to say
   * that a suite a model generated could not be repaired without a human
   * reading the output.
   *
   * The kernel's own codes are bare words. Anything a plugin's `validate`
   * contributed carries that plugin's short name and a slash in front of it,
   * so the two sets cannot collide.
   */
  code: string
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
  /**
   * What the test was labelled with, suites included — the same set `--tags`
   * selects on, and the same set `test.started` carries.
   */
  tags?: string[]
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

/** One thing a loaded plugin contributed, named the way a suite names it. */
export interface Capability {
  /** The word written in a suite: a step's `type`, an assertion's `type`. */
  name: string
  /** The plugin that defined it. */
  plugin: string
  /** One sentence, from the plugin that defined it. */
  summary?: string
  /** The shape of its input, when it declared one. */
  schema?: InputSchema
}

/**
 * The whole grammar the loaded plugins understand, as a document.
 *
 * Every schema in here has existed in the registry since the plugin that owns
 * it registered, and none of it could be reached from outside the process. So
 * an editor offering completion, a palette in a panel and a system prompt
 * describing the language to a model each had to carry a copy of the
 * vocabulary — one that goes stale the moment somebody installs a plugin, and
 * goes stale silently, since a suite written against the wrong vocabulary
 * looks exactly like a suite with a typo in it.
 *
 * The point of asking the session rather than a document is that the answer is
 * true for *this* project: the same question in a project with one more plugin
 * has one more answer in it.
 *
 * Sorted by name rather than by load order, so two runs of the same project
 * produce the same document and a diff between two of them means something.
 */
export interface Capabilities {
  /** The contract this kernel speaks — `PLUGIN_API_VERSION`. */
  apiVersion: number
  /**
   * Every loaded plugin, where this session found it, and what it says about
   * itself — see `PluginDocs`. `docs` is absent for a plugin that declares
   * none, which is the state `speq docs --check` refuses.
   */
  plugins: { name: string; version?: string; origin?: string; docs?: PluginDocs }[]
  stepTypes: Capability[]
  assertions: Capability[]
  /** `prefix` is the part written in a template: `${env:HOME}` is the provider whose prefix is `env`. */
  valueProviders: (Capability & { prefix: string })[]
  reporters: Capability[]
  /** `extensions` is what makes a file a test, `suiteFiles` what makes one a suite. */
  loaders: (Capability & { extensions: string[]; suiteFiles?: string[] })[]
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
  /**
   * That grammar itself: every step type, assertion and value provider the
   * loaded plugins define, with the schema each declared for its input.
   *
   * Synchronous, like `validate`, and for the same reason: nothing is computed
   * and nothing is read from disk — the registry already holds all of it.
   */
  capabilities(): Capabilities
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

/**
 * Something somebody can paste, and the sentence saying when they would.
 *
 * `code` is lines in whatever format the project's loaders read — YAML, for
 * every loader published so far. It is a string rather than a `TestDef`
 * because what a reader needs is the thing they will actually type, and a
 * structure printed back out is never quite that.
 */
export interface Example {
  title: string
  code: string
  /** What it does, when the title does not already say it. */
  summary?: string
  /**
   * The capabilities it demonstrates: step types, assertions, provider
   * prefixes, reporter or loader names.
   *
   * This is what makes an example findable — `speq docs status` answers
   * because an example says it is about `status` — and what makes it
   * checkable: `speq docs --check` fails on a name no loaded plugin defines,
   * which is what a renamed step type leaves behind.
   */
  for?: string[]
}

/**
 * What a plugin says about itself, for the two readers who cannot read its
 * source: somebody who has just installed it, and a model being asked to write
 * a suite with it.
 *
 * `speq capabilities` has always answered *what may be written* — every step
 * type, every assertion, with schemas. What it could not answer is what any of
 * it is **for**, or what a working line looks like. That half lived in a README
 * on a website, which is a document a session cannot ask, cannot check, and
 * which is wrong the moment a step type is renamed.
 *
 * It is optional on the type because a fixture plugin declared inside a test
 * has no documentation and should not have to say so. It is required by
 * `check-plugin-package.mjs`, which is the gate a plugin passes on its way to
 * being published — so the obligation lands on plugins people install, and not
 * on the twenty throwaway plugins in this repository's own tests.
 */
export interface PluginDocs {
  /** One sentence: what this plugin is for. */
  summary: string
  /**
   * Where the prose is: a URL, or a path inside the published package.
   *
   * A link rather than the prose itself, because a README is long and this
   * document is answered on every `speq docs`.
   */
  readme?: string
  /**
   * At least one, and the reason this field is not optional.
   *
   * A capability listed with a schema and no example is a capability somebody
   * has to guess their way into. One line they can paste is worth more than
   * three paragraphs, and it is the form a model can act on directly.
   */
  examples: Example[]
}

export interface PluginSpec {
  name: string
  /** Major of @speqkit/plugin-api this plugin is written against. */
  apiVersion?: number
  /** Schema for this plugin's block in speq.yaml. */
  configSchema?: InputSchema
  /** What this plugin is for, and what using it looks like — see `PluginDocs`. */
  docs?: PluginDocs
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
