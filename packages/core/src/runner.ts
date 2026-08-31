import { randomUUID } from 'node:crypto'
import type {
  TestDef, StepStatus, StepRecord, AssertContext, AssertOutcome, RunOutcome, TestOutcome
} from '@speqkit/plugin-api'
import type { Registry } from './registry.js'
import { Executor } from './executor.js'
import type { ResourceFrame } from './resources.js'
import { ArtifactStore, type ArtifactRecord } from './artifacts.js'
import { RunLog } from './run-log.js'
import { startReporters, runDirFor } from './reporters.js'
import { resolveDeep, resolveDeepAsync, resolveString } from './interpolate.js'
import { comparison } from './events.js'

export type { RunOutcome, TestOutcome }

export interface RunOptions {
  /**
   * Where attached artifacts are written, one subdirectory per run. Without
   * it nothing touches the disk and bodies stay in memory — which is what a
   * library caller or a unit test wants.
   */
  artifactDir?: string
  runId?: string
  /**
   * Reporters to drive, by the name their plugin registered. Empty means the
   * run produces no output of its own — which is what a library caller wants
   * and what `speq run` never does.
   */
  reporters?: readonly string[]
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

  // Started before the first event and before any test runs: an unknown
  // reporter name is a config mistake, and finding it after a twenty-minute
  // suite would be the worst possible moment.
  const reporters = await startReporters(registry, options.reporters ?? [], {
    runId,
    outputDir: options.artifactDir,
    runDir: runDirFor(options.artifactDir, runId)
  })

  // Subscribed separately from the reporters so the run is recorded whatever
  // they go on to do with it, including throwing.
  const log = new RunLog(options.artifactDir, runId)
  const stopLogging = registry.events.subscribe((event) => log.write(event))

  try {
    registry.events.emit({ type: 'run.started', runId, tests: tests.length, at: startedAt })
    await registry.runHooks('run:before', {})

    const runFrame = registry.resources.open('run')
    const outcomes: TestOutcome[] = []

    try {
      // Suites are the middle scope, and they are real: a resource declared
      // `suite` is set up once for the group and torn down when it ends. The
      // grouping is by source file and consecutive, so nothing is reordered.
      for (const group of groupIntoSuites(tests)) {
        registry.events.emit({ type: 'suite.started', suite: group.suite })
        await registry.runHooks('suite:before', { suite: group.suite })
        const suiteFrame = runFrame.open('suite')
        try {
          for (const test of group.tests) {
            outcomes.push(await runOne(registry, test, group.suite, artifacts, suiteFrame))
          }
        } finally {
          await suiteFrame.close(configFor)
        }
        await registry.runHooks('suite:after', { suite: group.suite })
        registry.events.emit({ type: 'suite.finished', suite: group.suite })
      }
    } finally {
      await runFrame.close(configFor)
    }

    const counts = tally(outcomes)
    const status: StepStatus =
      counts.errored > 0 ? 'error' : counts.failed > 0 ? 'failed' : 'passed'
    const durationMs = Date.now() - startedAt

    await registry.runHooks('run:after', {})
    registry.events.emit({ type: 'run.finished', runId, status, durationMs, ...counts })

    return { runId, status, durationMs, tests: outcomes, artifacts: artifacts.all(), ...counts }
  } finally {
    // Unconditional. A run that throws during teardown would otherwise leave a
    // live subscription behind, and a long-lived host — an editor, a TUI —
    // collects one per run until it is writing to closed file descriptors.
    await reporters.finalize()
    stopLogging()
    log.close()
  }
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
  artifacts: ArtifactStore,
  suiteFrame: ResourceFrame
): Promise<TestOutcome> {
  const startedAt = Date.now()
  const configFor = (plugin: string) => registry.configFor(plugin)

  const meta = test.meta && Object.keys(test.meta).length > 0 ? test.meta : undefined

  // A pending test is announced and not run. It is still discovered, still
  // counted and still validated — what it records is a gap the suite knows
  // about, and a gap nobody is reminded of is a gap that has been deleted.
  if (test.pending) {
    registry.events.emit({
      type: 'test.started',
      test: test.name,
      source: test.source,
      ...(test.title ? { title: test.title } : {}),
      ...(meta ? { meta } : {})
    })
    registry.events.emit({ type: 'test.skipped', test: test.name, reason: test.pending })
    registry.events.emit({ type: 'test.finished', test: test.name, status: 'skipped', durationMs: 0 })
    return {
      name: test.name,
      ...(test.title ? { title: test.title } : {}),
      pending: test.pending,
      ...(meta ? { meta } : {}),
      source: test.source,
      suite,
      status: 'skipped',
      durationMs: 0,
      steps: [],
      assertions: [],
      artifacts: []
    }
  }

  registry.events.emit({
    type: 'test.started',
    test: test.name,
    source: test.source,
    ...(test.title ? { title: test.title } : {}),
    ...(meta ? { meta } : {})
  })
  await registry.runHooks('test:before', { test: test.name, suite })

  const testFrame = suiteFrame.open('test')
  const executor = new Executor({
    registry,
    test: test.name,
    suite,
    resources: testFrame,
    ...(meta ? { meta } : {}),
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

  let setup: StepRecord[] = []
  let body: StepRecord[] = []
  let cleanup: StepRecord[] = []
  let ungiven: string | undefined
  const assertions: (AssertOutcome & { type: string })[] = []

  try {
    // The givens come first: they are what the rest of the test is written in
    // terms of. A test whose variables do not resolve has not begun, so
    // neither setup nor cleanup runs — there is nothing yet to take down.
    if (test.variables && Object.keys(test.variables).length > 0) {
      try {
        await executor.defineVariables(test.variables)
      } catch (err) {
        ungiven = err instanceof Error ? err.message : String(err)
        registry.events.emit({
          type: 'diagnostic',
          level: 'error',
          source: test.name,
          message: `${ungiven.replace(/\.$/, '')}. The test did not run.`
        })
      }
    }

    // Setup runs in the test's own frame, not a nested one, so what it binds
    // is addressable from the body, the assertions and the cleanup alike.
    setup = !ungiven && test.setup?.length ? await executor.runPhase(test.setup, 'setup') : []
    const setupBroke = ungiven !== undefined || setup.some((s) => s.status !== 'passed')
    if (setupBroke && !ungiven) {
      registry.events.emit({
        type: 'diagnostic',
        level: 'warn',
        source: test.name,
        message: `setup did not complete: ${setup.find((s) => s.message)?.message ?? 'no detail'}. The test did not run.`
      })
    }

    body = setupBroke ? [] : await executor.runSteps(test.steps)

    // Assertions run only if every step produced a result to assert over.
    // Asserting after an errored step reports noise, not evidence.
    if (!setupBroke && !body.some((s) => s.status === 'error')) {
      const ctx = assertContext(registry, executor, body, testFrame)
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
        const { meta: _annotations, ...written } = assertion
        const input = (await resolveDeepAsync(executor.scope(), written)) as Record<string, unknown>
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
          message: last.message,
          ...comparison(last)
        })
      }
    }
  } finally {
    // Whatever happened above, including a setup that never finished: the rows
    // a half-built test created are exactly the ones nobody else will delete.
    cleanup = !ungiven && test.cleanup?.length ? await executor.runPhase(test.cleanup, 'cleanup') : []
    await testFrame.close(configFor)
  }

  const ran = [...setup, ...body]
  let status: StepStatus = ungiven || ran.some((s) => s.status === 'error') || setup.some((s) => s.status !== 'passed')
    ? 'error'
    : assertions.some((a) => !a.passed) || ran.some((s) => s.status === 'failed')
      ? 'failed'
      : 'passed'

  // A test that answered its question and then failed to put the world back is
  // not a passing test: the next run inherits whatever it left behind. It does
  // not overwrite a verdict already given, because that verdict is the news.
  const dirty = cleanup.find((s) => s.status !== 'passed')
  if (dirty) {
    registry.events.emit({
      type: 'diagnostic',
      level: 'warn',
      source: test.name,
      message: `cleanup did not complete: ${dirty.message ?? 'no detail'}. The environment may be left dirty.`
    })
    if (status === 'passed') status = 'error'
  }

  const steps = [...setup, ...body, ...cleanup]

  const durationMs = Date.now() - startedAt
  await registry.runHooks('test:after', { test: test.name, suite })
  registry.events.emit({ type: 'test.finished', test: test.name, status, durationMs })

  return {
    name: test.name,
    ...(test.title ? { title: test.title } : {}),
    ...(meta ? { meta } : {}),
    source: test.source,
    suite,
    status,
    durationMs,
    steps,
    assertions,
    artifacts: artifacts.forTest(test.name)
  }
}

function assertContext(
  registry: Registry,
  executor: Executor,
  steps: StepRecord[],
  frame: ResourceFrame
): AssertContext {
  const results = executor.results()
  const last = [...steps].reverse().find((s) => s.status === 'passed')?.result
  return {
    results,
    last,
    resolve: <T>(t: string) => resolveString(executor.scope(), t) as T,
    resolveDeep: <T>(v: T) => resolveDeep(executor.scope(), v),
    resource: <T>(name: string) => frame.acquire(name, (p) => registry.configFor(p)) as Promise<T>
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
