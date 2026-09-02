import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The versions the generated project asks npm for.
 *
 * Hard-coded rather than read from anywhere: this package is published on its
 * own and installed with `npm create`, so at the moment it runs there is no
 * workspace to look in. A test in this repository pins these against the real
 * package versions, so the list cannot quietly go stale.
 */
export const VERSIONS = {
  'speqkit': '^0.3.0',
  '@speqkit/plugin-api': '^0.10.0',
  '@speqkit/test-kit': '^0.2.0',
  'typescript': '^5.7.2',
  'vitest': '^2.1.8',
  '@types/node': '^22.10.2'
} as const

export interface ScaffoldOptions {
  /** The plugin's short name — `http`, `kafka`. Not the package name. */
  name: string
  /** Where to write. Defaults to `./speqkit-plugin-<name>`. */
  dir?: string
  /** An npm scope, for a plugin that is not meant to be public. */
  scope?: string
  description?: string
  /** Write into a directory that already has files in it. */
  force?: boolean
}

export interface ScaffoldResult {
  dir: string
  packageName: string
  files: string[]
}

/** `http` → `speqkit-plugin-http`, or `@acme/speqkit-plugin-http`. */
export function packageNameFor(name: string, scope?: string): string {
  const bare = `speqkit-plugin-${name}`
  if (!scope) return bare
  return `${scope.startsWith('@') ? scope : `@${scope}`}/${bare}`
}

/**
 * The name has to survive being a directory, an npm package and a step type
 * prefix, so it is held to the strictest of the three.
 */
export function assertName(name: string): void {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(
      `'${name}' will not work as a plugin name.\n` +
        '  Lowercase letters, digits and single hyphens, starting with a letter: http, kafka, my-thing.'
    )
  }
}

export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  assertName(options.name)
  const packageName = packageNameFor(options.name, options.scope)
  const dir = resolve(options.dir ?? `speqkit-plugin-${options.name}`)

  if (!options.force && existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already has files in it. Pick another directory, or pass --force.`)
  }

  const description = options.description ?? `A speq plugin: ${options.name}.`
  const files: Record<string, string> = {
    'package.json': packageJson(packageName, description),
    'tsconfig.json': tsconfig(),
    'vitest.config.ts': vitestConfig(),
    '.gitignore': 'node_modules/\ndist/\n*.tsbuildinfo\n',
    'src/index.ts': source(options.name, packageName),
    'test/plugin.test.ts': tests(options.name),
    'README.md': readme(options.name, packageName, description),
    // Delivery, scaffolded with everything else. A plugin whose release is a
    // thing its author does by hand is a plugin that gets its fix on the day
    // its author has an afternoon — the failure mode an ecosystem cannot
    // afford, because that fix is nobody else's to ship.
    '.github/workflows/release.yml': releaseWorkflow(packageName)
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }

  return { dir, packageName, files: Object.keys(files).sort() }
}

function packageJson(packageName: string, description: string): string {
  return `${JSON.stringify(
    {
      name: packageName,
      version: '0.1.0',
      description,
      license: 'MIT',
      type: 'module',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js'
        }
      },
      // The one keyword `speq plugins search` and the registry conventions
      // look for. Without it the plugin works and nobody finds it.
      keywords: ['speqkit-plugin'],
      files: ['dist', 'src'],
      scripts: {
        build: 'tsc -p tsconfig.json',
        test: 'vitest run',
        prepublishOnly: 'npm run build && npm test'
      },
      // A peer, not a dependency: the contract comes from the kernel the user
      // installed. A plugin that bundled its own copy would be checked for
      // compatibility against itself.
      peerDependencies: {
        '@speqkit/plugin-api': VERSIONS['@speqkit/plugin-api']
      },
      devDependencies: {
        '@speqkit/plugin-api': VERSIONS['@speqkit/plugin-api'],
        '@speqkit/test-kit': VERSIONS['@speqkit/test-kit'],
        '@types/node': VERSIONS['@types/node'],
        speqkit: VERSIONS['speqkit'],
        typescript: VERSIONS['typescript'],
        vitest: VERSIONS['vitest']
      },
      engines: { node: '>=20.0.0' },
      // Spelled out rather than left to the publisher's memory. npm defaults a
      // scoped package to `restricted`, and the failure is a plugin that
      // publishes successfully and 404s for everyone who tries to install it.
      // Harmless on an unscoped name, so it is unconditional.
      publishConfig: { access: 'public' }
    },
    null,
    2
  )}\n`
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        declaration: true,
        outDir: 'dist',
        rootDir: 'src',
        types: ['node']
      },
      include: ['src/**/*.ts']
    },
    null,
    2
  )}\n`
}

function vitestConfig(): string {
  return `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] }
})
`
}

function source(name: string, packageName: string): string {
  const type = `${name}.ping`
  return `import { definePlugin } from '@speqkit/plugin-api'

/**
 * ${packageName}
 *
 * A plugin contributes into a kernel that is already running. It never
 * imports one: everything it needs from the session arrives as \`ctx\`, which
 * is why the only runtime dependency here is the contract.
 */
export default definePlugin({
  name: '${packageName}',

  /** This plugin's block in speq.yaml, under the key \`${name}\`. */
  configSchema: {
    type: 'object',
    properties: {
      greeting: { type: 'string' }
    },
    additionalProperties: false
  },

  setup(ctx) {
    ctx.defineStepType('${type}', {
      // Declared so the kernel can reject a bad test before a single call
      // goes out, and name the file and the path when it does.
      schema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
        additionalProperties: false
      },

      // The schema settles shape; this settles whether the input means
      // anything — a host that resolves, a file that is on disk, two fields
      // that exclude each other. It runs in front of the run, so the answer
      // costs milliseconds instead of arriving halfway through one.
      validate(step) {
        if (typeof step.to === 'string' && step.to.trim() === '') {
          return [{ path: 'to', message: "'to' is empty" }]
        }
        return []
      },

      async execute(exec, input) {
        const { greeting = 'hello' } = ctx.config<{ greeting?: string }>()
        // \`input\` arrives with every \`\${...}\` already resolved.
        const message = \`\${greeting}, \${String(input.to)}\`

        // Anything returned is bound to the step's \`id\` and addressable as
        // \`\${id.field}\` by later steps and by assertions.
        return { message, at: Date.now() }
      }
    })

    ctx.defineAssertion('pong', {
      schema: {
        type: 'object',
        properties: { contains: { type: 'string' } },
        required: ['contains'],
        additionalProperties: false
      },

      evaluate(assert, input) {
        const actual = String(assert.last?.message ?? '')
        const expected = String(input.contains)
        return {
          passed: actual.includes(expected),
          message: actual.includes(expected)
            ? \`message contains '\${expected}'\`
            : \`expected '\${actual}' to contain '\${expected}'\`,
          expected,
          actual
        }
      }
    })
  }
})
`
}

function tests(name: string): string {
  const type = `${name}.ping`
  return `import { afterEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from '@speqkit/test-kit'
import plugin from '../src/index.js'

/**
 * These run the plugin inside the real kernel — the same Registry, Executor
 * and runner \`speq run\` uses. There are no fakes to keep in sync, and a green
 * test here means the plugin works in a project.
 */

let kit: Harness
afterEach(async () => { await kit.close() })

describe('${type}', () => {
  it('returns the message it built', async () => {
    kit = await harness(plugin)
    const step = await kit.step({ type: '${type}', to: 'world' })

    expect(step.status).toBe('passed')
    expect(step.result.message).toBe('hello, world')
  })

  it('reads its greeting out of speq.yaml', async () => {
    kit = await harness(plugin, { config: { ${name.includes('-') ? `'${name}'` : name}: { greeting: 'hei' } } })
    const step = await kit.step({ type: '${type}', to: 'world' })

    expect(step.result.message).toBe('hei, world')
  })

  it('is addressable from a later step', async () => {
    kit = await harness(plugin)
    await kit.step({ id: 'first', type: '${type}', to: 'world' })
    const second = await kit.step({ type: '${type}', to: '\${first.message}' })

    expect(second.result.message).toBe('hello, hello, world')
  })

  it('rejects a test that leaves out a required input', async () => {
    kit = await harness(plugin)
    const diagnostics = kit.validate([
      { name: 't', steps: [{ type: '${type}' }], source: 'suites/a.yaml' }
    ])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain('to')
  })

  it('rejects an input the schema cannot judge, before anything runs', async () => {
    kit = await harness(plugin)
    const diagnostics = kit.validate([
      { name: 't', steps: [{ type: '${type}', to: '  ' }], source: 'suites/a.yaml' }
    ])

    expect(diagnostics).toEqual([
      { file: 'suites/a.yaml', path: 'steps[0].to', message: "'to' is empty" }
    ])
  })
})

describe('pong', () => {
  it('passes when the message contains what was asked for', async () => {
    kit = await harness(plugin)
    await kit.step({ type: '${type}', to: 'world' })

    expect(await kit.assert({ type: 'pong', contains: 'world' })).toMatchObject({ passed: true })
  })

  it('says what it saw when it does not', async () => {
    kit = await harness(plugin)
    await kit.step({ type: '${type}', to: 'world' })
    const outcome = await kit.assert({ type: 'pong', contains: 'mars' })

    expect(outcome.passed).toBe(false)
    expect(outcome.message).toContain('hello, world')
  })
})

describe('a whole test, the way a user writes one', () => {
  it('runs the step and the assertion together', async () => {
    kit = await harness(plugin)
    const outcome = await kit.run([
      {
        name: 'says hello',
        steps: [{ id: 'greeting', type: '${type}', to: 'world' }],
        assert: [{ type: 'pong', contains: '\${greeting.message}' }]
      }
    ])

    expect(outcome.status).toBe('passed')
  })
})
`
}

function readme(name: string, packageName: string, description: string): string {
  const type = `${name}.ping`
  return `# ${packageName}

${description}

## Install

\`\`\`bash
speq plugins add ${packageName}
\`\`\`

## Use

\`\`\`yaml
# .speq/speq.yaml
plugins:
  - ${packageName}

${name}:
  greeting: hello
\`\`\`

\`\`\`yaml
# suites/smoke.yaml
name: says hello
steps:
  - id: greeting
    type: ${type}
    to: world
assert:
  - type: pong
    contains: \${greeting.message}
\`\`\`

## Develop

\`\`\`bash
npm install
npm test     # runs the plugin inside the real kernel, via @speqkit/test-kit
npm run build
\`\`\`

While writing it, point a project at the working copy instead of the registry:

\`\`\`bash
speq plugins link .
\`\`\`

## What is here

- \`src/index.ts\` — one step type and one assertion, both with schemas so the
  kernel can reject a bad test before anything runs.
- \`test/plugin.test.ts\` — tests against the real kernel. No fakes.

The only runtime dependency is \`@speqkit/plugin-api\`, and it is a peer: the
contract comes from the kernel the user installed, not from a copy shipped
here. Nothing in this package imports \`speqkit\`.

## Release

\`.github/workflows/release.yml\` is already here. Add one secret and it runs
itself:

1. On npmjs.com: Access Tokens → Generate → **Automation**. Automation rather
   than Publish, because a publish token asks for a second factor and a CI
   runner has no thumbs.
2. In this repository: Settings → Secrets and variables → Actions → New
   repository secret, named \`NPM_TOKEN\`.

After that, **bump the version in \`package.json\` and merge to main.** The
workflow builds, runs the tests inside the real kernel, checks that the
package would actually load once installed, and publishes it — and does
nothing at all when that version is already in the registry, so an ordinary
commit is not a release.

To publish from a terminal instead, which is the usual answer for the first
one:

\`\`\`bash
export NPM_TOKEN=npm_xxxxxxxx     # or just 'npm login' once
curl -fsSL https://speqkit.github.io/speqkit/release-plugin.sh | sh
\`\`\`

It runs the same checks in the same order and stops before publishing if any
of them fails. Pass \`--dry-run\` to see what it would do.

Keep the \`speqkit-plugin\` keyword in \`package.json\` either way — it is how
the plugin is found, and the check refuses to publish without it.
`
}

/**
 * The release workflow every scaffolded plugin gets. It delegates to a
 * reusable workflow in speqkit rather than spelling the steps out here: the
 * checks it runs will grow, and a plugin generated last year should get them
 * without its author editing a file they have never read.
 */
function releaseWorkflow(packageName: string): string {
  return `# Publishes ${packageName} when its version changes.
#
# Needs one secret: NPM_TOKEN, an npm *automation* token.
#   Settings -> Secrets and variables -> Actions -> New repository secret
#
# Then the whole gesture is: bump the version in package.json, merge to main.
# A commit that leaves the version alone publishes nothing, because that
# version is already in the registry.
name: release

on:
  push:
    branches: [main]
  # Build, test and check without publishing anything.
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: true

jobs:
  release:
    uses: speqkit/speqkit/.github/workflows/plugin-release.yml@main
    with:
      dry-run: \${{ inputs.dry-run || false }}
    secrets:
      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`
}
