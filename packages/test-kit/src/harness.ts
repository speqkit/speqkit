import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  AssertOutcome, AssertionDef, Diagnostic, DiscoverQuery, Host, PluginSpec,
  RunEvent, RunOutcome, StepDef, StepRecord, TestDef
} from '@speqkit/plugin-api'
import {
  Executor, Registry, type ResourceFrame, createHost, resolveDeep, resolveDeepAsync, resolveString,
  runTests, validateTests
} from 'speqkit'

/**
 * A plugin under test, running inside the real kernel.
 *
 * The kit deliberately contains no fakes. A mock `ExecContext` would be a
 * second implementation of `@speqkit/plugin-api`, written by us, and the only
 * thing it could ever prove is that a plugin agrees with our mock. What an
 * author needs to know is that the plugin works inside speq — so the kit
 * assembles the actual `Registry`, the actual `Executor`, the actual runner,
 * and adds only the two things a plugin cannot get from them directly: a
 * project root on disk, and a scope stack held open between calls.
 *
 * That is also why `speqkit` is a peer dependency here and not a bundled one.
 * The kit tests a plugin against the kernel the author intends to support,
 * and there is exactly one kernel in the tree.
 */

export interface HarnessOptions {
  /**
   * Other plugins to load alongside the one under test.
   *
   * A plugin that contributes into a surface — a command into `cli`, a step
   * type used by `loop` — needs that surface present to contribute anything
   * at all, because `ctx.inject` is silent when the service is missing.
   */
  with?: PluginSpec[]
  /**
   * The plugin's block in speq.yaml, keyed by short name: `@speqkit/plugin-http`
   * and `speqkit-plugin-http` both read `config.http`.
   */
  config?: Record<string, unknown>
  /** The project root. A temporary directory is made, and removed, when omitted. */
  root?: string
  /**
   * Write attachments under the root instead of keeping the bytes in memory.
   *
   * Off by default: a plugin that attaches a screenshot is usually asserting
   * on the bytes, and touching the disk to do it is a slower test with more
   * ways to fail.
   */
  artifacts?: boolean
}

export interface Attachment {
  name: string
  contentType: string
  body: string | Uint8Array
}

export interface StepOutcome extends StepRecord {
  /** What the step attached while it ran. Empty for most step types. */
  artifacts: Attachment[]
}

export interface AssertInput {
  /**
   * The result a bare assertion applies to, as `ctx.last`.
   *
   * Defaults to the last step this harness ran, which is what makes
   * `await kit.step(...)` then `await kit.assert(...)` read the way a test
   * file does.
   */
  last?: Record<string, unknown>
}

export class Harness {
  readonly registry: Registry
  readonly host: Host
  readonly root: string
  /** Every event the run emitted, in order. */
  readonly events: RunEvent[] = []

  readonly #temporary: boolean
  readonly #artifactDir: string | undefined
  readonly #attached: Attachment[] = []
  #executor: Executor | undefined
  #last: Record<string, unknown> | undefined
  /** The run/suite/test chain, opened on first use. Innermost last. */
  #open: ResourceFrame[] = []
  #closed = false

  /** @internal — use `harness()`. */
  constructor(registry: Registry, root: string, temporary: boolean, artifacts: boolean) {
    this.registry = registry
    this.root = root
    this.#temporary = temporary
    this.#artifactDir = artifacts ? join(root, 'reports') : undefined
    this.host = createHost(registry, { root })
  }

  /**
   * Run one step and report what came back.
   *
   * A step is never re-run in isolation: results bind by `id` into a scope
   * this harness keeps open, so a second call can say `${first.field}` exactly
   * as a test file would.
   */
  async step(step: StepDef, vars?: Record<string, unknown>): Promise<StepOutcome> {
    const before = this.#attached.length
    const [record] = await this.steps([step], vars)
    return { ...record!, artifacts: this.#attached.slice(before) }
  }

  /** Run several steps in the harness scope, stopping at the first failure. */
  async steps(steps: StepDef[], vars?: Record<string, unknown>): Promise<StepRecord[]> {
    this.#ensureOpen()
    const records = await this.#exec().runSteps(steps, vars ? { vars } : {})
    // What a bare assertion applies to, on the runner's definition: the last
    // step that produced a result, whether or not it was given an `id`.
    this.#last = [...records].reverse().find((r) => r.status === 'passed')?.result ?? this.#last
    return records
  }

  /**
   * Evaluate one assertion against what the steps have produced so far.
   *
   * The input goes through the same `${...}` resolution the runner applies,
   * so an assertion written the way it appears in a test file is the one that
   * gets evaluated.
   */
  async assert(assertion: AssertionDef, input: AssertInput = {}): Promise<AssertOutcome & { type: string }> {
    this.#ensureOpen()
    const entry = this.registry.assertions.get(assertion.type)
    if (!entry) {
      const known = [...this.registry.assertions.keys()].sort().join(', ') || '(none)'
      throw new Error(`unknown assertion '${assertion.type}'; loaded plugins provide: ${known}`)
    }
    const exec = this.#exec()
    const scope = exec.scope()
    const results = exec.results()
    const ctx = {
      results,
      last: input.last ?? this.#last,
      resolve: <T>(t: string) => resolveString(scope, t) as T,
      resolveDeep: <T>(v: T) => resolveDeep(scope, v),
      resource: <T>(name: string) => this.#frame().acquire(name, (p) => this.registry.configFor(p)) as Promise<T>
    }
    const resolved = (await resolveDeepAsync(scope, { ...assertion })) as Record<string, unknown>
    const outcome = await entry.def.evaluate(ctx, resolved)
    return { type: assertion.type, ...outcome }
  }

  /** Acquire a resource, in a scope stack this harness holds open for you. */
  async resource<T = unknown>(name: string): Promise<T> {
    this.#ensureOpen()
    return this.#frame().acquire(name, (p) => this.registry.configFor(p)) as Promise<T>
  }

  /**
   * Close and reopen the `test` scope, so teardown of a test-scoped resource
   * can be observed without running a whole test.
   */
  async endTest(): Promise<void> {
    if (this.#open.length === 0) return
    await this.#frame().close((p) => this.registry.configFor(p))
    this.#open[this.#open.length - 1] = this.#open.at(-2)!.open('test')
    // A fresh executor: the bindings belonged to the test that just ended.
    this.#executor = undefined
    this.#last = undefined
  }

  /**
   * Run whole tests through the runner — suites, hooks, assertions, reporters.
   *
   * This opens its own scopes, the way a real run does, so a resource
   * acquired through `resource()` above is not the one a test here sees.
   */
  async run(tests: TestDef[], reporters: readonly string[] = []): Promise<RunOutcome> {
    return runTests(this.registry, tests, {
      artifactDir: this.#artifactDir,
      reporters
    })
  }

  /** Check tests against the grammar the loaded plugins define. */
  validate(tests: TestDef[]): Diagnostic[] {
    return validateTests(this.registry, tests)
  }

  /** Ask the loaded loaders what tests exist under the root. */
  discover(query?: DiscoverQuery): Promise<TestDef[]> {
    return this.host.discover(query)
  }

  /** Write a fixture under the root — a suite file, a config, a payload. */
  file(path: string, content: string): string {
    const target = resolve(this.root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    return target
  }

  /** Events of one type, for asserting on what a plugin emitted. */
  eventsOf<T extends RunEvent['type']>(type: T): Extract<RunEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<RunEvent, { type: T }>[]
  }

  /** Tear down every open scope and remove the temporary root. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const configFor = (p: string) => this.registry.configFor(p)
    for (const frame of [...this.#open].reverse()) {
      await frame.close(configFor)
    }
    this.#open = []
    if (this.#temporary) rmSync(this.root, { recursive: true, force: true })
  }

  #exec(): Executor {
    this.#executor ??= new Executor({
      registry: this.registry,
      test: '(harness)',
      suite: '(harness)',
      resources: this.#frame(),
      attach: (name, body, contentType) => {
        this.#attached.push({ name, body, contentType })
      }
    })
    return this.#executor
  }

  /**
   * Scopes are opened on first use rather than at construction, so a harness
   * used only for `run()` leaves the resource manager exactly as the runner
   * expects to find it.
   */
  #ensureOpen(): void {
    if (this.#closed) throw new Error('this harness is closed')
    if (this.#open.length > 0) return
    this.#open.push(this.registry.resources.open('run'))
    this.#open.push(this.#open[0]!.open('suite'))
    this.#open.push(this.#open[1]!.open('test'))
  }

  /** The innermost frame — the `test` one, which is where a step runs. */
  #frame(): ResourceFrame {
    this.#ensureOpen()
    return this.#open.at(-1)!
  }
}

export async function harness(plugin: PluginSpec, options: HarnessOptions = {}): Promise<Harness> {
  const temporary = !options.root
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'speq-kit-'))
  const registry = new Registry()

  registry.setConfig(options.config ?? {})
  const kit = new Harness(registry, root, temporary, options.artifacts ?? false)
  registry.setHost(kit.host)
  registry.events.subscribe((event) => kit.events.push(event))

  // The plugin under test goes first: if it and a peer both claim a step
  // type, the error should name the peer as the newcomer.
  for (const spec of [plugin, ...(options.with ?? [])]) await registry.register(spec)
  registry.settle()

  return kit
}
