import type {
  AssertContext, AssertOutcome, AssertionDef, StepCode, StepDef, StepRecord, StepResult,
  RunStepsOptions, ExecContext, StepStatus, TestPhase
} from '@speqkit/plugin-api'
import type { Registry } from './registry.js'
import type { ResourceFrame } from './resources.js'
import {
  UnresolvedError, resolveDeep, resolveDeepAsync, resolveString,
  type ResolveScope, type ValueProviderFn
} from './interpolate.js'
import { comparison, recorded } from './events.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** Keys the kernel owns; a step type never receives them as input. */
const RESERVED_INPUT = new Set(['id', 'type', 'timeout', 'when', 'assert', 'meta'])

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
  /**
   * The instant the whole test's budget runs out, when it declared one.
   *
   * Held here rather than raced against from outside, because a race can only
   * stop *waiting* for the test — the step would run on, holding a connection
   * and writing rows, in a run that has already reported it as over. Every
   * step's own budget is capped by whatever is left of this, so the abort a
   * test-level timeout produces is the abort a step-level one produces, on the
   * path the plugin already handles.
   */
  deadline?: number
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
  #deadline: number | undefined
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
    this.#deadline = options.deadline
    this.#attach = options.attach
  }

  /**
   * Give up the test's budget, before the teardown runs.
   *
   * `cleanup` is not part of what the test was given time for, and this is the
   * one place the distinction is load-bearing: a test that ran out of time is
   * exactly the one that created something and did not delete it. It is a
   * method on the executor rather than a second executor for the teardown
   * because cleanup reads what the body bound — `${created.body.id}` is the
   * whole reason the block exists — and a fresh executor would have an empty
   * frame stack.
   */
  releaseDeadline(): void {
    this.#deadline = undefined
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

    // Asked before the type is looked up, and that order is the point: a step
    // switched off should not fail because the plugin that owns it is not
    // loaded in this environment. An unknown type is still reported — by
    // `speq validate`, which reads every step whatever its condition says.
    if (step.when !== undefined) {
      let go: boolean
      try {
        go = truthy(await resolveDeepAsync(this.scope(), step.when))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return this.#finish(base, started, 'error', `when: ${message}`, codeOf(err))
      }
      if (!go) {
        return this.#finish(
          base, started, 'skipped',
          `skipped: when ${JSON.stringify(step.when)} was false`,
          'when-false'
        )
      }
    }

    if (!entry) {
      const known = [...this.#registry.stepTypes.keys()].sort().join(', ') || '(none)'
      return this.#finish(
        base, started, 'error',
        `unknown step type '${step.type}'; loaded plugins provide: ${known}`,
        'unknown-step-type'
      )
    }

    // Before the step is announced: a test whose budget is already spent has
    // not started this step, and a `step.started` with no work behind it is a
    // step a reader goes looking for.
    const left = this.#deadline === undefined ? undefined : this.#deadline - Date.now()
    if (left !== undefined && left <= 0) {
      return this.#finish(base, started, 'error', 'the test ran out of time before this step', 'test-timeout')
    }

    this.#registry.events.emit({ type: 'step.started', ...base })
    await this.#registry.runHooks('step:before', { ...this.#owner(), suite: this.#suite, step })

    const own = readTimeout(step.timeout) ?? entry.def.timeoutMs ?? this.#defaultTimeoutMs
    // Whichever budget runs out first is the one that stops the step, and
    // which of the two it was is the difference between raising a number and
    // going to look at the step.
    const byTest = left !== undefined && left < own
    const timeoutMs = byTest ? left : own
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(
      byTest ? `the test ran out of time after ${timeoutMs}ms of this step` : `step timed out after ${timeoutMs}ms`
    )), timeoutMs)

    const previousParent = this.#parentId
    this.#parentId = step.id ?? previousParent

    // Held per step rather than on the executor: a step that nests others
    // is still running while its children record theirs, and one field would
    // hand the parent whatever its last child wrote.
    const detail: { value: unknown } = { value: undefined }

    // What this step ran underneath itself, in the order it ran them. The
    // field has been on `StepRecord` since the first commit and nothing ever
    // filled it, so a failure inside a loop existed in the event stream and
    // nowhere in the outcome — which is what `run --json` and every caller
    // that reads a `TestOutcome` are handed.
    const children: StepRecord[] = []

    let record: StepRecord
    try {
      // Under the same timeout as the step itself: a value provider that
      // answers over the network can hang, and a hang before the step is
      // still the step taking too long.
      const input = await withTimeout(this.#prepareInput(step), controller.signal)
      const ctx = this.#execContext(controller.signal, entry.owner, step.type, detail, children)
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
        ...(failure ? { message: failure.message, code: 'assertion-failed' as const } : {}),
        ...(assertions.length ? { assertions } : {}),
        ...(children.length ? { children } : {}),
        ...recorded(failure ? 'failed' : 'passed', detail.value),
        ...(this.#phase ? { phase: this.#phase } : {}),
        durationMs: Date.now() - started
      }
      this.#registry.events.emit({
        type: 'step.finished',
        ...base,
        status: record.status,
        durationMs: record.durationMs,
        ...(failure ? { message: failure.message, code: 'assertion-failed' as const } : {}),
        ...recorded(record.status, detail.value)
      })
    } catch (err) {
      // A crash inside a plugin is `error`, not `failed`: the test did not
      // prove the system wrong, the harness failed to ask the question.
      const message = err instanceof Error ? err.message : String(err)
      const code = byTest && controller.signal.aborted && err === controller.signal.reason
        ? 'test-timeout'
        : codeOf(err, controller.signal)
      record = {
        id: step.id,
        type: step.type,
        status: 'error',
        result: {},
        message,
        code,
        // Kept on the failure too: a loop that threw on its third iteration
        // did the first two, and what they did is most of what a reader needs.
        ...(children.length ? { children } : {}),
        // Whatever the step managed to record before it threw. This is the
        // case the buffered design exists for: a request that never came back
        // has no result to describe it, and the step said what it was doing
        // before it went quiet.
        ...recorded('error', detail.value),
        ...(this.#phase ? { phase: this.#phase } : {}),
        durationMs: Date.now() - started
      }
      this.#registry.events.emit({
        type: 'step.finished', ...base, status: 'error', durationMs: record.durationMs, message, code,
        ...recorded('error', detail.value)
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
          message: `unknown assertion '${assertion.type}'; loaded plugins provide: ${known}`,
          code: 'unknown-assertion'
        })
      } else {
        const input = (await resolveDeepAsync(this.scope(), withoutMeta(assertion))) as Record<string, unknown>
        try {
          out.push({ type: assertion.type, ...(await entry.def.evaluate(this.#assertContext(last), input)) })
        } catch (err) {
          out.push({
            type: assertion.type,
            passed: false,
            message: `assertion threw: ${err instanceof Error ? err.message : String(err)}`,
            code: 'assertion-threw'
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
        ...(latest.code ? { code: latest.code } : {}),
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

  #execContext(
    signal: AbortSignal,
    owner: string,
    stepType: string,
    detail: { value: unknown },
    children: StepRecord[]
  ): ExecContext {
    const self = this
    // The depth this step is executing at. A nested `runSteps` returns here
    // before the next one may start, and that is the whole of the check.
    const at = this.#depth
    return {
      resolve: <T>(template: string) => resolveString(self.scope(), template) as T,
      resolveDeep: <T>(value: T) => resolveDeep(self.scope(), value),
      runSteps: async (steps, options) => {
        if (self.#depth !== at) throw concurrentRunSteps(stepType)
        const records = await self.runSteps(steps, options)
        // Every call, not the last one: a loop calls this once per item, and
        // the first two iterations are most of what a reader needs about the
        // third.
        children.push(...records)
        return records
      },
      resource: <T>(name: string) =>
        self.#resources.acquire(name, (p) => self.#registry.configFor(p)) as Promise<T>,
      config: <T>() => self.#registry.configFor(owner) as T,
      attach: (name, body, contentType = 'application/octet-stream') =>
        self.#attach(name, body, contentType),
      record: (value) => { detail.value = value },
      signal,
      get vars() {
        return Object.freeze({ ...self.#frames[0] })
      }
    }
  }

  /**
   * A step that is over before it began: no plugin was called, so there is
   * nothing to time and nothing to record. One event, one record, whichever
   * of the three reasons it was.
   */
  #finish(
    base: {
      test?: string; suite?: string; stepId?: string; stepType: string; parentId?: string
      depth: number; meta?: Record<string, unknown>
    },
    started: number,
    status: StepStatus,
    message: string,
    code: StepCode
  ): StepRecord {
    const durationMs = Date.now() - started
    this.#registry.events.emit({ type: 'step.finished', ...base, status, durationMs, message, code })
    return { id: base.stepId, type: base.stepType, status, result: {}, message, code, durationMs }
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

/**
 * Which of the three ways a step can throw this was.
 *
 * The abort reason is compared by identity rather than by reading its
 * message: `withTimeout` rejects with exactly the error the timer aborted
 * with, and a plugin that throws a sentence containing the words "timed out"
 * is not a timeout — it is a plugin throwing, which is a different fix.
 */
function codeOf(err: unknown, signal?: AbortSignal): StepCode {
  if (signal?.aborted && err === signal.reason) return 'step-timeout'
  if (err instanceof UnresolvedError) return 'unresolved-reference'
  return 'plugin-threw'
}

/**
 * What `when:` counts as true, and it is deliberately dull.
 *
 * No expression language, now or later: `${count} > 0` is not a thing this
 * reads, because the moment it does, every author has to know which dialect
 * and every generated test has a new way to be subtly wrong. A condition that
 * needs arithmetic belongs in a step type, where it can be tested.
 *
 * The two strings are here because YAML makes them easy to arrive at by
 * accident — a quoted `"false"`, or a `${flag}` whose provider answers with
 * text — and a condition that is true because it is the *word* false is the
 * least useful thing this could do.
 */
function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return text !== '' && text !== 'false' && text !== 'no' && text !== '0'
  }
  return true
}

/**
 * `5000`, `'30s'`, `'2m'` — the same spelling wherever a budget is written,
 * on a step or on a test.
 */
export function readTimeout(value: unknown): number | undefined {
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
