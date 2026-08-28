import { randomUUID } from 'node:crypto'
import type { TestDef, StepStatus, StepRecord, AssertContext, AssertOutcome } from '@speq/plugin-api'
import type { Registry } from './registry.js'
import { Executor } from './executor.js'
import { resolveDeep, resolveString } from './interpolate.js'

export interface TestOutcome {
  name: string
  source?: string
  status: StepStatus
  durationMs: number
  steps: StepRecord[]
  assertions: (AssertOutcome & { type: string })[]
}

export interface RunOutcome {
  runId: string
  status: StepStatus
  durationMs: number
  tests: TestOutcome[]
  passed: number
  failed: number
  errored: number
  skipped: number
}

export async function runTests(registry: Registry, tests: TestDef[]): Promise<RunOutcome> {
  const runId = randomUUID()
  const startedAt = Date.now()
  const configFor = (plugin: string) => registry.configFor(plugin)

  registry.events.emit({ type: 'run.started', runId, tests: tests.length, at: startedAt })
  await registry.runHooks('run:before', {})

  registry.resources.open('run')
  const outcomes: TestOutcome[] = []

  try {
    for (const test of tests) {
      outcomes.push(await runOne(registry, test))
    }
  } finally {
    await registry.resources.close('run', configFor)
  }

  const counts = tally(outcomes)
  const status: StepStatus =
    counts.errored > 0 ? 'error' : counts.failed > 0 ? 'failed' : 'passed'
  const durationMs = Date.now() - startedAt

  await registry.runHooks('run:after', {})
  registry.events.emit({ type: 'run.finished', runId, status, durationMs, ...counts })

  return { runId, status, durationMs, tests: outcomes, ...counts }
}

async function runOne(registry: Registry, test: TestDef): Promise<TestOutcome> {
  const startedAt = Date.now()
  const configFor = (plugin: string) => registry.configFor(plugin)

  registry.events.emit({ type: 'test.started', test: test.name, source: test.source })
  await registry.runHooks('test:before', { test: test.name })

  const executor = new Executor({
    registry,
    test: test.name,
    attach: (name, body, contentType) => {
      registry.events.emit({
        type: 'artifact.attached',
        test: test.name,
        name,
        contentType,
        bytes: typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
      })
    }
  })

  registry.resources.open('test')
  let steps: StepRecord[] = []
  const assertions: (AssertOutcome & { type: string })[] = []

  try {
    steps = await executor.runSteps(test.steps)

    // Assertions run only if every step produced a result to assert over.
    // Asserting after an errored step reports noise, not evidence.
    if (!steps.some((s) => s.status === 'error')) {
      const ctx = assertContext(registry, executor, steps)
      for (const assertion of test.assert ?? []) {
        const entry = registry.assertions.get(assertion.type)
        if (!entry) {
          assertions.push({
            type: assertion.type,
            passed: false,
            message: `unknown assertion '${assertion.type}'`
          })
          continue
        }
        const input = resolveDeep(executor.scope(), { ...assertion }) as Record<string, unknown>
        try {
          const outcome = await entry.def.evaluate(ctx, input)
          assertions.push({ type: assertion.type, ...outcome })
        } catch (err) {
          assertions.push({
            type: assertion.type,
            passed: false,
            message: `assertion threw: ${err instanceof Error ? err.message : String(err)}`
          })
        }
        const last = assertions.at(-1)!
        registry.events.emit({
          type: 'assertion.evaluated',
          test: test.name,
          assertionType: assertion.type,
          passed: last.passed,
          message: last.message
        })
      }
    }
  } finally {
    await registry.resources.close('test', configFor)
  }

  const status: StepStatus = steps.some((s) => s.status === 'error')
    ? 'error'
    : assertions.some((a) => !a.passed) || steps.some((s) => s.status === 'failed')
      ? 'failed'
      : 'passed'

  const durationMs = Date.now() - startedAt
  await registry.runHooks('test:after', { test: test.name })
  registry.events.emit({ type: 'test.finished', test: test.name, status, durationMs })

  return { name: test.name, source: test.source, status, durationMs, steps, assertions }
}

function assertContext(registry: Registry, executor: Executor, steps: StepRecord[]): AssertContext {
  const results = executor.results()
  const last = [...steps].reverse().find((s) => s.status === 'passed')?.result
  return {
    results,
    last,
    resolve: <T>(t: string) => resolveString(executor.scope(), t) as T,
    resolveDeep: <T>(v: T) => resolveDeep(executor.scope(), v),
    resource: <T>(name: string) =>
      registry.resources.acquire(name, (p) => registry.configFor(p)) as Promise<T>
  }
}

function tally(outcomes: TestOutcome[]) {
  return {
    passed: outcomes.filter((o) => o.status === 'passed').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    errored: outcomes.filter((o) => o.status === 'error').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length
  }
}
