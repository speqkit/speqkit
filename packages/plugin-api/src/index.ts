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
  /** Present when a step type nests others (loop, retry, parallel). */
  steps?: StepDef[]
  [key: string]: unknown
}

export interface AssertionDef {
  type: string
  [key: string]: unknown
}

export interface TestDef {
  name: string
  tags?: string[]
  steps: StepDef[]
  assert?: AssertionDef[]
  /** Set by the loader; used to address the test from the CLI. */
  source?: string
}

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
   * This is what makes control flow a plugin concern: `loop`, `retry`,
   * `parallel` and `try/catch` are ordinary step types that call this.
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

export type RunEvent =
  | { type: 'run.started'; runId: string; tests: number; at: number }
  | { type: 'suite.started'; suite: string }
  | { type: 'test.started'; test: string; source?: string }
  | { type: 'step.started'; test: string; stepId?: string; stepType: string; parentId?: string; depth: number }
  | { type: 'step.finished'; test: string; stepId?: string; stepType: string; parentId?: string; depth: number; status: StepStatus; durationMs: number; message?: string }
  | { type: 'assertion.evaluated'; test: string; assertionType: string; passed: boolean; message: string }
  | { type: 'artifact.attached'; test: string; name: string; contentType: string; bytes: number; path?: string }
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

/* ------------------------------------------------------------------ */
/* Registration surface                                                */
/* ------------------------------------------------------------------ */

export interface StepTypeDef {
  schema?: InputSchema
  /** Per-step timeout override, in milliseconds. */
  timeoutMs?: number
  execute(ctx: ExecContext, input: Record<string, unknown>): StepResult | Promise<StepResult>
}

export interface AssertionTypeDef {
  schema?: InputSchema
  evaluate(ctx: AssertContext, input: Record<string, unknown>): AssertOutcome | Promise<AssertOutcome>
}

export interface ReporterDef {
  /** Called for every event in the run. */
  on(event: RunEvent): void | Promise<void>
  /** Called once after `run.finished`, for writing files. */
  finalize?(): void | Promise<void>
}

export interface ValueProviderDef {
  /** The prefix this provider claims, e.g. `env` for `${env:HOME}`. */
  prefix: string
  resolve(key: string): unknown | Promise<unknown>
}

export interface PluginContext {
  readonly pluginName: string
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
  /** Major of @speq/plugin-api this plugin is written against. */
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
 * where a plugin brings its own `@speq/plugin-api` along. Without the stamp a
 * plugin that omits `apiVersion` inherits the kernel's number and the
 * compatibility check silently agrees with itself.
 */
export function definePlugin(spec: PluginSpec): PluginSpec {
  return { ...spec, apiVersion: spec.apiVersion ?? PLUGIN_API_VERSION }
}
