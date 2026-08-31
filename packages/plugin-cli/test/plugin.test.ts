import { afterEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from '@speqkit/test-kit'
import { definePlugin, type CommandHost, type RunEvent } from '@speqkit/plugin-api'
import cli from '@speqkit/plugin-cli'
import yaml from '@speqkit/plugin-yaml'

/**
 * The CLI is the reference every plugin author copies, and until now it was
 * the one plugin in the box with no tests at all.
 *
 * What is worth pinning here is not the wording of the output. It is the two
 * things a command can get wrong without anybody noticing: answering a
 * question other than the one the flags asked, and returning an exit code that
 * disagrees with what it printed. CI reads the second one and nothing else.
 */

let kit: Harness

afterEach(async () => {
  await kit?.close()
})

/**
 * One step type, so the suites below are about selection rather than about
 * HTTP. The CLI is the one plugin that must work with any vocabulary at all,
 * including a vocabulary it has never heard of.
 */
const noop = definePlugin({
  name: 'test-plugin-noop',
  setup(ctx) {
    ctx.defineStepType('noop', { async execute() { return { ok: true } } })
  }
})

/** A project with three suites, so a selection flag has something to select. */
async function withProject(): Promise<CommandHost> {
  kit = await harness(cli, { with: [yaml, noop] })
  kit.file('suites/health.yaml', 'name: health answers\ntags: [smoke]\nsteps:\n  - type: noop\n')
  kit.file('suites/orders/list.yaml', 'name: orders can be listed\ntags: [orders]\nsteps:\n  - type: noop\n')
  kit.file('suites/orders/typo.yaml', 'name: a typo\nsteps:\n  - type: nooop\n')
  return kit.registry.service('cli') as CommandHost
}

/** What the command wrote, and what it exited with. */
async function invoke(commands: CommandHost, name: string, argv: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((s: string) => { out.push(String(s)); return true }) as typeof process.stdout.write
  process.stderr.write = ((s: string) => { err.push(String(s)); return true }) as typeof process.stderr.write
  try {
    const code = await commands.commands.get(name)!.run(argv)
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

describe('the selection flags', () => {
  it('let validate check one file', async () => {
    const commands = await withProject()

    // The bug: both commands used to call discover() with no query and ignore
    // --test in silence, so this reported on the whole project. Asking about
    // the good file and being told about the broken one looks like an answer.
    const one = await invoke(commands, 'validate', ['--test', 'suites/health.yaml'])
    expect(one).toMatchObject({ code: 0 })
    expect(one.out).toBe('1 test(s) valid\n')

    const all = await invoke(commands, 'validate')
    expect(all.code).toBe(2)
    expect(all.err).toMatch(/unknown step type 'nooop'/)
  })

  it('let validate check one directory', async () => {
    const commands = await withProject()

    const subtree = await invoke(commands, 'validate', ['--suite', 'suites/orders'])
    expect(subtree.code).toBe(2)
    expect(subtree.err).toMatch(/typo\.yaml/)
    expect(subtree.err).not.toMatch(/health\.yaml/)
  })

  it('let list narrow by tag', async () => {
    const commands = await withProject()

    const smoke = await invoke(commands, 'list', ['--tags', 'smoke'])
    expect(smoke.code).toBe(0)
    expect(smoke.out).toContain('health answers')
    expect(smoke.out).not.toContain('orders can be listed')
    expect(smoke.out).toContain('1 test(s)')
  })
})

describe('the exit code', () => {
  it('is 2 when the project cannot be run, not 1', async () => {
    const commands = await withProject()

    // 1 means the tests ran and something failed; 2 means nothing ran. A CI
    // job that cannot tell them apart reports a broken config as a red test.
    expect((await invoke(commands, 'run', ['--tags', 'nobody-uses-this'])).code).toBe(2)
    expect((await invoke(commands, 'run', ['--suite', 'suites/orders'])).code).toBe(2)
  })
})

describe('the console reporter', () => {
  it('prints a failed assertion under the test it belongs to', async () => {
    kit = await harness(cli)
    const commands = kit.registry.service('cli') as CommandHost
    expect(commands).toBeDefined()

    const reporter = kit.registry.reporters.get('console')
    expect(reporter, 'the terminal output goes through defineReporter like any other').toBeDefined()

    const said: string[] = []
    const stdout = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((s: string) => { said.push(String(s)); return true }) as typeof process.stdout.write
    try {
      for (const event of stream()) reporter!.def.on(event)
    } finally {
      process.stdout.write = stdout
    }

    const printed = said.join('').replace(/\x1b\[\d+m/g, '')
    expect(printed).toContain('the order is created')
    expect(printed).toContain('x create (http)')
    expect(printed).toContain('✗ status expected 201, got 500')
    expect(printed).toContain('0 passed - 1 failed')
  })

  it('shows two scalars as a comparison', async () => {
    const printed = await render([{
      type: 'assertion.evaluated', test: 't', assertionType: 'status',
      passed: false, message: 'expected 201, got 500', expected: 201, actual: 500
    }])

    expect(printed).toContain('expected 201')
    expect(printed).toContain('actual   500')
    // Diff notation over two numbers aligns nothing; it just looks like a diff.
    expect(printed).not.toContain('- 201')
  })

  it('shows two shapes as a diff of the lines that differ', async () => {
    const printed = await render([{
      type: 'assertion.evaluated', test: 't', assertionType: 'equals',
      passed: false, message: 'body does not equal the expected object',
      expected: { id: 1, name: 'a', tags: ['x'] },
      actual: { id: 1, name: 'b', tags: ['x'] }
    }])

    // The whole point: the reader sees which field moved without running the
    // suite again behind a proxy.
    expect(printed).toContain('- expected')
    expect(printed).toContain('-   "name": "a",')
    expect(printed).toContain('+   "name": "b",')
    expect(printed).toContain('    "id": 1,')
    expect(printed).not.toContain('-   "id": 1,')
  })

  it('says nothing extra when the assertion had nothing to compare', async () => {
    const printed = await render([{
      type: 'assertion.evaluated', test: 't', assertionType: 'visible',
      passed: false, message: 'h1 is not visible'
    }])

    expect(printed).not.toContain('expected')
    expect(printed).not.toContain('(nothing)')
  })

  it('holds a test until it is over, so two of them do not interleave on screen', async () => {
    // The stream G4 permits: two suites in flight, their events alternating.
    // Printed through as they arrive, this reads as one test's steps indented
    // under another test's header — which is worse than no output at all,
    // because it looks right.
    const printed = await render([
      { type: 'test.started', test: 'slow', source: 'suites/slow.yaml' },
      { type: 'test.started', test: 'quick', source: 'suites/quick.yaml' },
      { type: 'step.finished', test: 'slow', stepType: 'http', depth: 1, status: 'passed', durationMs: 40 },
      { type: 'step.finished', test: 'quick', stepType: 'sql', depth: 1, status: 'passed', durationMs: 5 },
      { type: 'test.finished', test: 'quick', status: 'passed', durationMs: 5 },
      { type: 'step.finished', test: 'slow', stepType: 'http', depth: 1, status: 'passed', durationMs: 10 },
      { type: 'test.finished', test: 'slow', status: 'passed', durationMs: 50 }
    ])

    expect(printed.split('\n').filter(Boolean)).toEqual([
      'quick  suites/quick.yaml',
      '  . sql 5ms',
      'slow  suites/slow.yaml',
      '  . http 40ms',
      '  . http 10ms'
    ])
  })

  it('keeps a diagnostic with the test it is about', async () => {
    const printed = await render([
      { type: 'test.started', test: 'one', source: 'suites/one.yaml' },
      { type: 'test.started', test: 'two', source: 'suites/two.yaml' },
      { type: 'test.finished', test: 'two', status: 'passed', durationMs: 1 },
      { type: 'diagnostic', level: 'warn', source: 'one', message: 'cleanup did not complete' },
      { type: 'test.finished', test: 'one', status: 'error', durationMs: 2 }
    ])

    const lines = printed.split('\n').filter(Boolean)
    expect(lines.indexOf('one  suites/one.yaml')).toBeLessThan(
      lines.findIndex((l) => l.includes('cleanup did not complete'))
    )
  })

  it('prints what is still open when the run ends rather than losing it', async () => {
    const printed = await render([
      { type: 'test.started', test: 'never finished', source: 'suites/x.yaml' },
      { type: 'step.finished', test: 'never finished', stepType: 'http', depth: 1, status: 'error', durationMs: 1, message: 'socket hang up' },
      { type: 'run.finished', runId: 'r', status: 'error', passed: 0, failed: 0, errored: 1, skipped: 0, durationMs: 3 }
    ])

    expect(printed).toContain('never finished')
    expect(printed).toContain('socket hang up')
  })
})


/**
 * Drive the console reporter over a stream and return what it printed.
 *
 * Both streams, in the order they were written to. A diagnostic goes to stderr
 * and everything else to stdout, and where the diagnostic lands relative to the
 * test it names is the thing worth asserting on.
 */
async function render(events: RunEvent[]): Promise<string> {
  kit = await harness(cli)
  const reporter = kit.registry.reporters.get('console')!
  const said: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((s: string) => { said.push(String(s)); return true }) as typeof process.stdout.write
  process.stderr.write = ((s: string) => { said.push(String(s)); return true }) as typeof process.stderr.write
  try {
    for (const event of events) reporter.def.on(event)
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
  return said.join('').replace(/\x1b\[\d+m/g, '')
}

function stream(): RunEvent[] {
  return [
    { type: 'test.started', test: 'orders.create', title: 'the order is created', source: 'suites/orders.yaml' },
    {
      type: 'step.finished', test: 'orders.create', stepType: 'http', stepId: 'create',
      status: 'failed', durationMs: 12, depth: 1
    },
    {
      type: 'assertion.evaluated', test: 'orders.create', assertionType: 'status',
      passed: false, message: 'expected 201, got 500'
    },
    {
      type: 'run.finished', runId: 'r1', status: 'failed',
      passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 12
    }
  ]
}
