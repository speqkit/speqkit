import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definePlugin, type RunEvent, type ReporterContext } from '@speq/plugin-api'
import { Registry, loadConfig, runTests, replayRun, listRuns, readRunLog } from '@speq/core'
import junit from '@speq/plugin-junit'

/**
 * The road to a green CI, pinned.
 *
 * Two things are being protected here. First, that an environment layers
 * settings and cannot smuggle in a plugin, because that is what keeps
 * `speq install --frozen` meaningful. Second, that the event stream is
 * genuinely sufficient to build a report from — replaying a recorded run has
 * to produce the same file as watching it live, or every consumer we have
 * promised (JUnit, TUI, VS Code) is resting on something that is not true.
 */

const scratch: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speq-report-'))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  const root = tempDir()
  for (const [name, body] of Object.entries(files)) {
    const file = join(root, name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
  }
  return root
}

/* ------------------------------------------------------------------ */
/* Environments                                                        */
/* ------------------------------------------------------------------ */

describe('environments', () => {
  it('layers settings on top of speq.yaml', () => {
    const root = project({
      'speq.yaml': 'version: 1\nplugins: [http]\nhttp:\n  baseUrl: http://localhost:8080\n  timeout: 5000\n',
      'environments/ci.yaml': 'http:\n  baseUrl: https://staging.example.com\n'
    })

    const config = loadConfig(root, { env: 'ci' })
    expect(config.env).toBe('ci')
    expect(config.settings.http).toEqual({
      baseUrl: 'https://staging.example.com',
      // Merged, not replaced: an environment that overrides one URL must not
      // silently drop every other setting beside it.
      timeout: 5000
    })
    expect(config.plugins).toEqual(['http'])
  })

  it('refuses to let an environment change the plugin set', () => {
    const root = project({
      'speq.yaml': 'version: 1\nplugins: [http]\n',
      'environments/ci.yaml': 'plugins: [playwright]\n'
    })

    expect(() => loadConfig(root, { env: 'ci' })).toThrow(/cannot set 'plugins'/)
  })

  it('names the environments that do exist when one does not', () => {
    const root = project({
      'speq.yaml': 'version: 1\n',
      'environments/local.yaml': '{}\n',
      'environments/staging.yaml': '{}\n'
    })

    expect(() => loadConfig(root, { env: 'prod' })).toThrow(/Available: local, staging/)
  })

  it('is not applied at all when none is asked for', () => {
    const root = project({
      'speq.yaml': 'version: 1\nhttp:\n  baseUrl: http://localhost:8080\n',
      'environments/ci.yaml': 'http:\n  baseUrl: https://staging.example.com\n'
    })

    const config = loadConfig(root)
    expect(config.env).toBeUndefined()
    expect(config.settings.http).toEqual({ baseUrl: 'http://localhost:8080' })
  })
})

describe('${env:...} in config', () => {
  it('substitutes from the process environment', () => {
    process.env.SPEQ_TEST_URL = 'https://from-ci.example.com'
    const root = project({ 'speq.yaml': 'version: 1\nhttp:\n  baseUrl: ${env:SPEQ_TEST_URL}\n' })
    try {
      expect(loadConfig(root).settings.http).toEqual({ baseUrl: 'https://from-ci.example.com' })
    } finally {
      delete process.env.SPEQ_TEST_URL
    }
  })

  it('fails loudly on an unset variable rather than testing nothing', () => {
    const root = project({ 'speq.yaml': 'version: 1\nhttp:\n  baseUrl: ${env:SPEQ_ABSENT_VAR}\n' })
    expect(() => loadConfig(root)).toThrow(/SPEQ_ABSENT_VAR\} is not set/)
  })

  it('accepts a fallback for the variables that are genuinely optional', () => {
    const root = project({
      'speq.yaml': 'version: 1\nhttp:\n  baseUrl: ${env:SPEQ_ABSENT_VAR:-http://localhost:8080}\n'
    })
    expect(loadConfig(root).settings.http).toEqual({ baseUrl: 'http://localhost:8080' })
  })

  it('leaves step references alone', () => {
    // `${login.body.id}` belongs to the run, not to the config. Expanding it
    // here would consume the syntax the whole DSL is built on.
    const root = project({ 'speq.yaml': 'version: 1\nhttp:\n  header: ${login.body.token}\n' })
    expect(loadConfig(root).settings.http).toEqual({ header: '${login.body.token}' })
  })
})

/* ------------------------------------------------------------------ */
/* Reporters                                                           */
/* ------------------------------------------------------------------ */

const suite = definePlugin({
  name: 'suite-fixture',
  setup(ctx) {
    ctx.defineStepType('echo', { execute: (_c, input) => ({ value: input.value }) })
    ctx.defineStepType('boom', {
      execute() {
        throw new Error('the step never got an answer')
      }
    })
    ctx.defineAssertion('equals', {
      evaluate: (c, input) => ({
        passed: c.last?.value === input.expected,
        message: `expected ${String(input.expected)}, got ${String(c.last?.value)}`,
        expected: input.expected,
        actual: c.last?.value
      })
    })
  }
})

const tests = [
  {
    name: 'the value comes back',
    source: 'suites/echo.yaml',
    steps: [{ id: 'one', type: 'echo', value: 'hello' }],
    assert: [{ type: 'equals', expected: 'hello' }]
  },
  {
    name: 'the value is wrong',
    source: 'suites/echo.yaml',
    steps: [{ id: 'two', type: 'echo', value: 'hello' }],
    assert: [{ type: 'equals', expected: 'goodbye' }]
  },
  {
    name: 'the step blows up',
    source: 'suites/broken.yaml',
    steps: [{ id: 'three', type: 'boom' }]
  }
]

async function registryWith(...plugins: Parameters<Registry['register']>[0][]) {
  const registry = new Registry()
  for (const plugin of plugins) await registry.register(plugin)
  registry.settle()
  return registry
}

describe('the reporter mechanism', () => {
  it('drives a registered reporter through init, on and finalize', async () => {
    const calls: string[] = []
    let seen: ReporterContext | undefined

    const registry = await registryWith(
      suite,
      definePlugin({
        name: 'spy',
        setup(ctx) {
          ctx.defineReporter('spy', {
            init(run) {
              seen = run
              calls.push('init')
            },
            on: (event) => {
              calls.push(event.type)
            },
            finalize: () => {
              calls.push('finalize')
            }
          })
        }
      })
    )

    const dir = tempDir()
    const outcome = await runTests(registry, tests.slice(0, 1), {
      artifactDir: dir,
      reporters: ['spy']
    })

    expect(calls[0]).toBe('init')
    expect(calls.at(-1)).toBe('finalize')
    expect(calls).toContain('run.started')
    expect(calls[calls.length - 2]).toBe('run.finished')

    // Everything a file-writing reporter needs, and none of it knowable at
    // setup time — which is why `init` had to exist.
    expect(seen?.runId).toBe(outcome.runId)
    expect(seen?.outputDir).toBe(dir)
    expect(seen?.runDir).toBe(join(dir, outcome.runId))
  })

  it('rejects an unknown reporter before a single test runs', async () => {
    const started: RunEvent[] = []
    const registry = await registryWith(suite)
    registry.events.subscribe((e) => started.push(e))

    await expect(runTests(registry, tests, { reporters: ['juint'] })).rejects.toThrow(
      /unknown reporter 'juint'/
    )
    // A typo in a workflow file costs a second, not a twenty-minute suite.
    expect(started).toHaveLength(0)
  })

  it('drops a reporter that throws instead of losing the run', async () => {
    const registry = await registryWith(
      suite,
      definePlugin({
        name: 'broken-reporter',
        setup(ctx) {
          ctx.defineReporter('broken', {
            on(event) {
              if (event.type === 'test.started') throw new Error('reporter is broken')
            }
          })
        }
      })
    )

    const diagnostics: string[] = []
    registry.events.subscribe((e) => {
      if (e.type === 'diagnostic') diagnostics.push(e.message)
    })

    const outcome = await runTests(registry, tests.slice(0, 1), { reporters: ['broken'] })
    expect(outcome.status).toBe('passed')
    expect(diagnostics.join('\n')).toMatch(/reporter 'broken' failed and was dropped/)
  })
})

/* ------------------------------------------------------------------ */
/* The run log and replay                                              */
/* ------------------------------------------------------------------ */

describe('the run log', () => {
  it('records every event the run emitted, in order', async () => {
    const registry = await registryWith(suite)
    const dir = tempDir()
    const outcome = await runTests(registry, tests, { artifactDir: dir })

    const runs = listRuns(dir)
    expect(runs.map((r) => r.runId)).toEqual([outcome.runId])

    const recorded = readRunLog(runs[0]!.dir)
    expect(recorded[0]).toMatchObject({ type: 'run.started', runId: outcome.runId })
    expect(recorded.at(-1)).toMatchObject({ type: 'run.finished', status: 'error' })
    expect(recorded.filter((e) => e.type === 'test.finished')).toHaveLength(3)
  })

  it('writes nothing when the caller asked for nothing on disk', async () => {
    const registry = await registryWith(suite)
    const dir = tempDir()
    await runTests(registry, tests.slice(0, 1), {})
    expect(listRuns(dir)).toEqual([])
  })
})

describe('replay', () => {
  /**
   * The load-bearing test of this milestone.
   *
   * `speq report` renders a run from its recorded events alone — no runner, no
   * result object, no plugins that produced them. If the XML differs by one
   * byte from the live run's, then the event stream is not the contract we say
   * it is, and every future consumer built on it inherits the gap.
   */
  it('reproduces the live report byte for byte from the log alone', async () => {
    const registry = await registryWith(suite, junit)
    const dir = tempDir()
    const target = join(dir, 'junit.xml')

    const outcome = await runTests(registry, tests, {
      artifactDir: dir,
      reporters: ['junit']
    })
    const live = readFileSync(target, 'utf8')

    rmSync(target)
    const recorded = listRuns(dir).find((r) => r.runId === outcome.runId)!
    await replayRun(registry, recorded.dir, ['junit'], dir)

    expect(readFileSync(target, 'utf8')).toBe(live)
  })

  it('re-emits onto the same bus, so a reporter cannot tell it is a replay', async () => {
    const registry = await registryWith(suite)
    const dir = tempDir()
    const outcome = await runTests(registry, tests, { artifactDir: dir })

    const replayed: RunEvent[] = []
    registry.events.subscribe((e) => replayed.push(e))

    const recorded = listRuns(dir).find((r) => r.runId === outcome.runId)!
    const { events } = await replayRun(registry, recorded.dir, [], dir)
    expect(replayed).toEqual(events)
  })
})

/* ------------------------------------------------------------------ */
/* JUnit                                                               */
/* ------------------------------------------------------------------ */

describe('@speq/plugin-junit', () => {
  it('reports failures and errors as the different things they are', async () => {
    const registry = await registryWith(suite, junit)
    const dir = tempDir()
    await runTests(registry, tests, { artifactDir: dir, reporters: ['junit'] })

    const xml = readFileSync(join(dir, 'junit.xml'), 'utf8')
    expect(xml).toContain('tests="3" failures="1" errors="1"')
    expect(xml).toContain('<failure message="assertion equals: expected goodbye, got hello"')
    expect(xml).toContain('type="error"')

    // Grouped by suite, and the file each test came from survives into the
    // report — that is what makes a CI failure clickable.
    expect(xml).toContain('<testsuite name="suites/echo.yaml" tests="2"')
    expect(xml).toContain('<testsuite name="suites/broken.yaml" tests="1"')
    expect(xml).toContain('file="suites/echo.yaml"')
  })

  it('honours an explicit output path', async () => {
    const registry = await registryWith(suite, junit)
    const dir = tempDir()
    const target = join(tempDir(), 'nested', 'results.xml')
    registry.setConfig({ junit: { output: target, suiteName: 'payments' } })

    await runTests(registry, tests.slice(0, 1), { artifactDir: dir, reporters: ['junit'] })

    const xml = readFileSync(target, 'utf8')
    expect(xml).toContain('<testsuites name="payments"')
  })

  it('strips the control characters that would make the file unparseable', async () => {
    const registry = await registryWith(
      junit,
      definePlugin({
        name: 'coloured',
        setup(ctx) {
          ctx.defineStepType('coloured', { execute: () => ({}) })
          ctx.defineAssertion('coloured', {
            evaluate: () => ({ passed: false, message: '\u001B[31mred & <angry>\u001B[0m' })
          })
        }
      })
    )
    const dir = tempDir()
    await runTests(
      registry,
      [{ name: 'colourful', steps: [{ type: 'coloured' }], assert: [{ type: 'coloured' }] }],
      { artifactDir: dir, reporters: ['junit'] }
    )

    const xml = readFileSync(join(dir, 'junit.xml'), 'utf8')
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/)
    expect(xml).toContain('[31mred &amp; &lt;angry&gt;')
  })
})
