import { randomUUID } from 'node:crypto'
import type {
  TestDef, SuiteDef, StepStatus, StepRecord, AssertContext, AssertOutcome, RunOutcome, TestOutcome
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
  /**
   * How many suites may be in flight at once. One by default, and one is not
   * a placeholder for a better default arriving later.
   *
   * Every framework surveyed defaults to the CPU count, because their
   * bottleneck is the local processor. Ours is somebody else's service. Eight
   * workers is eight times the load on the system under test, and step
   * timeouts start firing where they did not fire in sequence — so a default
   * above one would let the machine decide verdicts. Whoever knows what the
   * system under test can take asks for the number.
   */
  concurrency?: number
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

    // Written at the test's own discovery position rather than pushed, so the
    // report reads the same however the run was scheduled. The event log stays
    // chronological — it is a log of what happened — and the report is not the
    // event log.
    const outcomes: TestOutcome[] = new Array<TestOutcome>(tests.length)

    // A file is the unit that runs, and the suites a file is inside are the
    // tree above it. The grouping is by source file and consecutive, so
    // nothing is reordered, and a project that declares no suites at all gets
    // exactly the tree it had before: one node per file, hanging off the run.
    const groups = groupIntoSuites(tests)
    const tree = new SuiteTree(registry, runFrame, configFor, artifacts)
    for (const group of groups) group.node = tree.leafFor(group)
    const failures: unknown[] = []

    async function runSuite(group: SuiteGroup): Promise<void> {
      const node = group.node!
      try {
        const blocked = await tree.open(node)
        for (const [i, test] of group.tests.entries()) {
          // A parked test is parked whatever happened above it. Reporting it
          // as blocked would turn "we know this one does not run yet" into
          // "something broke", which is the opposite of the news.
          outcomes[group.at + i] = blocked !== undefined && test.pending === undefined
            ? blockedOutcome(registry, test, node.id, blocked)
            : await runOne(registry, test, node.id, artifacts, node.frame!)
        }
      } finally {
        await tree.release(node)
      }
    }

    try {
      // One shared cursor and N workers pulling from it, which is what makes a
      // failure free a slot instead of stopping the run: whoever finishes takes
      // the next suite, and a suite that ends badly ends just as fast.
      let next = 0
      const workers = Math.max(1, Math.min(Math.trunc(options.concurrency ?? 1), groups.length))
      await Promise.all(Array.from({ length: workers }, async () => {
        for (let i = next++; i < groups.length; i = next++) {
          try {
            await runSuite(groups[i]!)
          } catch (err) {
            // A suite should not be able to throw — every layer below catches
            // its own. If one does, the other workers are mid-suite with
            // resources open, and abandoning them is how a run leaves a
            // database full of half-written rows. Record it, drain the queue,
            // and raise it once everything has been taken down.
            failures.push(err)
            registry.events.emit({
              type: 'diagnostic',
              level: 'error',
              source: groups[i]!.suite,
              message: `suite did not complete: ${err instanceof Error ? err.message : String(err)}`
            })
          }
        }
      }))
    } finally {
      await runFrame.close(configFor)
    }

    if (failures[0] !== undefined) throw failures[0]

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
  /** Where this group's first test sits in the discovered order. */
  at: number
  /** The declared suites this file is inside, outermost first. */
  chain: readonly SuiteDef[]
  node?: SuiteNode
}

function groupIntoSuites(tests: TestDef[]): SuiteGroup[] {
  const groups: SuiteGroup[] = []
  for (const [at, test] of tests.entries()) {
    const suite = test.source ?? '(inline)'
    const current = groups.at(-1)
    if (current?.suite === suite) current.tests.push(test)
    else groups.push({ suite, tests: [test], at, chain: test.suites ?? [] })
  }
  return groups
}

type ConfigFor = (plugin: string) => Record<string, unknown>

interface SuiteNode {
  /** The directory a manifest declared, or the file, for a leaf. */
  id: string
  /** Absent on a leaf: a file declares nothing, it just holds tests. */
  def?: SuiteDef
  parent?: SuiteNode
  /** Files below this node that have not finished yet. */
  remaining: number
  frame?: ResourceFrame
  executor?: Executor
  /** Memoised, because two workers reach the same parent at the same moment. */
  opening?: Promise<string | undefined>
  /** This suite or one above it says why it is not running. */
  parked?: boolean
  closed?: boolean
}

/**
 * The suites above the files: opened before the first test below them, closed
 * after the last one, once each.
 *
 * A suite is a thing rather than a file path, and a thing has a lifetime. The
 * awkward part is that the lifetime does not line up with the schedule: the
 * files under one suite are handed to whichever worker is free, so a suite has
 * to open when the first of them starts and close when the last of them ends,
 * and neither of those is knowable from where the work is taken. So the node
 * counts what is left below it, and whoever brings the count to zero closes it.
 *
 * `open` is memoised on the node for the same reason `ResourceFrame` caches a
 * promise rather than a value: without it, two workers arriving at one parent
 * inside the same tick both find it unopened and both run its setup.
 */
class SuiteTree {
  readonly #registry: Registry
  readonly #root: ResourceFrame
  readonly #configFor: ConfigFor
  readonly #artifacts: ArtifactStore
  readonly #nodes = new Map<string, SuiteNode>()

  constructor(registry: Registry, root: ResourceFrame, configFor: ConfigFor, artifacts: ArtifactStore) {
    this.#registry = registry
    this.#root = root
    this.#configFor = configFor
    this.#artifacts = artifacts
  }

  /** The node one file runs in, creating the suites above it as needed. */
  leafFor(group: SuiteGroup): SuiteNode {
    let parent: SuiteNode | undefined
    for (const def of group.chain) parent = this.#node(def.name, def, parent)
    const leaf = this.#node(group.suite, undefined, parent)
    for (let node: SuiteNode | undefined = leaf; node; node = node.parent) node.remaining += 1
    return leaf
  }

  #node(id: string, def: SuiteDef | undefined, parent: SuiteNode | undefined): SuiteNode {
    const existing = this.#nodes.get(id)
    if (existing) return existing
    const node: SuiteNode = { id, remaining: 0, ...(def ? { def } : {}), ...(parent ? { parent } : {}) }
    this.#nodes.set(id, node)
    return node
  }

  /**
   * Open this node and everything above it.
   *
   * Answers with the reason no test below may run, when a suite's own setup
   * did not complete — the same verdict a test's failed setup gets, one level
   * up. A *parked* suite is not that: its tests inherited its `pending` and
   * report skipped, which is the news, and running setup for them would be
   * building a world nobody is going to look at.
   */
  open(node: SuiteNode): Promise<string | undefined> {
    node.opening ??= this.#open(node)
    return node.opening
  }

  async #open(node: SuiteNode): Promise<string | undefined> {
    const blockedAbove = node.parent ? await this.open(node.parent) : undefined
    const parentFrame = node.parent?.frame ?? this.#root

    node.parked = (node.parent?.parked ?? false) || node.def?.pending !== undefined
    node.frame = parentFrame.open('suite')
    this.#registry.events.emit({
      type: 'suite.started',
      suite: node.id,
      ...(node.parent ? { parent: node.parent.id } : {}),
      ...(node.def?.title ? { title: node.def.title } : {}),
      ...(node.def?.pending ? { pending: node.def.pending } : {})
    })

    if (blockedAbove !== undefined) return blockedAbove
    if (node.parked) return undefined

    await this.#registry.runHooks('suite:before', { suite: node.id })
    if (!node.def?.setup?.length) return undefined

    const records = await this.#executor(node).runPhase(node.def.setup, 'setup')
    const broke = records.find((r) => r.status !== 'passed')
    if (!broke) return undefined

    const reason = `setup did not complete: ${broke.message ?? 'no detail'}`
    this.#registry.events.emit({
      type: 'diagnostic',
      level: 'error',
      source: node.id,
      message: `suite ${reason}. No test in it ran.`
    })
    return reason
  }

  /**
   * One file below this node is done. Whoever empties a node closes it.
   *
   * Every ancestor is counted down, not just up to the first one still busy:
   * a leaf is one of the files under each of them, so finishing it settles a
   * debt at every level. Stopping at the first non-empty node left the ones
   * above it holding a count that could never reach zero, and a root suite
   * whose cleanup simply never ran.
   */
  async release(node: SuiteNode): Promise<void> {
    for (let current: SuiteNode | undefined = node; current; current = current.parent) {
      current.remaining -= 1
      if (current.remaining === 0) await this.#close(current)
    }
  }

  async #close(node: SuiteNode): Promise<void> {
    if (node.closed) return
    node.closed = true

    try {
      // Whatever happened below, including a setup that never finished: what a
      // half-built suite created is exactly what nobody else will delete.
      if (!node.parked && node.def?.cleanup?.length) {
        const records = await this.#executor(node).runPhase(node.def.cleanup, 'cleanup')
        const dirty = records.find((r) => r.status !== 'passed')
        if (dirty) {
          this.#registry.events.emit({
            type: 'diagnostic',
            level: 'warn',
            source: node.id,
            message: `suite cleanup did not complete: ${dirty.message ?? 'no detail'}. The environment may be left dirty.`
          })
        }
      }
    } finally {
      await node.frame?.close(this.#configFor)
    }

    if (!node.parked) await this.#registry.runHooks('suite:after', { suite: node.id })
    this.#registry.events.emit({ type: 'suite.finished', suite: node.id })
  }

  /**
   * One executor per suite, so `cleanup` reads what `setup` bound.
   *
   * Its scope is the suite's own and no test can see it. A test that could
   * read `${tenant.id}` from the suite above it would be a different test when
   * run alone, and running one test alone is how every failure gets looked at.
   * What crosses that line is a `suite`-scoped resource, which is declared.
   */
  #executor(node: SuiteNode): Executor {
    const meta = node.def?.meta && Object.keys(node.def.meta).length > 0 ? node.def.meta : undefined
    node.executor ??= new Executor({
      registry: this.#registry,
      suite: node.id,
      resources: node.frame!,
      ...(meta ? { meta } : {}),
      attach: (name, body, contentType) => {
        const record = this.#artifacts.put(node.id, name, body, contentType)
        this.#registry.events.emit({
          type: 'artifact.attached',
          suite: node.id,
          name,
          contentType,
          bytes: record.bytes,
          path: record.path
        })
      }
    })
    return node.executor
  }
}

/**
 * A test in a suite whose setup did not complete: announced, counted, and not
 * run.
 *
 * `error` rather than `skipped`, and said per test rather than once for the
 * suite: a report that shows twelve tests missing without a row for each of
 * them is a report somebody reads as "twelve tests passed last week and are
 * gone now".
 */
function blockedOutcome(
  registry: Registry,
  test: TestDef,
  suite: string,
  reason: string
): TestOutcome {
  const meta = test.meta && Object.keys(test.meta).length > 0 ? test.meta : undefined
  registry.events.emit({
    type: 'test.started',
    test: test.name,
    source: test.source,
    ...(test.group ? { group: test.group } : {}),
    ...(test.title ? { title: test.title } : {}),
    ...(meta ? { meta } : {})
  })
  registry.events.emit({
    type: 'diagnostic',
    level: 'error',
    source: test.name,
    message: `the suite's ${reason}. The test did not run.`
  })
  registry.events.emit({ type: 'test.finished', test: test.name, status: 'error', durationMs: 0 })

  return {
    name: test.name,
    ...(test.title ? { title: test.title } : {}),
    ...(test.group ? { group: test.group } : {}),
    ...(meta ? { meta } : {}),
    source: test.source,
    suite,
    status: 'error',
    durationMs: 0,
    steps: [],
    assertions: [],
    artifacts: []
  }
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
      ...(test.group ? { group: test.group } : {}),
      ...(test.title ? { title: test.title } : {}),
      ...(meta ? { meta } : {})
    })
    registry.events.emit({ type: 'test.skipped', test: test.name, reason: test.pending })
    registry.events.emit({ type: 'test.finished', test: test.name, status: 'skipped', durationMs: 0 })
    return {
      name: test.name,
      ...(test.title ? { title: test.title } : {}),
      ...(test.group ? { group: test.group } : {}),
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
    ...(test.group ? { group: test.group } : {}),
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
    ...(test.group ? { group: test.group } : {}),
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
