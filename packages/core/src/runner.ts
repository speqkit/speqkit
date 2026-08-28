import { randomUUID } from 'node:crypto'
import type { TestDef, StepStatus, StepRecord, AssertContext, AssertOutcome } from '@speq/plugin-api'
import type { Registry } from './registry.js'
import { Executor } from './executor.js'
import { ArtifactStore, type ArtifactRecord } from './artifacts.js'
import { resolveDeep, resolveString } from './interpolate.js'

export interface TestOutcome {
  name: string
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

export interface RunOptions {
  /**
   * Where attached artifacts are written, one subdirectory per run. Without
   * it nothing touches the disk and bodies stay in memory — which is what a
   * library caller or a unit test wants.
   */
  artifactDir?: string
  runId?: string
}

export async function runTests(
  registry: Registry,
  tests: TestDef[],
  options: RunOptions = {}
): Promise<RunOutcome> {
  const runId = options.runId ?? randomUUID()
  const startedAt = Date.now()
  const configFor = (plugin: string) => registry.configFor(plugin)
  const artifacts = new ArtifactStore(options.artifactDir, runId)

  registry.events.emit({ type: 'run.started', runId, tests: tests.length, at: startedAt })
  await registry.runHooks('run:before', {})

  registry.resources.open('run')
  const outcomes: TestOutcome[] = []

  try {
    // Suites are the middle scope, and they are real: a resource declared
    // `suite` is set up once for the group and torn down when it ends. The
    // grouping is by source file and consecutive, so nothing is reordered.
    for (const group of groupIntoSuites(tests)) {
      registry.events.emit({ type: 'suite.started', suite: group.suite })
      await registry.runHooks('suite:before', { suite: group.suite })
      registry.resources.open('suite')
      try {
        for (const test of group.tests) {
          outcomes.push(await runOne(registry, test, group.suite, artifacts))
        }
      } finally {
        await registry.resources.close('suite', configFor)
      }
      await registry.runHooks('suite:after', { suite: group.suite })
      registry.events.emit({ type: 'suite.finished', suite: group.suite })
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

  return { runId, status, durationMs, tests: outcomes, artifacts: artifacts.all(), ...counts }
}

interface SuiteGroup {
  suite: string
  tests: TestDef[]
}

function groupIntoSuites(tests: TestDef[]): SuiteGroup[] {
  const groups: SuiteGroup[] = []
  for (const test of tests) {
    const suite = test.source ?? '(inline)'
    const current = groups.at(-1)
    if (current?.suite === suite) current.tests.push(test)
    else groups.push({ suite, tests: [test] })
  }
  return groups
}

async function runOne(
  registry: Registry,
  test: TestDef,
  suite: string,
  artifacts: ArtifactStore
): Promise<TestOutcome> {
  const startedAt = Date.now()
  const configFor = (plugin: string) => registry.configFor(plugin)

  registry.events.emit({ type: 'test.started', test: test.name, source: test.source })
  await registry.runHooks('test:before', { test: test.name })

  const executor = new Executor({
    registry,
    test: test.name,
    attach: (name, body, contentType) => {
      const record = artifacts.put(test.name, name, body, contentType)
      registry.events.emit({
        type: 'artifact.attached',
        test: test.name,
        name,
        contentType,
        bytes: record.bytes,
        path: record.path
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

  return {
    name: test.name,
    source: test.source,
    suite,
    status,
    durationMs,
    steps,
    assertions,
    artifacts: artifacts.forTest(test.name)
  }
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
