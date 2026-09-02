import { join } from 'node:path'
import type {
  Capabilities, Capability, DiscoverQuery, Diagnostic, Host, RecordedRun, RunEvent, RunOutcome,
  RunRequest, TestDef
} from '@speqkit/plugin-api'
import { PLUGIN_API_VERSION } from '@speqkit/plugin-api'
import type { Registry, Registered } from './registry.js'
import { discoverTests } from './tests.js'
import { validateTests } from './validate.js'
import { runTests } from './runner.js'
import { listRuns } from './run-log.js'
import { replayRun } from './reporters.js'

export interface HostSession {
  /** The directory holding speq.yaml. */
  root: string
  /** The environment layer applied on top of it, when one was asked for. */
  env?: string
}

/**
 * The kernel's own end of the `Host` contract.
 *
 * Everything here already existed as a free function taking a `Registry`.
 * What is new is that the registry no longer crosses the boundary: a plugin
 * gets verbs, not the kernel's internals, and so has nothing to import from
 * `speqkit`. That is the whole of the fix — the second copy of the
 * kernel in the store, and the second `bootstrap()` inside one process, were
 * both consequences of `plugin-cli` reaching for the implementation because
 * the contract offered it no way to reach for the running session instead.
 *
 * It stays a facade over the free functions rather than absorbing them: the
 * kernel is still usable as a library (see examples/basic), and a plugin and
 * a library caller should not be running different code.
 */
export function createHost(registry: Registry, session: HostSession): Host {
  const reportDir = join(session.root, 'reports')

  return {
    root: session.root,
    reportDir,
    env: session.env,

    discover(query: DiscoverQuery = {}): Promise<TestDef[]> {
      return discoverTests(registry, { root: session.root, ...query })
    },

    validate(tests: TestDef[]): Diagnostic[] {
      return validateTests(registry, tests)
    },

    capabilities(): Capabilities {
      return capabilitiesOf(registry)
    },

    run(tests: TestDef[], options: RunRequest = {}): Promise<RunOutcome> {
      // `artifactDir` is the host's to decide, not the caller's: a plugin that
      // could redirect where runs are written would break `speq report`, which
      // finds them by looking in exactly one place.
      return runTests(registry, tests, {
        artifactDir: reportDir,
        reporters: options.reporters ?? [],
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
      })
    },

    runs(): RecordedRun[] {
      return listRuns(reportDir)
    },

    async replay(run: RecordedRun, reporters: readonly string[]): Promise<readonly RunEvent[]> {
      const { events } = await replayRun(registry, run.dir, reporters, reportDir)
      return events
    }
  }
}

/**
 * Stands in until `bootstrap()` has attached a real one.
 *
 * A `Registry` built by hand — every kernel test does this — has no project
 * root and no config, so there is nothing a host could truthfully answer
 * with. Failing on use rather than on construction keeps `ctx.host` a stable
 * reference a plugin can capture during `setup()`, which is exactly what a
 * plugin registering commands does.
 */
export function detachedHost(): Host {
  const fail = (): never => {
    throw new Error(
      'this registry has no session: ctx.host is only available inside a kernel started by bootstrap()'
    )
  }
  return {
    get root(): string { return fail() },
    get reportDir(): string { return fail() },
    get env(): string | undefined { return fail() },
    discover: fail,
    validate: fail,
    capabilities: fail,
    run: fail,
    runs: fail,
    replay: fail
  }
}

/**
 * The registry, read as a grammar rather than as a lookup table.
 *
 * Nothing is derived here: every field is something a plugin already declared,
 * turned from a map keyed for execution into a list ordered for reading. The
 * only judgement in it is what to leave out — resources are not here, because
 * a resource is a name a *plugin* asks for and never a word anybody writes in
 * a suite, and this document answers the question "what may I write".
 */
function capabilitiesOf(registry: Registry): Capabilities {
  const named = <T>(map: Map<string, Registered<T>>): [string, Registered<T>][] =>
    [...map].sort(([a], [b]) => a.localeCompare(b))

  const basic = <T extends { schema?: Capability['schema'] }>(
    map: Map<string, Registered<T>>
  ): Capability[] =>
    named(map).map(([name, entry]) => ({ name, plugin: entry.owner, schema: entry.def.schema }))

  return {
    apiVersion: PLUGIN_API_VERSION,
    plugins: registry.loadedPlugins().map((name) => {
      const source = registry.sources.get(name)
      return { name, version: source?.version, origin: source?.origin }
    }),
    stepTypes: basic(registry.stepTypes),
    assertions: basic(registry.assertions),
    valueProviders: named(registry.valueProviders).map(([name, entry]) => ({
      name,
      plugin: entry.owner,
      prefix: entry.def.prefix
    })),
    reporters: named(registry.reporters).map(([name, entry]) => ({ name, plugin: entry.owner })),
    loaders: named(registry.loaders).map(([name, entry]) => ({
      name,
      plugin: entry.owner,
      extensions: entry.def.extensions,
      suiteFiles: entry.def.suiteFiles
    }))
  }
}
