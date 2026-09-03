import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  definePlugin,
  type CommandHost, type StepDef, type StepRecord, type ValidationProblem
} from '@speqkit/plugin-api'

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
  docs: {
    summary: 'composition — calling a shared block, a module action or a fixture declared somewhere else',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-use#readme',
    examples: [
      {
        title: 'the three forms, which differ only in what they hand back',
        summary:
          'A block publishes its steps by id; an action hands back its `returns`; ' +
          'a fixture hands back the object it built. `speq modules` lists what this project has.',
        for: ['use'],
        code: [
          'steps:',
          '  - id: setup',
          '    type: use',
          '    ref: register-tenant          # shared/register-tenant.yaml',
          '',
          '  - id: category',
          '    type: use',
          '    action: menu.createCategory   # modules/menu.yaml, action createCategory',
          '    properties:',
          '      accessToken: ${setup.token}',
          '      name: starters',
          '',
          '  - id: item',
          '    type: use',
          '    fixture: menu-item            # fixtures/menu-item.yaml',
          '    overrides:',
          '      name: speq-item'
        ].join('\n')
      },
      {
        title: 'a module action, as it is declared',
        summary: 'What `properties` an action takes is checked by `speq validate`, before anything runs.',
        for: ['use'],
        code: [
          '# modules/menu.yaml',
          'actions:',
          '  createCategory:',
          '    properties: [accessToken, name]',
          '    steps:',
          '      - id: created',
          '        type: http',
          '        method: POST',
          '        url: ${base}/categories',
          '        headers:',
          '          authorization: Bearer ${accessToken}',
          '        json:',
          '          name: ${name}',
          '    returns:',
          '      id: ${created.body.id}'
        ].join('\n')
      }
    ]
  },
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
      summary: "internal: reads a block's `returns` in the scope the block ran in",
      schema: { type: 'object', properties: { values: {} }, additionalProperties: false },
      execute: (_exec, input) => (input.values ?? {}) as Record<string, unknown>
    })

    ctx.defineStepType('use', {
      summary: 'runs something declared elsewhere: a shared block, a module action, or a fixture',
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

    // Only if something publishes a command surface. Without one the plugin is
    // exactly as usable as before and simply has no command — which is what
    // `inject` is for.
    ctx.inject(['cli'], (services) => {
      defineModulesCommand(services.cli as CommandHost, root, dirs, read)
    })
  }
})

/* ------------------------------------------------------------------ */
/* speq modules                                                        */
/* ------------------------------------------------------------------ */

/**
 * The project's own library, read out of the project.
 *
 * `speq docs` answers what the *plugins* offer, and the answer is the same in
 * every project that installed them. This answers the other half, which is
 * different in every project and written down nowhere: which blocks, actions
 * and fixtures this team has already built, and what each one needs to be
 * called with.
 *
 * It exists because that was the most expensive thing to find out. A module
 * action is a file somebody wrote last quarter, and the only way to learn it
 * took either a `grep` or a colleague — so a test written by somebody new, and
 * a test written by a model, both reached for `http` and rebuilt a login that
 * already existed twice over.
 */
function defineModulesCommand(
  cli: CommandHost,
  root: string,
  dirs: { modules: string; shared: string; fixtures: string },
  read: (path: string) => unknown
): void {
  cli.register('modules', {
    summary: 'the blocks, actions and fixtures this project has, and how to call them',
    usage: 'speq modules [--json]',
    run(argv) {
      const library = readLibrary(root, dirs, read)
      if (argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(library, null, 2)}\n`)
        return 0
      }

      for (const group of library.groups) {
        process.stdout.write(`\n${group.dir}/  ${group.entries.length} ${group.label}\n`)
        if (group.entries.length === 0) {
          process.stdout.write(`  (nothing here yet)\n`)
          continue
        }
        for (const entry of group.entries) {
          process.stdout.write(`  ${entry.call.padEnd(36)} ${entry.takes.join(', ')}\n`)
          process.stdout.write(`    ${entry.use.split('\n').join('\n    ')}\n`)
        }
      }

      const total = library.groups.reduce((n, g) => n + g.entries.length, 0)
      process.stdout.write(
        total === 0
          ? `\nNothing declared yet. A block is a file of steps under ${dirs.shared}/.\n`
          : `\n${total} thing(s) this project already has. Reach any of them with a 'use' step.\n`
      )
      return 0
    }
  })
}

interface LibraryEntry {
  /** How it is addressed: `menu.createCategory`, or the block's own name. */
  call: string
  file: string
  /** The properties an action declares, or the keys a fixture builds. */
  takes: string[]
  /** A `use` step, ready to paste. */
  use: string
}

function readLibrary(
  root: string,
  dirs: { modules: string; shared: string; fixtures: string },
  read: (path: string) => unknown
): { groups: { dir: string; label: string; entries: LibraryEntry[] }[] } {
  const entries = (dir: string, of: (name: string, path: string) => LibraryEntry[]): LibraryEntry[] =>
    yamlFiles(join(root, dir))
      .flatMap((path) => {
        const name = relative(join(root, dir), path).replace(/\.ya?ml$/, '')
        try {
          return of(name, path)
        } catch {
          // A file that does not parse is the business of `speq validate`,
          // which says where and why. A catalogue that refuses to print
          // because one file is broken helps nobody.
          return []
        }
      })
      .sort((a, b) => a.call.localeCompare(b.call))

  return {
    groups: [
      {
        dir: dirs.modules,
        label: 'action(s)',
        entries: entries(dirs.modules, (name, path) => {
          const actions = (read(path) as Module).actions ?? {}
          return Object.entries(actions).map(([action, def]) => ({
            call: `${name}.${action}`,
            file: relative(root, path),
            takes: def.properties ?? [],
            use: useStep(
              `action: ${name}.${action}`,
              (def.properties ?? []).map((prop) => `  ${prop}: ...`)
            )
          }))
        })
      },
      {
        dir: dirs.shared,
        label: 'block(s)',
        entries: entries(dirs.shared, (name, path) => {
          const block = read(path) as Block
          if (!Array.isArray(block.steps)) return []
          // What a block hands back: its `returns`, or its steps by id.
          const gives = block.returns
            ? Object.keys(block.returns)
            : block.steps.map((step) => step.id).filter((id): id is string => typeof id === 'string')
          return [{
            call: name,
            file: relative(root, path),
            takes: gives.map((key) => `\u2192 ${key}`),
            use: useStep(`ref: ${name}`, [])
          }]
        })
      },
      {
        dir: dirs.fixtures,
        label: 'fixture(s)',
        entries: entries(dirs.fixtures, (name, path) => {
          const built = (read(path) as Fixture).fixture?.build
          if (!built) return []
          return [{
            call: name,
            file: relative(root, path),
            takes: Object.keys(built),
            use: useStep(`fixture: ${name}`, ['  # any key above, to override it'])
          }]
        })
      }
    ]
  }
}

const useStep = (form: string, properties: string[]): string =>
  ['- type: use', `  ${form}`, ...(properties.length ? ['  properties:', ...properties.map((p) => `  ${p}`)] : [])]
    .join('\n')

/** Every `.yaml` under a directory, nested ones included, sorted. */
function yamlFiles(dir: string): string[] {
  let found: string[]
  try {
    found = readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return yamlFiles(path)
        return entry.name.endsWith('.yaml') || entry.name.endsWith('.yml') ? [path] : []
      })
  } catch {
    // The directory is optional: a project using blocks and no fixtures is an
    // ordinary project, not a misconfigured one.
    return []
  }
  return found.sort()
}

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
