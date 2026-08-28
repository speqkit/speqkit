import type {
  StepDef, StepRecord, StepResult, RunStepsOptions, ExecContext, StepStatus
} from '@speqkit/plugin-api'
import type { Registry } from './registry.js'
import { resolveDeep, resolveString, type ResolveScope } from './interpolate.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** Keys the kernel owns; a step type never receives them as input. */
const RESERVED_INPUT = new Set(['id', 'type', 'timeout'])

export interface ExecutorOptions {
  registry: Registry
  test: string
  defaultTimeoutMs?: number
  attach(name: string, body: string | Uint8Array, contentType: string): void
}

/**
 * Executes steps, and hands plugins the ability to do the same.
 *
 * `runSteps` being re-entrant and public is what keeps control flow out of the
 * kernel: `loop`, `retry`, `parallel` and `try/catch` are ordinary step types
 * that call back into it with a child variable scope. The kernel therefore
 * contains no control constructs at all, and never needs to grow any.
 */
export class Executor {
  readonly #registry: Registry
  readonly #test: string
  readonly #defaultTimeoutMs: number
  readonly #attach: ExecutorOptions['attach']

  /** Innermost first. Step results and variables share one namespace. */
  #frames: Record<string, unknown>[] = [{}]
  #depth = 0
  #parentId: string | undefined

  constructor(options: ExecutorOptions) {
    this.#registry = options.registry
    this.#test = options.test
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#attach = options.attach
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
    const providers = new Map<string, (key: string) => unknown>()
    for (const [, { def }] of this.#registry.valueProviders) {
      providers.set(def.prefix, (key) => def.resolve(key))
    }
    return { frames: this.#frames, providers }
  }

  async runSteps(steps: StepDef[], options: RunStepsOptions = {}): Promise<StepRecord[]> {
    this.#frames.unshift({ ...(options.vars ?? {}) })
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
      this.#frames.shift()
    }
  }

  async #runStep(step: StepDef): Promise<StepRecord> {
    const entry = this.#registry.stepTypes.get(step.type)
    const started = Date.now()
    const base = {
      test: this.#test,
      stepId: step.id,
      stepType: step.type,
      parentId: this.#parentId,
      depth: this.#depth
    } as const

    if (!entry) {
      const known = [...this.#registry.stepTypes.keys()].sort().join(', ') || '(none)'
      return this.#fail(base, started, 'error', `unknown step type '${step.type}'; loaded plugins provide: ${known}`)
    }

    this.#registry.events.emit({ type: 'step.started', ...base })
    await this.#registry.runHooks('step:before', { test: this.#test, step })

    const timeoutMs = readTimeout(step.timeout) ?? entry.def.timeoutMs ?? this.#defaultTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`step timed out after ${timeoutMs}ms`)), timeoutMs)

    const previousParent = this.#parentId
    this.#parentId = step.id ?? previousParent

    let record: StepRecord
    try {
      const input = this.#prepareInput(step)
      const ctx = this.#execContext(controller.signal, entry.owner)
      const result = await withTimeout(entry.def.execute(ctx, input), controller.signal)
      const bound = (result ?? {}) as StepResult

      if (step.id) this.#frames[0]![step.id] = bound

      record = {
        id: step.id,
        type: step.type,
        status: 'passed',
        result: bound,
        durationMs: Date.now() - started
      }
      this.#registry.events.emit({ type: 'step.finished', ...base, status: 'passed', durationMs: record.durationMs })
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
        durationMs: Date.now() - started
      }
      this.#registry.events.emit({
        type: 'step.finished', ...base, status: 'error', durationMs: record.durationMs, message
      })
    } finally {
      clearTimeout(timer)
      this.#parentId = previousParent
    }

    await this.#registry.runHooks('step:after', { test: this.#test, step, record })
    return record
  }

  /**
   * Inputs are resolved against the current scope — except nested `steps`,
   * which are handed to the plugin untouched. A loop's body must be resolved
   * once per iteration, in the child scope the loop itself creates.
   */
  #prepareInput(step: StepDef): Record<string, unknown> {
    const scope = this.scope()
    const input: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(step)) {
      if (RESERVED_INPUT.has(key)) continue
      input[key] = key === 'steps' ? value : resolveDeep(scope, value)
    }
    return input
  }

  #execContext(signal: AbortSignal, owner: string): ExecContext {
    const self = this
    return {
      resolve: <T>(template: string) => resolveString(self.scope(), template) as T,
      resolveDeep: <T>(value: T) => resolveDeep(self.scope(), value),
      runSteps: (steps, options) => self.runSteps(steps, options),
      resource: <T>(name: string) =>
        self.#registry.resources.acquire(name, (p) => self.#registry.configFor(p)) as Promise<T>,
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
    base: { test: string; stepId?: string; stepType: string; parentId?: string; depth: number },
    started: number,
    status: StepStatus,
    message: string
  ): StepRecord {
    const durationMs = Date.now() - started
    this.#registry.events.emit({ type: 'step.finished', ...base, status, durationMs, message })
    return { id: base.stepId, type: base.stepType, status, result: {}, message, durationMs }
  }
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
