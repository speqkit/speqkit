import type {
  AssertContext, AssertOutcome, AssertionDef, StepDef, StepRecord, StepResult, RunStepsOptions,
  ExecContext, StepStatus, TestPhase
} from '@speqkit/plugin-api'
import type { Registry } from './registry.js'
import type { ResourceFrame } from './resources.js'
import {
  resolveDeep, resolveDeepAsync, resolveString, type ResolveScope, type ValueProviderFn
} from './interpolate.js'
import { comparison } from './events.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** Keys the kernel owns; a step type never receives them as input. */
const RESERVED_INPUT = new Set(['id', 'type', 'timeout', 'assert', 'meta'])

export interface ExecutorOptions {
  registry: Registry
  /**
   * The test being run, or absent when a suite is running its own setup or
   * cleanup — steps that belong to no test, because the suite exists before
   * the first one and after the last.
   *
   * Every event the executor emits names one owner: the test when there is
   * one, the suite otherwise.
   */
  test?: string
  /**
   * The suite the work belongs to, carried so a step hook can name it.
   *
   * A hook is registered once for the whole run, so under concurrency the same
   * function is called by two suites at a time. Without this it has the test
   * name and no way to tell which group it is in.
   */
  suite: string
  /**
   * The `test` frame this executor runs inside.
   *
   * Handed in rather than reached for. The resource manager holds no current
   * frame any more, because under concurrency there is no such thing: two
   * tests are inside two frames at the same moment, and each one has to be
   * told which is its own.
   */
  resources: ResourceFrame
  /** The test's annotations, answered as `${meta:…}` and carried on events. */
  meta?: Record<string, unknown>
  defaultTimeoutMs?: number
  attach(name: string, body: string | Uint8Array, contentType: string): void
}

/**
 * Executes steps, and hands plugins the ability to do the same.
 *
 * `runSteps` being re-entrant and public is what keeps control flow out of the
 * kernel: `loop`, `retry`, `if` and `try/catch` are ordinary step types that
 * call back into it with a child variable scope. The kernel therefore contains
 * no control constructs at all, and never needs to grow any.
 *
 * `parallel` is not on that list and cannot be. Every one of those constructs
 * runs its children one at a time; a `parallel` step type would have to run
 * two `runSteps` calls at once, and inside a test that is refused — see
 * `concurrentRunSteps` below. Concurrency in speq is between suites, where
 * nothing shares a frame.
 */
export class Executor {
  readonly #registry: Registry
  readonly #test: string | undefined
  readonly #suite: string
  readonly #resources: ResourceFrame
  readonly #meta: Record<string, unknown>
  readonly #defaultTimeoutMs: number
  readonly #attach: ExecutorOptions['attach']

  /** Innermost first. Step results and variables share one namespace. */
  #frames: Record<string, unknown>[] = [{}]
  #depth = 0
  #parentId: string | undefined
  #phase: TestPhase | undefined

  constructor(options: ExecutorOptions) {
    this.#registry = options.registry
    this.#test = options.test
    this.#suite = options.suite
    this.#resources = options.resources
    this.#meta = options.meta ?? {}
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#attach = options.attach
  }

  /** Whichever of the two this executor's events belong to. Exactly one is set. */
  #owner(): { test: string } | { suite: string } {
    return this.#test === undefined ? { suite: this.#suite } : { test: this.#test }
  }

  /** Every result bound so far, flattened innermost-last for assertions. */
  results(): Record<string, StepResult> {
    const out: Record<string, StepResult> = {}
    for (const frame of [...this.#frames].reverse()) {
      for (const [k, v] of Object.entries(frame)) {
        if (v && typeof v === 'object') out[k] = v as StepResult
      }
    }
    return out
  }

  scope(): ResolveScope {
    const providers = new Map<string, ValueProviderFn>()
    for (const [, { def }] of this.#registry.valueProviders) {
      providers.set(def.prefix, (key) => def.resolve(key))
    }
    // `meta` is the kernel's own prefix, refused to plugins at registration.
    // It costs one line here and saves a contribution point: a suite that
    // stamps `x-owner: ${meta:owner}` on every request needs no plugin, and
    // the annotation a report shows is the annotation the request carried.
    providers.set('meta', (key) => this.#meta[key])
    return { frames: this.#frames, providers }
  }

  /**
   * Bind the test's `variables` into its own frame, before anything runs.
   *
   * One entry at a time, in declaration order, each bound before the next is
   * resolved. Two reasons, and both are visible in a real suite:
   *
   * A given is often derived from the one above it —
   * `email: "speq-${slug}@example.com"` — which only works if `slug` is
   * already there.
   *
   * And resolution asks a value provider once per pass, deliberately: two
   * `${env:HOME}` in one step are one lookup. Resolving the whole block in a
   * single pass would apply that to generators too, so a test declaring
   * `slug: "${gen:uuid}"` and `otherSlug: "${gen:uuid}"` would get one uuid
   * twice — and the test that exists to prove two tenants stay apart would
   * quietly be testing one tenant against itself.
   */
  async defineVariables(variables: Record<string, unknown>): Promise<void> {
    for (const [name, value] of Object.entries(variables)) {
      try {
        this.#frames[0]![name] = await resolveDeepAsync(this.scope(), value)
      } catch (err) {
        throw new Error(
          `variable '${name}': ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        )
      }
    }
  }

  /**
   * Run a lifecycle phase — `setup` or `cleanup` — in the test's own frame.
   *
   * Not on `ExecContext`: a plugin has no business declaring that its nested
   * steps are somebody's cleanup. The runner labels the phase so reports can
   * tell "the test failed" from "the test passed and the teardown did not".
   */
  async runPhase(steps: StepDef[], phase: TestPhase | undefined): Promise<StepRecord[]> {
    const previous = this.#phase
    this.#phase = phase
    try {
      return await this.runSteps(steps)
    } finally {
      this.#phase = previous
    }
  }

  /**
   * The outermost call runs *in* the base frame rather than pushing one.
   *
   * A nested call must have a child scope — that is the whole of what `loop`
   * asks for. But the test's own steps are not nested inside anything, and
   * pushing a frame for them meant it was popped again the moment the last
   * step finished, taking every `id` binding with it. Assertions run after
   * that point: `${a.value}` reported that 'a' is not defined, and
   * `AssertContext.results` — documented as every step result so far — was
   * always empty. Only the depth-0 case was ever wrong, which is why it
   * survived: within one `runSteps` the frame is still there, so steps could
   * always read each other.
   */
  async runSteps(steps: StepDef[], options: RunStepsOptions = {}): Promise<StepRecord[]> {
    const nested = this.#depth > 0
    if (nested) this.#frames.unshift({ ...(options.vars ?? {}) })
    else Object.assign(this.#frames[0]!, options.vars ?? {})
    this.#depth += 1
    try {
      const records: StepRecord[] = []
      for (const step of steps) {
        const record = await this.#runStep(step)
        records.push(record)
        if (record.status === 'failed' || record.status === 'error') break
      }
      return records
    } finally {
      this.#depth -= 1
      if (nested) this.#frames.shift()
    }
  }

  async #runStep(step: StepDef): Promise<StepRecord> {
    const entry = this.#registry.stepTypes.get(step.type)
    const started = Date.now()
    const base = {
      ...this.#owner(),
      stepId: step.id,
      stepType: step.type,
      parentId: this.#parentId,
      depth: this.#depth,
      ...(this.#phase ? { phase: this.#phase } : {}),
      ...(isMeta(step.meta) ? { meta: this.#label(step.meta) } : {})
    } as const

    if (!entry) {
      const known = [...this.#registry.stepTypes.keys()].sort().join(', ') || '(none)'
      return this.#fail(base, started, 'error', `unknown step type '${step.type}'; loaded plugins provide: ${known}`)
    }

    this.#registry.events.emit({ type: 'step.started', ...base })
    await this.#registry.runHooks('step:before', { ...this.#owner(), suite: this.#suite, step })

    const timeoutMs = readTimeout(step.timeout) ?? entry.def.timeoutMs ?? this.#defaultTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`step timed out after ${timeoutMs}ms`)), timeoutMs)

    const previousParent = this.#parentId
    this.#parentId = step.id ?? previousParent

    let record: StepRecord
    try {
      // Under the same timeout as the step itself: a value provider that
      // answers over the network can hang, and a hang before the step is
      // still the step taking too long.
      const input = await withTimeout(this.#prepareInput(step), controller.signal)
      const ctx = this.#execContext(controller.signal, entry.owner, step.type)
      const result = await withTimeout(entry.def.execute(ctx, input), controller.signal)
      const bound = (result ?? {}) as StepResult

      // Bound before the assertions run, so a step can address its own result.
      if (step.id) this.#frames[0]![step.id] = bound

      const assertions = await withTimeout(this.#assert(step, bound), controller.signal)
      const failure = assertions.find((a) => !a.passed)

      record = {
        id: step.id,
        type: step.type,
        status: failure ? 'failed' : 'passed',
        result: bound,
        ...(failure ? { message: failure.message } : {}),
        ...(assertions.length ? { assertions } : {}),
        ...(this.#phase ? { phase: this.#phase } : {}),
        durationMs: Date.now() - started
      }
      this.#registry.events.emit({
        type: 'step.finished',
        ...base,
        status: record.status,
        durationMs: record.durationMs,
        ...(failure ? { message: failure.message } : {})
      })
    } catch (err) {
      // A crash inside a plugin is `error`, not `failed`: the test did not
      // prove the system wrong, the harness failed to ask the question.
      const message = err instanceof Error ? err.message : String(err)
      record = {
        id: step.id,
        type: step.type,
        status: 'error',
        result: {},
        message,
        ...(this.#phase ? { phase: this.#phase } : {}),
        durationMs: Date.now() - started
      }
      this.#registry.events.emit({
        type: 'step.finished', ...base, status: 'error', durationMs: record.durationMs, message
      })
    } finally {
      clearTimeout(timer)
      this.#parentId = previousParent
    }

    await this.#registry.runHooks('step:after', { ...this.#owner(), suite: this.#suite, step, record })
    return record
  }

  /**
   * Annotations are resolved for the report, and never at the report's cost.
   *
   * A label is written in terms of the run — `POST ${vars:adminApi}/tables` —
   * so leaving it verbatim would print the template instead of the request.
   * Resolving it is still not *reading* it: nothing here branches on what
   * comes back, and a template that cannot be resolved is shown as written
   * rather than allowed to fail a step. An annotation is never a reason for a
   * test not to run.
   */
  #label(meta: Record<string, unknown>): Record<string, unknown> {
    try {
      return resolveDeep(this.scope(), meta)
    } catch {
      return meta
    }
  }

  /**
   * Evaluates a step's own `assert` block against what it just returned.
   *
   * Every assertion in the block runs, including the ones after the first
   * failure: a step that got the status right and the body wrong should say
   * both, not stop at whichever was written first.
   */
  async #assert(step: StepDef, last: StepResult): Promise<(AssertOutcome & { type: string })[]> {
    const block = Array.isArray(step.assert) ? (step.assert as AssertionDef[]) : []
    const out: (AssertOutcome & { type: string })[] = []

    for (const assertion of block) {
      const entry = this.#registry.assertions.get(assertion.type)
      if (!entry) {
        const known = [...this.#registry.assertions.keys()].sort().join(', ') || '(none)'
        out.push({
          type: assertion.type,
          passed: false,
          message: `unknown assertion '${assertion.type}'; loaded plugins provide: ${known}`
        })
      } else {
        const input = (await resolveDeepAsync(this.scope(), withoutMeta(assertion))) as Record<string, unknown>
        try {
          out.push({ type: assertion.type, ...(await entry.def.evaluate(this.#assertContext(last), input)) })
        } catch (err) {
          out.push({
            type: assertion.type,
            passed: false,
            message: `assertion threw: ${err instanceof Error ? err.message : String(err)}`
          })
        }
      }

      const latest = out.at(-1)!
      this.#registry.events.emit({
        type: 'assertion.evaluated',
        ...this.#owner(),
        assertionType: assertion.type,
        passed: latest.passed,
        message: latest.message,
        ...(step.id ? { stepId: step.id } : {}),
        ...comparison(latest)
      })
    }
    return out
  }

  #assertContext(last: StepResult): AssertContext {
    const self = this
    return {
      results: self.results(),
      last,
      resolve: <T>(t: string) => resolveString(self.scope(), t) as T,
      resolveDeep: <T>(v: T) => resolveDeep(self.scope(), v),
      resource: <T>(name: string) =>
        self.#resources.acquire(name, (p) => self.#registry.configFor(p)) as Promise<T>
    }
  }

  /**
   * Inputs are resolved against the current scope — except nested `steps`,
   * which are handed to the plugin untouched. A loop's body must be resolved
   * once per iteration, in the child scope the loop itself creates.
   *
   * The whole input is resolved in one pass, so a value provider named twice
   * in one step is asked once.
   */
  async #prepareInput(step: StepDef): Promise<Record<string, unknown>> {
    const templated: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(step)) {
      if (!RESERVED_INPUT.has(key) && key !== 'steps') templated[key] = value
    }
    const resolved = await resolveDeepAsync(this.scope(), templated)

    const input: Record<string, unknown> = {}
    for (const key of Object.keys(step)) {
      if (RESERVED_INPUT.has(key)) continue
      input[key] = key === 'steps' ? step[key] : resolved[key]
    }
    return input
  }

  #execContext(signal: AbortSignal, owner: string, stepType: string): ExecContext {
    const self = this
    // The depth this step is executing at. A nested `runSteps` returns here
    // before the next one may start, and that is the whole of the check.
    const at = this.#depth
    return {
      resolve: <T>(template: string) => resolveString(self.scope(), template) as T,
      resolveDeep: <T>(value: T) => resolveDeep(self.scope(), value),
      runSteps: (steps, options) => {
        if (self.#depth !== at) throw concurrentRunSteps(stepType)
        return self.runSteps(steps, options)
      },
      resource: <T>(name: string) =>
        self.#resources.acquire(name, (p) => self.#registry.configFor(p)) as Promise<T>,
      config: <T>() => self.#registry.configFor(owner) as T,
      attach: (name, body, contentType = 'application/octet-stream') =>
        self.#attach(name, body, contentType),
      signal,
      get vars() {
        return Object.freeze({ ...self.#frames[0] })
      }
    }
  }

  #fail(
    base: {
      test?: string; suite?: string; stepId?: string; stepType: string; parentId?: string
      depth: number; meta?: Record<string, unknown>
    },
    started: number,
    status: StepStatus,
    message: string
  ): StepRecord {
    const durationMs = Date.now() - started
    this.#registry.events.emit({ type: 'step.finished', ...base, status, durationMs, message })
    return { id: base.stepId, type: base.stepType, status, result: {}, message, durationMs }
  }
}

/**
 * A test is the atomic unit, so two `runSteps` calls never overlap.
 *
 * Nothing in the contract could have stopped a plugin author from writing
 * `Promise.all([ctx.runSteps(a), ctx.runSteps(b)])`, and until this check the
 * kernel answered. Both calls shared one frame stack, so the second branch's
 * bindings landed in the first branch's frame: a throwaway `parallel` plugin
 * asked for two branches and got `[["branch-1"], ["branch-1"]]` — the same
 * branch twice, reported as passing. A rule that returns another branch's data
 * is not a rule, it is a trap.
 *
 * Refused here rather than documented, and refused where the mistake is rather
 * than where it shows: the wrong answer surfaces in an assertion three steps
 * later, and by then nothing points back at the `Promise.all`.
 */
function concurrentRunSteps(stepType: string): Error {
  return new Error(
    `step type '${stepType}' called runSteps while its own nested steps were still running. ` +
      'Steps inside one test never run at the same time — a test is the unit speq runs ' +
      'atomically, and concurrency lives between suites. Concurrent I/O inside execute() is ' +
      'fine and is usually what was wanted: fan out the requests, return one result.'
  )
}

function isMeta(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

/** An assertion's annotations are the kernel's, exactly as a step's are. */
function withoutMeta(assertion: AssertionDef): Record<string, unknown> {
  const { meta: _meta, ...rest } = assertion
  return rest
}

function readTimeout(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = match[2] ?? 'ms'
  return unit === 'm' ? amount * 60_000 : unit === 's' ? amount * 1000 : amount
}

function withTimeout<T>(work: T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(work).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err) }
    )
  })
}
