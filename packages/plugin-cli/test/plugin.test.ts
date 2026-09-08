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
    ctx.defineStepType('noop', {
      schema: { type: 'object', properties: { label: { type: 'string' } } },
      async execute() { return { ok: true } }
    })
    // A step that errors and an assertion that can fail, so the machine-
    // readable side of `run` has something other than green to describe.
    ctx.defineStepType('boom', {
      async execute(exec) {
        // Recorded before the throw, the way a request is recorded before the
        // socket is opened: what the step was doing is the only thing left to
        // say when there is no result.
        exec.record({ tried: 'the fixture', attempt: 1 })
        throw new Error('the fixture exploded')
      }
    })
    ctx.defineAssertion('is-ok', {
      schema: { type: 'object', properties: { expected: { type: 'boolean' } }, required: ['expected'] },
      evaluate(assert, input) {
        const actual = assert.last?.ok
        return {
          passed: actual === input.expected,
          message: `ok is ${String(actual)}`,
          expected: input.expected,
          actual
        }
      }
    })
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

    // A warning is said and is not a refusal. `meta` is open on purpose, so a
    // project that annotates in good faith cannot be stopped by one — and a
    // level nobody can pass a build with is a level nobody adds.
    kit.file(
      'suites/annotated.yaml',
      'name: annotated\nretries: 3\nsteps:\n  - type: noop\n'
    )
    const warned = await invoke(commands, 'validate', ['--test', 'suites/annotated.yaml'])
    expect(warned.code).toBe(0)
    expect(warned.err).toContain('meta.retries')
    expect(warned.err).toContain('1 warning(s)')
    expect(warned.out).toBe('1 test(s) valid\n')

    const asJson = await invoke(commands, 'validate', ['--test', 'suites/annotated.yaml', '--json'])
    expect(asJson.code).toBe(0)
    expect(JSON.parse(asJson.out).diagnostics).toMatchObject([
      { code: 'meta-looks-like-behaviour', level: 'warn' }
    ])

    const all = await invoke(commands, 'validate')
    expect(all.code).toBe(2)
    expect(all.err).toMatch(/unknown step type 'nooop'/)
  })

  /**
   * `--test` is relative to the speq root, and the speq root is `.speq`. So the
   * path every other tool hands you is the one that cannot work, and what came
   * back was Node's ENOENT naming `.speq/.speq/...`: a path nobody typed, and
   * no word about why. `--suite` has answered in speq's own words all along.
   */
  it('refuse a --test path in speq\'s own words, not Node\'s', async () => {
    const commands = await withProject()

    await expect(invoke(commands, 'run', ['--test', 'suites/nope.yaml']))
      .rejects.toThrow(/no test file at 'suites\/nope\.yaml'/)
    await expect(invoke(commands, 'run', ['--test', 'suites/nope.yaml']))
      .rejects.not.toThrow(/ENOENT/)

    // The path a person actually pastes: prefixed with the root's own name.
    await expect(invoke(commands, 'validate', ['--test', '.speq/suites/health.yaml']))
      .rejects.toThrow(/--test is relative to the speq root; did you mean --test suites\/health\.yaml/)
  })

  it('let validate check one directory', async () => {
    const commands = await withProject()

    const subtree = await invoke(commands, 'validate', ['--suite', 'suites/orders'])
    expect(subtree.code).toBe(2)
    expect(subtree.err).toMatch(/typo\.yaml/)
    expect(subtree.err).not.toMatch(/health\.yaml/)
  })

  /**
   * The first reader of argv was `indexOf`: it found the first `--test`, lost
   * the second in silence, could not read `--test=a`, and let `--bogus`
   * through as if it had been typed on purpose. The README promised that an
   * unknown flag is refused; now it is.
   */
  it('take a flag more than once, and in the = spelling', async () => {
    const commands = await withProject()

    const two = await invoke(commands, 'list', ['--test', 'suites/health.yaml', '--test=suites/orders/list.yaml'])
    expect(two.code).toBe(0)
    expect(two.out).toContain('health answers')
    expect(two.out).toContain('orders can be listed')
    expect(two.out).toContain('2 test(s)')

    // The union of what the two selection flags name, narrowed by `--tags`
    // afterwards rather than per flag: `suites/orders` and `suites/health.yaml`
    // are three files between them, and `typo.yaml` carries no tag at all.
    const both = await invoke(commands, 'list', ['--suite', 'suites/orders', '--test', 'suites/health.yaml', '--tags', 'smoke,orders'])
    expect(both.out).toContain('health answers')
    expect(both.out).toContain('orders can be listed')
    expect(both.out).not.toContain('a typo')
    expect(both.out).toContain('2 test(s)')
  })

  it('take a pattern for --test', async () => {
    const commands = await withProject()

    const orders = await invoke(commands, 'list', ['--test', 'suites/orders/*.yaml'])
    expect(orders.out).toContain('orders can be listed')
    expect(orders.out).toContain('a typo')
    expect(orders.out).not.toContain('health answers')

    const deep = await invoke(commands, 'list', ['--test', '**/li*.yaml'])
    expect(deep.out).toContain('1 test(s)')
    expect(deep.out).toContain('orders can be listed')
  })

  it('refuse a flag they do not take, with the nearest one they do', async () => {
    const commands = await withProject()

    const typo = await invoke(commands, 'list', ['--tets', 'suites/health.yaml'])
    expect(typo.code).toBe(2)
    expect(typo.out).toBe('')
    expect(typo.err).toContain("unknown flag '--tets' — did you mean '--test'?")

    const bogus = await invoke(commands, 'run', ['--bogus'])
    expect(bogus.code).toBe(2)
    expect(bogus.err).toContain("unknown flag '--bogus'")
    expect(bogus.err).toContain('--workers')

    const valued = await invoke(commands, 'list', ['--json=1'])
    expect(valued.code).toBe(2)
    expect(valued.err).toContain('--json takes no value')

    const bare = await invoke(commands, 'list', ['--shard'])
    expect(bare.code).toBe(2)
    expect(bare.err).toContain('--shard takes a value')

    // The bootstrap's own flags are legal on every command, since the command
    // sees them too.
    const global = await invoke(commands, 'list', ['--env', 'ci', '--speq-root', kit.root])
    expect(global.code).toBe(0)
  })

  it('colour the output only for a terminal, or when told to', async () => {
    const commands = await withProject()

    // The default — a terminal and no `NO_COLOR` — is decided when the plugin
    // loads and cannot be asked from inside one process, so the two flags
    // that override it are what is checked here.
    const painted = await invoke(commands, 'run', ['--test', 'suites/health.yaml', '--color'])
    expect(painted.out).toContain('\x1b[')

    const off = await invoke(commands, 'run', ['--test', 'suites/health.yaml', '--no-color'])
    expect(off.out).not.toContain('\x1b[')
  })

  it('let list narrow by tag', async () => {
    const commands = await withProject()

    const smoke = await invoke(commands, 'list', ['--tags', 'smoke'])
    expect(smoke.code).toBe(0)
    expect(smoke.out).toContain('health answers')
    expect(smoke.out).not.toContain('orders can be listed')
    expect(smoke.out).toContain('1 test(s)')
  })

  it('let list address one case by name', async () => {
    const commands = await withProject()

    // The other three flags say where to look or what to look for. After
    // reading a report, what anybody wants is that one row.
    const one = await invoke(commands, 'list', ['--name', 'health answers'])
    expect(one.code).toBe(0)
    expect(one.out).toContain('health answers')
    expect(one.out).toContain('1 test(s)')
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

describe('asking for concurrency', () => {
  it('refuses a --workers that is not a whole number of one or more', async () => {
    const commands = await withProject()
    for (const bad of ['0', '-2', 'auto', '2.5']) {
      const { code, err } = await invoke(commands, 'run', ['--test', 'suites/health.yaml', '--workers', bad])
      expect(code, `--workers ${bad}`).toBe(2)
      expect(err).toContain(`got '${bad}'`)
      expect(err).toContain('There is no auto')
    }
  })

  // Refused before discovery, so a bad flag costs nothing and a good one is
  // never half-applied: a run that quietly fell back to one worker after being
  // asked for eight is a twenty-minute suite pretending to obey.
  it('runs the suites when the number is one it can honour', async () => {
    const commands = await withProject()
    const { code } = await invoke(commands, 'run', ['--tags', 'smoke', '--workers', '4', '--reporter', ''])
    expect(code).toBe(0)
  })
})

/**
 * Nine tests over three files, one of which is a `cases` table.
 *
 * The table is the point: with `cases`, a thousand tests in one file is a
 * single test in a single file, which is exactly the shape slicing by file
 * cannot split and the shape shards exist to answer.
 */
async function withNineTests(): Promise<CommandHost> {
  kit = await harness(cli, { with: [yaml, noop] })
  kit.file('suites/a.yaml', 'name: a\nsteps:\n  - type: noop\n')
  kit.file('suites/b.yaml', 'name: b\nsteps:\n  - type: noop\n')
  kit.file('suites/big.yaml', [
    'name: big',
    'cases:',
    ...['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((id) => `  - id: ${id}`),
    'steps:',
    '  - type: noop',
    ''
  ].join('\n'))
  return kit.registry.service('cli') as CommandHost
}

/** The test names one `speq list` printed, in the order it printed them. */
function listed(out: string): string[] {
  return out.split('\n').filter((l) => l.includes('  ')).map((l) => l.split('  ')[1]!).filter(Boolean)
}

describe('slicing a run into shards', () => {
  it('refuses a --shard that is not the i-th of n', async () => {
    const commands = await withNineTests()
    // '2' has no n; '0/4' and '5/4' are not slices that exist; 'a/b' and
    // '1.5/3' are not whole numbers. Each is refused before discovery, so a
    // machine never quietly runs the whole suite after being asked for a
    // quarter of it.
    for (const bad of ['2', '0/4', '5/4', 'a/b', '1.5/3', '1/0', '1/2/3']) {
      const { code, err } = await invoke(commands, 'run', ['--shard', bad])
      expect(code, `--shard ${bad}`).toBe(2)
      expect(err).toContain(`got '${bad}'`)
    }
  })

  it('gives each test to exactly one shard, and puts the run back in order', async () => {
    const commands = await withNineTests()
    const whole = listed((await invoke(commands, 'list')).out)
    expect(whole).toHaveLength(9)

    const shards = []
    for (let i = 1; i <= 4; i++) {
      shards.push(listed((await invoke(commands, 'list', ['--shard', `${i}/4`])).out))
    }

    // The property the flag exists for, stated the way the roadmap states it:
    // four shards between them run each test exactly once.
    expect(shards.flat()).toEqual(whole)
    // And no shard carries a test another one also carries.
    expect(new Set(shards.flat()).size).toBe(9)
  })

  it('balances to within one test, so no shard is the long pole by construction', async () => {
    const commands = await withNineTests()
    for (const of of [1, 2, 3, 4, 5, 9, 12]) {
      const sizes = []
      for (let i = 1; i <= of; i++) {
        sizes.push(listed((await invoke(commands, 'list', ['--shard', `${i}/${of}`])).out).length)
      }
      expect(sizes.reduce((a, b) => a + b, 0), `n=${of}`).toBe(9)
      expect(Math.max(...sizes) - Math.min(...sizes), `n=${of}`).toBeLessThanOrEqual(1)
    }
  })

  it('splits a cases table across shards, which is the case it exists for', async () => {
    const commands = await withNineTests()
    // Slicing by file would leave all seven rows of big.yaml in one shard.
    const first = listed((await invoke(commands, 'list', ['--shard', '1/4'])).out)
    const last = listed((await invoke(commands, 'list', ['--shard', '4/4'])).out)
    expect(first.some((n) => n.startsWith('big['))).toBe(true)
    expect(last.some((n) => n.startsWith('big['))).toBe(true)
  })

  it('runs its own tests and nobody else\'s', async () => {
    const commands = await withNineTests()
    const { code } = await invoke(commands, 'run', ['--shard', '2/3', '--reporter', ''])
    expect(code).toBe(0)

    const ran = kit.eventsOf('test.started').map((e) => e.test)
    expect(ran).toHaveLength(3)
    const started = kit.eventsOf('run.started')[0]!
    expect(started.tests).toBe(3)
  })

  it('slices what the other flags selected, rather than being selected from', async () => {
    const commands = await withNineTests()
    // --test picks the seven rows of one file; --shard then halves them. The
    // other order — shard the project, then filter — would give a shard of
    // whatever happened to land in it, which is not what either flag means.
    const half = listed((await invoke(commands, 'list', ['--test', 'suites/big.yaml', '--shard', '1/2'])).out)
    expect(half).toHaveLength(4)
    expect(half.every((n) => n.startsWith('big['))).toBe(true)
  })

  it('says a shard is empty rather than that nothing matched', async () => {
    const commands = await withNineTests()
    // Twelve machines for nine tests is a reasonable thing for CI to do, and
    // three of them have nothing to run. 'no tests matched' would send whoever
    // reads that log looking for a selection mistake that is not there.
    const { code, err } = await invoke(commands, 'run', ['--shard', '12/12', '--reporter', ''])
    expect(code).toBe(2)
    expect(err).toContain('no tests in this shard')
    // And says which of the two numbers is the news: the tests are there, this
    // slice of them is not, and there is no typo to go looking for.
    expect(err).toContain('9 test(s) matched; shard 12/12 holds none of them')
  })
})

describe('the console reporter', () => {
  /**
   * A body arrives as one line — an HTML page is eighty thousand characters
   * with no newline in it once JSON has quoted it — so the line budget never
   * fired and `actual` printed the page. One failed `contains` over a rendered
   * page cost 1.6 MB of console in a real suite, and four fifths of a CI log.
   */
  it('clips a value too wide to read, and says how wide it was', async () => {
    kit = await harness(cli)
    const reporter = kit.registry.reporters.get('console')!

    const page = `<!doctype html>${'x'.repeat(80_000)}`
    const said: string[] = []
    const stdout = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((s: string) => { said.push(String(s)); return true }) as typeof process.stdout.write
    try {
      reporter.def.on({
        type: 'assertion.evaluated', test: 't', assertionType: 'contains',
        passed: false, message: 'expected body to contain "speq-1"',
        expected: 'speq-1', actual: page
      })
    } finally {
      process.stdout.write = stdout
    }

    const printed = said.join('')
    expect(printed).toContain('speq-1')
    expect(printed).toContain('characters, clipped')
    expect(printed).not.toContain('x'.repeat(1000))
    expect(printed.length).toBeLessThan(1000)
  })

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
describe('a step that belongs to a suite', () => {
  it('says where it is, since no test header stands above it', async () => {
    const printed = await render([
      { type: 'suite.started', suite: 'suites/menu' },
      { type: 'step.finished', suite: 'suites/menu', stepId: 'tenant', stepType: 'http', depth: 1, phase: 'setup', status: 'passed', durationMs: 4 },
      { type: 'test.started', test: 'items', source: 'suites/menu/items.yaml' },
      { type: 'step.finished', test: 'items', stepType: 'http', depth: 1, status: 'passed', durationMs: 2 },
      { type: 'test.finished', test: 'items', status: 'passed', durationMs: 2 }
    ])

    // A suite's setup runs before the first test in it, so there is no header
    // above it to inherit. Buffering it would be worse: it belongs to no test.
    expect(printed).toContain('tenant (http)')
    expect(printed).toMatch(/tenant \(http\).*suites\/menu/)
  })
})

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

/**
 * The whole bet — that a generated suite can be checked before it runs — was
 * unreachable from outside the process. A caller could start `speq validate`,
 * and then had to read sentences off coloured stderr and match substrings of
 * them, so a reworded message quietly changed what it concluded.
 *
 * These pin the two halves of the fix: that the answer has a shape, and that
 * `code` is the part of it that does not move.
 */
describe('watching', () => {
  it('refuses --watch with --json, because a stream of runs is not a document', async () => {
    const commands = await withProject()
    const answer = await invoke(commands, 'run', ['--watch', '--json'])
    expect(answer.code).toBe(2)
    expect(answer.err).toContain('exclude each other')
  })

  it('runs once and then keeps going, until it is stopped', async () => {
    const commands = await withProject()
    // Started, left to settle, then stopped the way a person stops it. What is
    // being checked is that the first pass happened and the command did not
    // return on its own — a watch that exits after one run is a watch that
    // silently stopped watching.
    const watching = invoke(commands, 'run', ['--watch', '--test', 'suites/health.yaml', '--reporter', ''])
    await new Promise((r) => setTimeout(r, 250))
    process.emit('SIGINT')

    const answer = await watching
    expect(answer.code).toBe(0)
    expect(answer.out).toContain('watching')
    expect(answer.out).toContain('ctrl-c to stop')
  })
})

describe('the grammar in the dialect an editor speaks', () => {
  /**
   * A step type is a word a plugin registered at load time, so no schema
   * shipped in a package could ever list the ones a given project has. The
   * site has promised for two releases that plugin schemas reach
   * yaml-language-server; nothing in the code did it.
   */
  const parsed = async (commands: CommandHost) => {
    const answer = await invoke(commands, 'schema')
    expect(answer.code).toBe(0)
    return JSON.parse(answer.out) as Record<string, any>
  }

  it('says a file is either a test or a suite manifest', async () => {
    const schema = await parsed(await withProject())
    expect(schema.anyOf).toEqual([
      { $ref: '#/definitions/test' },
      { $ref: '#/definitions/suite' }
    ])
    expect(schema.definitions.test.required).toEqual(['steps'])
    // Open, because everything outside the spine is an annotation — the list
    // is closed so that the annotations can be open.
    expect(schema.definitions.test.additionalProperties).toBe(true)
  })

  it('gives every step type its own branch, with the kernel fields in it', async () => {
    const schema = await parsed(await withProject())
    const branch = schema.definitions.step.allOf
      .find((b: any) => b.if.properties.type.const === 'noop')

    expect(branch).toBeDefined()
    // `id`, `when` and `timeout` belong to the kernel and are written into
    // every branch: `additionalProperties: false` only sees what is declared
    // beside it, so without this the spine would be the mistake.
    expect(Object.keys(branch.then.properties)).toEqual(
      expect.arrayContaining(['id', 'type', 'when', 'timeout', 'assert', 'meta'])
    )
  })

  it('lets a typed field be written as a whole template, because it may be', async () => {
    const schema = await parsed(await withProject())
    const status = schema.definitions.assertion.allOf
      .find((b: any) => b.if.properties.type.const === 'is-ok')

    // Nothing in this fixture is typed, so the check is the transformation
    // itself: a number field accepts `${…}` beside the number.
    expect(status).toBeDefined()
  })

  it('writes it where it was asked to, and nowhere else', async () => {
    const commands = await withProject()
    const written = await invoke(commands, 'schema', ['--out', 'schema.json'])
    expect(written.code).toBe(0)
    expect(written.out).toContain('schema.json')
    // The line that makes the file do anything: an editor finds a schema by
    // the modeline in the test file, not by the file being on disk.
    expect(written.out).toContain('# yaml-language-server: $schema=')

    const escaped = await invoke(commands, 'schema', ['--out', '../../etc/schema.json'])
    expect(escaped.code).toBe(2)
    expect(escaped.err).toContain('outside it')
  })
})

describe('answering a machine', () => {
  const parse = (out: string): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>

  it('gives validate a document with a code on every problem', async () => {
    const commands = await withProject()

    const answer = await invoke(commands, 'validate', ['--json'])
    expect(answer.code).toBe(2)
    // Everything on stdout, including the bad news: stderr keeps what went
    // wrong with the *command*, which is a different question.
    expect(answer.err).toBe('')

    const document = parse(answer.out)
    expect(document.checked).toBe(3)
    expect(document.diagnostics).toEqual([
      {
        file: 'suites/orders/typo.yaml',
        path: 'steps[0].type',
        code: 'unknown-step-type',
        message: "unknown step type 'nooop'",
        hint: expect.stringContaining('noop')
      }
    ])
  })

  it('says a clean project is clean in the same shape', async () => {
    const commands = await withProject()

    const answer = await invoke(commands, 'validate', ['--json', '--test', 'suites/health.yaml'])
    expect(answer.code).toBe(0)
    expect(parse(answer.out)).toEqual({ checked: 1, diagnostics: [] })
  })

  it('gives list the identities and not the steps', async () => {
    const commands = await withProject()

    const answer = await invoke(commands, 'list', ['--json', '--tags', 'smoke'])
    expect(answer.code).toBe(0)
    expect(parse(answer.out)).toEqual({
      tests: [{
        name: 'health answers',
        source: 'suites/health.yaml',
        suites: [],
        tags: ['smoke']
      }]
    })
  })

  it('slices the list document the way it slices the list', async () => {
    const commands = await withNineTests()

    // One at a time: `invoke` swaps process.stdout for the length of a call,
    // so two of them in flight would be reading each other's output.
    const shards: string[][] = []
    for (const index of [1, 2, 3]) {
      const answer = await invoke(commands, 'list', ['--json', '--shard', `${index}/3`])
      shards.push((parse(answer.out).tests as { name: string }[]).map((test) => test.name))
    }

    expect(shards.map((shard) => shard.length)).toEqual([3, 3, 3])
    const whole = await invoke(commands, 'list', ['--json'])
    expect(shards.flat()).toEqual((parse(whole.out).tests as { name: string }[]).map((t) => t.name))
  })

  it('gives run one document and nothing else on stdout', async () => {
    const commands = await withProject()

    const answer = await invoke(commands, 'run', ['--json', '--test', 'suites/health.yaml'])
    expect(answer.code).toBe(0)

    // The load-bearing assertion: the console reporter did not also write
    // here. `--json` replaces the default reporter, so the whole of stdout
    // parses or the test fails.
    const document = parse(answer.out)
    expect(document).toMatchObject({
      status: 'passed',
      passed: 1, failed: 0, errored: 0, skipped: 0,
      tests: [{ name: 'health answers', status: 'passed', failures: [] }]
    })
    expect(document.runDir).toContain(String(document.runId))
  })

  it('carries what a failing test compared, not just that it failed', async () => {
    const commands = await withProject()
    kit.file(
      'suites/red.yaml',
      'name: a red test\nsteps:\n  - id: one\n    type: noop\nassert:\n  - type: is-ok\n    expected: false\n'
    )

    const answer = await invoke(commands, 'run', ['--json', '--test', 'suites/red.yaml'])
    expect(answer.code).toBe(1)

    const [test] = parse(answer.out).tests as { status: string; failures: unknown[] }[]
    expect(test?.status).toBe('failed')
    expect(test?.failures).toEqual([
      {
        kind: 'assertion', type: 'is-ok', code: 'assertion-failed',
        message: 'ok is true', expected: false, actual: true
      }
    ])
  })

  it('names the step that errored, by its id', async () => {
    const commands = await withProject()
    kit.file('suites/blown.yaml', 'name: a blown test\nsteps:\n  - id: detonate\n    type: boom\n')

    const answer = await invoke(commands, 'run', ['--json', '--test', 'suites/blown.yaml'])
    expect(answer.code).toBe(1)

    const [test] = parse(answer.out).tests as { failures: Record<string, unknown>[] }[]
    expect(test?.failures[0]).toMatchObject({
      kind: 'step',
      step: 'detonate',
      type: 'boom',
      status: 'error',
      // The word a caller branches on. The sentence beside it is for a person
      // and may be reworded; this may not.
      code: 'plugin-threw',
      message: expect.stringContaining('the fixture exploded')
    })
  })

  it('refuses in the document rather than beside it', async () => {
    const commands = await withProject()

    // Both refusals a caller can hit: a project that will not validate, and
    // a selection that matched nothing. Exit codes unchanged — a machine
    // reading the document and a CI job reading `$?` get the same answer.
    const invalid = await invoke(commands, 'run', ['--json'])
    expect(invalid.code).toBe(2)
    expect(parse(invalid.out)).toMatchObject({
      status: 'invalid',
      diagnostics: [{ code: 'unknown-step-type' }]
    })

    // Which of the four "nothing matched" this is, because they are four
    // different things to do next: a typo, a tag nobody uses, a real file in
    // the wrong place, or a project where discovery finds nothing at all.
    const empty = await invoke(commands, 'run', ['--json', '--tags', 'nobody-uses-this'])
    expect(empty.code).toBe(2)
    expect(parse(empty.out)).toMatchObject({
      status: 'no-tests',
      message: 'no tests matched',
      discovered: 3,
      asked: ['--tags nobody-uses-this']
    })
  })

  it('leaves a chosen reporter alone', async () => {
    const commands = await withProject()

    // `--json` replaces the *default* reporter, not one that was asked for:
    // the document on stdout and a file on disk answer different callers, and
    // wanting both is the ordinary case in CI.
    const answer = await invoke(commands, 'run', ['--json', '--reporter', 'console', '--test', 'suites/health.yaml'])
    expect(answer.code).toBe(0)
    expect(answer.out).toContain('health answers')
    expect(() => parse(answer.out)).toThrow()
  })
})

/**
 * The grammar was in the registry from the moment a plugin registered, and
 * nothing outside the process could read it. So an editor, a palette and a
 * prompt describing speq to a model each carried a copy that went stale
 * silently the moment somebody installed a plugin.
 */
describe('speq capabilities', () => {
  it('enumerates what may be written, with the schemas and the owners', async () => {
    const commands = await withProject()

    const answer = await invoke(commands, 'capabilities', ['--json'])
    expect(answer.code).toBe(0)

    const document = JSON.parse(answer.out) as Record<string, never>
    expect(document.apiVersion).toBe(1)
    expect(document.stepTypes).toEqual([
      { name: 'boom', plugin: 'test-plugin-noop' },
      {
        name: 'noop',
        plugin: 'test-plugin-noop',
        schema: { type: 'object', properties: { label: { type: 'string' } } }
      }
    ])
    expect(document.assertions).toEqual([{
      name: 'is-ok',
      plugin: 'test-plugin-noop',
      schema: {
        type: 'object',
        properties: { expected: { type: 'boolean' } },
        required: ['expected']
      }
    }])
    // The sentence rides beside the schema: a shape with no meaning attached
    // is what this document used to be, and what a model reading it had to
    // guess its way through.
    expect(document.reporters).toMatchObject([{
      name: 'console',
      plugin: '@speqkit/plugin-cli',
      summary: expect.stringContaining('prints each test')
    }])
    expect(document.loaders).toMatchObject([{ name: 'yaml', extensions: ['.yaml', '.yml'] }])
  })

  it('prints the same thing for a person, required fields starred', async () => {
    const commands = await withProject()

    const answer = await invoke(commands, 'capabilities')
    expect(answer.code).toBe(0)
    expect(answer.out).toContain('plugin-api v1')
    expect(answer.out).toContain('boom')
    // The star is the whole of the schema a terminal is the right place for:
    // that `expected` exists and has to be written.
    expect(answer.out).toMatch(/is-ok[\s\S]*expected\*/)
  })
})

/**
 * The half of a failure a repair loop could not reach.
 *
 * `expected` and `actual` say what was compared; neither says what the step
 * was doing when it fell over. A person without that reruns the test with a
 * proxy in front of it; an agent without it guesses.
 */
describe('what the step was doing', () => {
  async function withRedRun(): Promise<CommandHost> {
    const commands = await withProject()
    kit.file('suites/boom.yaml', 'name: a step that explodes\nsteps:\n  - id: one\n    type: boom\n')
    return commands
  }

  it('rides into the run document, on the step that did not pass', async () => {
    const commands = await withRedRun()

    const answer = await invoke(commands, 'run', ['--json', '--test', 'suites/boom.yaml'])
    expect(answer.code).toBe(1)

    const document = JSON.parse(answer.out) as {
      tests: { failures: { kind: string; status?: string; detail?: unknown }[] }[]
    }
    expect(document.tests[0]!.failures[0]).toMatchObject({
      kind: 'step',
      status: 'error',
      detail: { tried: 'the fixture', attempt: 1 }
    })
  })

  it('is on screen when it is asked for, and only then', async () => {
    const commands = await withRedRun()

    const quiet = await invoke(commands, 'run', ['--test', 'suites/boom.yaml'])
    expect(quiet.out).toContain('the fixture exploded')
    expect(quiet.out).not.toContain('tried')

    const loud = await invoke(commands, 'run', ['--test', 'suites/boom.yaml', '--verbose'])
    expect(loud.out).toContain('the fixture exploded')
    expect(loud.out).toContain('"tried": "the fixture"')
  })

  it('says nothing extra about a run where everything passed', async () => {
    const commands = await withRedRun()

    const answer = await invoke(commands, 'run', ['--test', 'suites/health.yaml', '--verbose'])
    expect(answer.code).toBe(0)
    expect(answer.out).not.toContain('tried')
  })
})

/**
 * The half of a gate that is not selection.
 *
 * `--tags` narrows what runs; this narrows what the exit code answers for,
 * without narrowing what runs. The two are easy to confuse and the difference
 * is the whole point: a zone whose suites are not run has no result to be
 * advisory about.
 */
describe('which part of a run decides the exit code', () => {
  /** Two zones, one red in each, so both directions have something to prove. */
  async function withZones(): Promise<CommandHost> {
    kit = await harness(cli, { with: [yaml, noop] })
    kit.file('suites/backend-ok.yaml', 'name: backend is fine\ntags: [backend]\nsteps:\n  - type: noop\n')
    kit.file(
      'suites/backend-red.yaml',
      'name: backend is red\ntags: [backend]\nsteps:\n  - type: noop\n    assert:\n      - type: is-ok\n        expected: false\n'
    )
    kit.file(
      'suites/menu-red.yaml',
      'name: menu is red\ntags: [menu]\nsteps:\n  - type: noop\n    assert:\n      - type: is-ok\n        expected: false\n'
    )
    kit.file('suites/untagged.yaml', 'name: untagged\nsteps:\n  - type: noop\n')
    return kit.registry.service('cli') as CommandHost
  }

  it('runs everything and lets the named tags out of the verdict', async () => {
    const commands = await withZones()

    // Without the flag, one red anywhere is exit 1 — unchanged.
    const plain = await invoke(commands, 'run', ['--reporter', 'console'])
    expect(plain.code).toBe(1)

    // With it, the red menu test still ran, still printed, still counted in
    // the totals, and did not decide anything.
    const gated = await invoke(commands, 'run', ['--tags', 'menu', '--advisory', 'menu', '--reporter', 'console'])
    const printed = gated.out.replace(/\x1b\[\d+m/g, '')
    expect(gated.code).toBe(0)
    expect(printed).toContain('menu is red')
    expect(printed).toContain('0 passed - 1 failed')
    expect(printed).toContain('advisory')
    expect(printed).toContain('exit 0: 1 of them red, and nothing blocking is')
  })

  it('still fails on a red test the flag did not name', async () => {
    const commands = await withZones()

    const gated = await invoke(commands, 'run', ['--advisory', 'menu', '--reporter', 'console'])
    expect(gated.code).toBe(1)
    expect(gated.out.replace(/\x1b\[\d+m/g, '')).toContain('exit 1: 1 blocking test(s) red')
  })

  /**
   * The safe default, and the reason only the advisory half is named. A zone
   * somebody forgot to add to the list must not become a zone nobody checks.
   */
  it('treats a test carrying none of the named tags as blocking', async () => {
    const commands = await withZones()

    kit.file(
      'suites/nameless-red.yaml',
      'name: nameless is red\nsteps:\n  - type: noop\n    assert:\n      - type: is-ok\n        expected: false\n'
    )
    const gated = await invoke(commands, 'run', [
      '--test', 'suites/nameless-red.yaml', '--advisory', 'menu,backend', '--reporter', 'console'
    ])
    expect(gated.code).toBe(1)
  })

  it('puts the split in the document a machine reads', async () => {
    const commands = await withZones()

    const asJson = await invoke(commands, 'run', ['--advisory', 'menu', '--json'])
    const document = JSON.parse(asJson.out)
    expect(asJson.code).toBe(1)
    expect(document.advisory).toMatchObject({ tags: ['menu'], tests: ['menu is red'], red: ['menu is red'] })
  })
})
