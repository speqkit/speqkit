import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { definePlugin, type StepDef, type StepRecord, type ValidationProblem } from '@speqkit/plugin-api'

/**
 * Composition: calling something declared somewhere else.
 *
 * It is the most used step of a real suite by a wide margin — in the corpus
 * this plugin was written against, `use` outnumbers the HTTP step it composes
 * — and it is one step type rather than three plugins because a shared block,
 * a module action and a fixture differ only in what they hand back. Splitting
 * them would mean explaining to a tester what an "action" is as opposed to a
 * "block", which is our filing system, not their problem.
 *
 * Nothing here needs the kernel to grow: nested steps go through
 * `ctx.runSteps`, and the child scope it opens is exactly what keeps an
 * action's internals from leaking into the test that called it.
 */

interface UseConfig {
  /** Where module files live, relative to the project root. */
  modulesDir?: string
  /** Where shared blocks live. */
  sharedDir?: string
  /** Where fixtures live. */
  fixturesDir?: string
}

interface Block {
  steps?: StepDef[]
  returns?: Record<string, unknown>
}

interface Action extends Block {
  properties?: string[]
}

interface Module {
  actions?: Record<string, Action>
}

interface Fixture {
  fixture?: { build?: Record<string, unknown>; schemaRef?: string }
}

/** The step the plugin appends to a block to read its `returns` out. */
const CAPTURE = 'use.capture'

export default definePlugin({
  name: '@speqkit/plugin-use',
  configSchema: {
    type: 'object',
    properties: {
      modulesDir: { type: 'string' },
      sharedDir: { type: 'string' },
      fixturesDir: { type: 'string' }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const root = ctx.host.root
    const config = ctx.config<UseConfig>()
    const dirs = {
      modules: config.modulesDir ?? 'modules',
      shared: config.sharedDir ?? 'shared',
      fixtures: config.fixturesDir ?? 'fixtures'
    }

    // Read once per run: a file cannot change under a suite that is already
    // executing, and a shared block pulled into fifty tests would otherwise be
    // parsed fifty times.
    const files = new Map<string, unknown>()
    const read = (path: string): unknown => {
      if (!files.has(path)) files.set(path, parseYaml(readFileSync(path, 'utf8')) ?? {})
      return files.get(path)
    }

    const locate = (spec: string, dir: string): string => {
      const named = spec.endsWith('.yaml') || spec.endsWith('.yml') ? spec : `${spec}.yaml`
      if (isAbsolute(named)) return named
      // Root-relative on purpose. A plugin is not told which file the step it
      // is running came from, so `../../../shared/x.yaml` could only ever be
      // resolved against the wrong directory — and the depth of a suite tree
      // is not something a shared block should have an opinion about.
      return named.includes('/') ? join(root, named) : join(root, dir, named)
    }

    /**
     * `use.capture` exists so that `returns` is resolved by the kernel in the
     * scope the block ran in, rather than by a second `${...}` implementation
     * living in this plugin and drifting from the first.
     */
    ctx.defineStepType(CAPTURE, {
      schema: { type: 'object', properties: { values: {} }, additionalProperties: false },
      execute: (_exec, input) => (input.values ?? {}) as Record<string, unknown>
    })

    ctx.defineStepType('use', {
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          action: { type: 'string' },
          fixture: { type: 'string' },
          properties: { type: 'object' },
          overrides: { type: 'object' }
        },
        additionalProperties: false
      },

      /**
       * Everything checkable without running anything: that exactly one of the
       * three forms was written, that the file is on disk, that the action
       * exists in the module and got the properties it declares. All of it
       * used to be found out mid-run, from a step that could not name the file
       * it was reading.
       */
      validate(step) {
        const problems: (string | ValidationProblem)[] = []
        const forms = (['ref', 'action', 'fixture'] as const).filter((k) => typeof step[k] === 'string')

        if (step.as !== undefined) {
          problems.push({
            path: 'as',
            message: "'as' is the v1 spelling",
            hint: "name a result with 'id', the way every other step does"
          })
        }
        if (forms.length === 0) return [...problems, "a 'use' step needs one of 'ref', 'action' or 'fixture'"]
        if (forms.length > 1) return [...problems, `'${forms.join("' and '")}' exclude each other`]

        if (typeof step.ref === 'string') {
          if (step.ref.startsWith('.')) {
            problems.push({
              path: 'ref',
              message: `'${step.ref}' is relative to the test file`,
              hint: `paths are relative to the project root, or bare inside ${dirs.shared}/`
            })
            return problems
          }
          const path = locate(step.ref, dirs.shared)
          if (!existsSync(path)) return [...problems, { path: 'ref', message: `no such block: ${path}` }]
          const block = read(path) as Block
          if (!Array.isArray(block.steps) || block.steps.length === 0) {
            problems.push({ path: 'ref', message: `${step.ref} has no steps` })
          }
          return problems
        }

        if (typeof step.fixture === 'string') {
          const path = locate(step.fixture, dirs.fixtures)
          if (!existsSync(path)) return [...problems, { path: 'fixture', message: `no such fixture: ${path}` }]
          const built = (read(path) as Fixture).fixture
          if (!built || typeof built.build !== 'object') {
            problems.push({ path: 'fixture', message: `${step.fixture} has no 'fixture.build' block` })
          }
          return problems
        }

        const [moduleName, actionName, ...rest] = String(step.action).split('.')
        if (!moduleName || !actionName || rest.length > 0) {
          return [...problems, { path: 'action', message: `'${String(step.action)}' is not '<module>.<action>'` }]
        }
        const path = locate(moduleName, dirs.modules)
        if (!existsSync(path)) return [...problems, { path: 'action', message: `no such module: ${path}` }]

        const actions = (read(path) as Module).actions ?? {}
        const action = actions[actionName]
        if (!action) {
          const known = Object.keys(actions).sort().join(', ') || '(none)'
          return [...problems, { path: 'action', message: `module '${moduleName}' has no action '${actionName}'; it has: ${known}` }]
        }
        const given = new Set(Object.keys((step.properties as Record<string, unknown>) ?? {}))
        for (const required of action.properties ?? []) {
          if (!given.has(required)) {
            problems.push({ path: 'properties', message: `action '${String(step.action)}' needs '${required}'` })
          }
        }
        return problems
      },

      async execute(exec, input) {
        if (typeof input.fixture === 'string') {
          const built = (read(locate(input.fixture, dirs.fixtures)) as Fixture).fixture?.build ?? {}
          // Top-level merge, and the override wins: a test that pins one field
          // to assert on it should not have to restate the other five.
          return exec.resolveDeep({ ...built, ...((input.overrides as Record<string, unknown>) ?? {}) })
        }

        if (typeof input.ref === 'string') {
          const block = read(locate(input.ref, dirs.shared)) as Block
          return runBlock(exec, block, {}, input.ref)
        }

        const [moduleName, actionName] = String(input.action).split('.')
        const action = ((read(locate(moduleName!, dirs.modules)) as Module).actions ?? {})[actionName!]!
        const properties = (input.properties as Record<string, unknown>) ?? {}
        return runBlock(exec, action, properties, String(input.action))
      }
    })
  }
})

/**
 * Runs a block's steps in a child scope and hands back what it publishes.
 *
 * A block with `returns` publishes exactly that. Without one, the caller gets
 * the block's steps by id — convenient for a shared setup that was written
 * before anyone thought about its interface, and the reason `returns` is worth
 * adding to one that outgrows it.
 */
async function runBlock(
  exec: ExecLike,
  block: Block,
  vars: Record<string, unknown>,
  label: string
): Promise<Record<string, unknown>> {
  const steps = (block.steps ?? []) as StepDef[]
  const returns = block.returns
  const body = returns ? [...steps, { id: CAPTURE, type: CAPTURE, values: returns }] : steps

  const records = await exec.runSteps(body, { vars, label })
  const broken = records.find((r) => r.status !== 'passed')
  if (broken) {
    // A step type has no way to report `failed`, so an inner failure surfaces
    // as this step erroring. The message carries the inner one, which is what
    // a reader needs; the distinction between "the system was wrong" and "we
    // could not ask" is lost at this boundary, and that is written down rather
    // than papered over.
    throw new Error(
      `${label}: step ${broken.id ? `'${broken.id}' ` : ''}(${broken.type}) ${broken.status}` +
        (broken.message ? ` — ${broken.message}` : '')
    )
  }

  if (returns) return (records.at(-1)?.result ?? {}) as Record<string, unknown>

  const published: Record<string, unknown> = {}
  for (const record of records) {
    if (record.id) published[record.id] = record.result
  }
  return published
}

/** The slice of `ExecContext` a block needs. Kept local so the plugin depends on no import of the kernel. */
interface ExecLike {
  runSteps(steps: StepDef[], options?: { vars?: Record<string, unknown>; label?: string }): Promise<StepRecord[]>
  resolveDeep<T>(value: T): T
}
