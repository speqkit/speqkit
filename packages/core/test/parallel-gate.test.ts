import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * The gate for suites running at once.
 *
 * Everything else in this milestone is checked from inside the repository that
 * makes the claim, which is exactly how the last claim survived for months:
 * `parallel` was believed to work because nobody outside had written the
 * plugin that would have shown it did not.
 *
 * So this one is a plugin from outside. No build step, no bundler, no import
 * of the kernel — a plain `.mjs` file against the shapes `@speqkit/plugin-api`
 * describes, loaded by path, driven by the real binary with the real
 * `--workers` flag, in a project that is not this one. It declares the two
 * things concurrency between suites can break: a `suite`-scoped resource, and
 * hooks holding per-suite state while registered once for the whole run.
 *
 * If this needs a kernel change to pass, the milestone is not done.
 */

const PLUGIN = `// A plugin from outside speqkit. Plain ESM against the published shapes.
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ledger = fileURLToPath(new URL('./ledger.log', import.meta.url))
const note = (line) => appendFileSync(ledger, \`\${line}\\n\`)

let issued = 0

export default {
  name: 'gate',

  setup(ctx) {
    // Per-suite state, held by hooks that are registered once for the run and
    // therefore called by every suite in it.
    const started = new Map()

    ctx.defineResource('tenant', {
      scope: 'suite',
      async setup() {
        const id = \`tenant-\${++issued}\`
        // Long enough that a second suite is inside the same window. This is
        // where a cache holding the value rather than the promise used to hand
        // out two resources under one name.
        await new Promise((r) => setTimeout(r, 40))
        note(\`up \${id}\`)
        return id
      },
      teardown: (value) => note(\`down \${value}\`)
    })

    ctx.defineHook('test:before', (payload) => {
      started.set(payload.suite, (started.get(payload.suite) ?? 0) + 1)
    })

    ctx.defineHook('step:after', (payload) => {
      note(\`saw \${payload.suite} \${payload.test} \${payload.record.result.tenant}\`)
    })

    ctx.defineHook('suite:after', (payload) => {
      note(\`hook \${payload.suite} counted \${started.get(payload.suite) ?? 0}\`)
    })

    ctx.defineStepType('use-tenant', {
      async execute(exec) {
        const tenant = await exec.resource('tenant')
        await new Promise((r) => setTimeout(r, 10))
        return { tenant }
      }
    })
  }
}
`

const SUITES = ['a', 'b', 'c', 'd']

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/**
 * The project lives under `examples/basic` for one reason: that is where the
 * workspace's plugins are installed, so `yaml` and `cli` resolve the way they
 * would in anybody's Node project. The gate plugin itself resolves by path and
 * needs nothing installed at all.
 */
function project(): string {
  const dir = mkdtempSync(join(repo, 'examples/basic', 'speq-gate-'))
  scratch.push(dir)
  mkdirSync(join(dir, 'suites'))
  writeFileSync(join(dir, 'plugin.mjs'), PLUGIN)
  writeFileSync(join(dir, 'speq.yaml'), 'version: 1\nplugins:\n  - yaml\n  - cli\n  - junit\n  - ./plugin.mjs\n')
  for (const suite of SUITES) {
    writeFileSync(
      join(dir, 'suites', `${suite}.yaml`),
      `name: ${suite}-one\nsteps:\n  - id: t\n    type: use-tenant\n` +
        `---\nname: ${suite}-two\nsteps:\n  - id: t\n    type: use-tenant\n`
    )
  }
  return dir
}

interface Run {
  code: number | null
  output: string
  ledger: string[]
}

function speq(dir: string, argv: string[]): Run {
  const result = spawnSync(
    'node',
    ['--import', 'tsx', join(repo, 'packages/core/src/bin.ts'), 'run', ...argv],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }
  )
  const output = `${result.stdout}${result.stderr}`
  if (!existsSync(join(dir, 'ledger.log'))) {
    throw new Error(`the gate plugin never ran. speq said:\n${output}`)
  }
  return { code: result.status, output, ledger: readFileSync(join(dir, 'ledger.log'), 'utf8').trim().split('\n') }
}

/** What the plugin observed, folded into the three claims worth making. */
function observed(ledger: string[]) {
  const up = ledger.filter((l) => l.startsWith('up ')).map((l) => l.slice(3))
  const down = ledger.filter((l) => l.startsWith('down ')).map((l) => l.slice(5))
  const bySuite = new Map<string, Set<string>>()
  const counted: string[] = []
  for (const line of ledger) {
    const saw = /^saw (\S+) (\S+) (\S+)$/.exec(line)
    if (saw) {
      const set = bySuite.get(saw[1]!) ?? new Set()
      set.add(saw[3]!)
      bySuite.set(saw[1]!, set)
    }
    if (line.startsWith('hook ')) counted.push(line)
  }
  return { up, down, bySuite, counted }
}

describe('a plugin from outside runs under --workers 4', () => {
  it('gives each suite one tenant, and takes each one down once', () => {
    const dir = project()
    const run = speq(dir, ['--workers', '4', '--reporter', 'console,junit'])

    expect(run.output).toContain('8 passed')
    expect(run.code).toBe(0)

    const { up, down, bySuite, counted } = observed(run.ledger)

    // One per suite. Two suites acquiring inside the same 40ms window used to
    // produce SETUPS 2 under one name, one of them never released and the
    // other released twice.
    expect(up).toHaveLength(SUITES.length)
    expect(new Set(up).size).toBe(SUITES.length)
    expect(down.sort()).toEqual([...up].sort())

    // Nothing crossed. Each suite's two tests saw one tenant, and no tenant
    // was seen by two suites.
    expect(bySuite.size).toBe(SUITES.length)
    for (const [suite, tenants] of bySuite) {
      expect(tenants.size, `${suite} saw ${[...tenants].join(', ')}`).toBe(1)
    }
    expect(new Set([...bySuite.values()].flatMap((s) => [...s])).size).toBe(SUITES.length)

    // The hooks are one pair of functions called by four suites. Each ended up
    // counting its own two tests and nobody else's.
    expect(counted.sort()).toEqual(SUITES.map((s) => `hook suites/${s}.yaml counted 2`))

    // And it really did overlap: every suite was set up before any was torn
    // down, which one worker cannot produce.
    expect(run.ledger.slice(0, SUITES.length).every((l) => l.startsWith('up '))).toBe(true)
  })

  it('reports the same run whether it took one worker or four', () => {
    const dir = project()
    const four = observed(speq(dir, ['--workers', '4', '--reporter', '']).ledger)
    rmSync(join(dir, 'ledger.log'))
    const one = observed(speq(dir, ['--reporter', '']).ledger)

    // The tenants are numbered in the order they were set up, so the names
    // match only because a suite's own story is the same either way.
    expect(four.up.sort()).toEqual(one.up.sort())
    expect(four.counted.sort()).toEqual(one.counted.sort())
    expect([...four.bySuite.keys()].sort()).toEqual([...one.bySuite.keys()].sort())
  })

  it('writes a report naming every test, from the interleaved stream', () => {
    const dir = project()
    speq(dir, ['--workers', '4', '--reporter', 'junit'])
    const xml = readFileSync(join(dir, 'reports/junit.xml'), 'utf8')

    expect(xml).toContain('tests="8"')
    for (const suite of SUITES) {
      expect(xml).toContain(`<testsuite name="suites/${suite}.yaml" tests="2"`)
      expect(xml).toContain(`name="${suite}-one" classname="suites/${suite}.yaml"`)
      expect(xml).toContain(`name="${suite}-two" classname="suites/${suite}.yaml"`)
    }
  })
}, 60_000)
