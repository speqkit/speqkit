import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from '@speqkit/test-kit'
import { definePlugin, type CommandHost, type RunEvent, type TestDef } from '@speqkit/plugin-api'
import cli from '@speqkit/plugin-cli'
import yaml from '@speqkit/plugin-yaml'
import gate from '@speqkit/plugin-gate'
import { GateReport } from '../src/report.js'

/**
 * What is worth pinning here is the routing and the grouping. Everything else
 * this plugin does is selection, and selection is one filter over what
 * `host.discover` already returns.
 */

let kit: Harness

afterEach(async () => {
  await kit?.close()
})

/**
 * A vocabulary with the three outcomes a gate has to tell apart: an answer
 * that is wrong, and a question that was never asked - twice for one reason,
 * and once for its own.
 */
const fixture = definePlugin({
  name: 'test-plugin-fixture',
  setup(ctx) {
    ctx.defineStepType('ok', { async execute() { return { ok: true } } })
    ctx.defineStepType('explode', {
      async execute(exec, input) {
        exec.record({ tried: input.as ?? 'something' })
        throw new Error(String(input.as ?? 'it broke'))
      }
    })
    ctx.defineAssertion('is-ok', {
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

async function project(config: Record<string, unknown> = {}): Promise<CommandHost> {
  kit = await harness(gate, { with: [cli, yaml, fixture], config: { gate: config }, artifacts: true })
  return kit.registry.service('cli') as CommandHost
}

/** What the command wrote, and what it exited with. */
async function invoke(commands: CommandHost, argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((s: string) => { out.push(String(s)); return true }) as typeof process.stdout.write
  process.stderr.write = ((s: string) => { err.push(String(s)); return true }) as typeof process.stderr.write
  try {
    const code = await commands.commands.get('gate')!.run(argv)
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

const test = (name: string, tags: string[], steps: unknown[]): TestDef =>
  ({ name, tags, steps: steps as TestDef['steps'] })

/** The document this run wrote, read back off disk the way a caller reads it. */
function gateFile(runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(kit.root, 'reports', runId, 'gate.json'), 'utf8'))
}

describe('whose fault a red run is', () => {
  it('separates a wrong answer from a question that was never asked', async () => {
    await project()
    const outcome = await kit.run([
      test('answers.wrongly', ['PAY-1'], [{ type: 'ok', assert: [{ type: 'is-ok', expected: false }] }]),
      test('cannot.ask.a', ['PAY-1'], [{ type: 'explode', as: 'connect ECONNREFUSED 127.0.0.1:8080' }]),
      test('cannot.ask.b', ['PAY-1'], [{ type: 'explode', as: 'connect ECONNREFUSED 127.0.0.1:8080' }]),
      test('alone', ['PAY-1'], [{ type: 'explode', as: 'template ${nope} is not defined' }])
    ], ['gate'])

    const document = gateFile(outcome.runId)
    const routed = Object.fromEntries(
      (document.tests as { name: string; fix: string }[]).map((row) => [row.name, row.fix])
    )

    // The answer came back and was wrong: the code is where the work is.
    expect(routed['answers.wrongly']).toBe('code')
    // Two tests broke identically, so the cause is in neither of them.
    expect(routed['cannot.ask.a']).toBe('environment')
    expect(routed['cannot.ask.b']).toBe('environment')
    // Nothing else hit this wall, so it belongs to the test that hit it.
    expect(routed['alone']).toBe('test')
    expect(document.blame).toEqual({ code: 1, test: 1, environment: 2 })
  })

  it('carries the evidence, so nothing has to be run twice to see it', async () => {
    await project()
    const outcome = await kit.run([
      test('answers.wrongly', ['PAY-1'], [{ id: 'one', type: 'ok', assert: [{ type: 'is-ok', expected: false }] }]),
      test('explodes', ['PAY-1'], [{ id: 'two', type: 'explode', as: 'the socket went away' }])
    ], ['gate'])

    const rows = gateFile(outcome.runId).tests as {
      name: string
      failures: { kind: string; expected?: unknown; actual?: unknown; detail?: unknown }[]
    }[]

    const wrong = rows.find((row) => row.name === 'answers.wrongly')!
    expect(wrong.failures.find((f) => f.kind === 'assertion')).toMatchObject({ expected: false, actual: true })

    const broke = rows.find((row) => row.name === 'explodes')!
    expect(broke.failures.find((f) => f.kind === 'step')?.detail).toEqual({ tried: 'the socket went away' })
  })

  it('says nothing about the tests that passed', async () => {
    await project()
    const outcome = await kit.run([test('green', ['PAY-1'], [{ type: 'ok' }])], ['gate'])

    const document = gateFile(outcome.runId)
    expect(document.status).toBe('passed')
    expect(document.tests).toEqual([])
    expect(document.blame).toEqual({ code: 0, test: 0, environment: 0 })
  })
})

describe('which piece of work is red', () => {
  it('groups by the tag that looks like a key, and counts each one', async () => {
    await project()
    const outcome = await kit.run([
      test('a', ['PAY-1', 'smoke'], [{ type: 'ok' }]),
      test('b', ['PAY-1'], [{ type: 'ok', assert: [{ type: 'is-ok', expected: false }] }]),
      test('c', ['PAY-2'], [{ type: 'ok' }]),
      test('d', ['smoke'], [{ type: 'ok' }])
    ], ['gate'])

    const document = gateFile(outcome.runId)
    expect(document.work).toEqual([
      { key: 'PAY-1', passed: 1, failed: 1, errored: 0, skipped: 0, status: 'failed' },
      { key: 'PAY-2', passed: 1, failed: 0, errored: 0, skipped: 0, status: 'passed' }
    ])
    // `smoke` is a label, not a key, so the test carrying only that one is a
    // test no gate would run - reported by name rather than counted.
    expect(document.unclaimed).toEqual(['d'])
  })

  it('takes the pattern from the project when the keys look like something else', async () => {
    await project({ pattern: '^rfc-[0-9]+$' })
    const outcome = await kit.run([
      test('a', ['rfc-7', 'PAY-1'], [{ type: 'ok' }])
    ], ['gate'])

    const work = gateFile(outcome.runId).work as { key: string }[]
    expect(work.map((entry) => entry.key)).toEqual(['rfc-7'])
  })
})

/**
 * Two suites at once interleave, and a reporter that groups by adjacency
 * reports one of them. This is the same fault M5 found in the JUnit reporter,
 * pinned here before it can be written a second time.
 */
describe('a report that does not depend on who finished first', () => {
  it('reads the same from an interleaved stream as from a sequential one', () => {
    const sequential: RunEvent[] = [
      { type: 'run.started', runId: 'r', tests: 2, at: 0 },
      { type: 'test.started', test: 'one', tags: ['PAY-1'] },
      { type: 'step.finished', test: 'one', stepType: 'ok', depth: 1, status: 'failed', durationMs: 1, message: 'no' },
      { type: 'test.finished', test: 'one', status: 'failed', durationMs: 1 },
      { type: 'test.started', test: 'two', tags: ['PAY-2'] },
      { type: 'step.finished', test: 'two', stepType: 'ok', depth: 1, status: 'passed', durationMs: 1 },
      { type: 'test.finished', test: 'two', status: 'passed', durationMs: 1 },
      { type: 'run.finished', runId: 'r', status: 'failed', passed: 1, failed: 1, errored: 0, skipped: 0, durationMs: 2 }
    ]
    const interleaved: RunEvent[] = [
      sequential[0]!, sequential[1]!, sequential[4]!, sequential[5]!, sequential[2]!,
      sequential[6]!, sequential[3]!, sequential[7]!
    ]

    const render = (events: RunEvent[]) => {
      const report = new GateReport()
      for (const event of events) report.on(event)
      return report.result({ pattern: /^[A-Z]+-[0-9]+$/ })
    }

    expect(render(interleaved)).toEqual(render(sequential))
    expect((render(interleaved).work as { key: string; failed: number }[])[0]).toMatchObject({
      key: 'PAY-1',
      failed: 1
    })
  })
})

describe('what would run, and why', () => {
  async function planned(config: Record<string, unknown>) {
    const commands = await project(config)
    kit.file('suites/pay.yaml', 'name: refunds\ntags: [PAY-114]\nsteps:\n  - type: ok\n')
    kit.file('suites/other.yaml', 'name: orders\ntags: [ORD-9]\nsteps:\n  - type: ok\n')
    kit.file('suites/loose.yaml', 'name: nobody owns me\nsteps:\n  - type: ok\n')
    return commands
  }

  it('names the key, where it came from, and what it did not select', async () => {
    const commands = await planned({ key: 'PAY-114' })

    const answer = await invoke(commands, ['plan'])
    expect(answer.code).toBe(0)
    expect(answer.out).toContain('key: PAY-114 (set in speq.yaml)')
    expect(answer.out).toContain('1 of 3 test(s) selected')
    expect(answer.out).toContain('refunds')
    expect(answer.out).toContain('1 test(s) carry another key')
    expect(answer.out).toContain('1 test(s) no gate would run')
    expect(answer.out).toContain('nobody owns me')
  })

  it('is a failure only where a team has said every test answers for something', async () => {
    const commands = await planned({ key: 'PAY-114' })

    expect((await invoke(commands, ['plan'])).code).toBe(0)
    expect((await invoke(commands, ['plan', '--strict'])).code).toBe(2)
  })

  it('answers a machine in the same terms', async () => {
    const commands = await planned({ key: 'PAY-114' })

    const answer = await invoke(commands, ['plan', '--json'])
    const document = JSON.parse(answer.out)
    expect(document).toMatchObject({ key: 'PAY-114', from: 'set in speq.yaml', tests: 3, elsewhere: 1 })
    expect(document.selected).toEqual([{ name: 'refunds', source: 'suites/pay.yaml', tags: ['PAY-114'] }])
    expect(document.unclaimed.map((t: { name: string }) => t.name)).toEqual(['nobody owns me'])
  })
})

describe('the gate', () => {
  it('runs this work and nobody else, and exits on the verdict', async () => {
    const commands = await project({ key: 'PAY-114' })
    kit.file('suites/pay.yaml', 'name: refunds\ntags: [PAY-114]\nsteps:\n  - type: ok\n    assert:\n      - type: is-ok\n        expected: false\n')
    kit.file('suites/other.yaml', 'name: orders\ntags: [ORD-9]\nsteps:\n  - type: ok\n')

    const answer = await invoke(commands, ['--json'])
    expect(answer.code).toBe(1)

    const document = JSON.parse(answer.out)
    expect(document.key).toBe('PAY-114')
    expect(document.counts).toMatchObject({ passed: 0, failed: 1 })
    expect((document.tests as { name: string }[]).map((t) => t.name)).toEqual(['refunds'])
    // The other ticket's test was never started, so it is in no count at all.
    expect(document.unclaimed).toEqual([])
  })

  it('refuses rather than guessing when nothing says which work this is', async () => {
    const commands = await project({ branch: false })
    kit.file('suites/pay.yaml', 'name: refunds\ntags: [PAY-114]\nsteps:\n  - type: ok\n')

    const answer = await invoke(commands, [])
    expect(answer.code).toBe(2)
    expect(answer.err).toContain('nothing says which work this is')
  })

  it('says a key selected nothing rather than passing an empty run', async () => {
    const commands = await project({ key: 'PAY-999' })
    kit.file('suites/pay.yaml', 'name: refunds\ntags: [PAY-114]\nsteps:\n  - type: ok\n')

    const answer = await invoke(commands, [])
    expect(answer.code).toBe(2)
    expect(answer.err).toContain('no test is tagged PAY-999')
  })
})

describe('the branch is usually the answer', () => {
  const run = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })

  it('takes the key out of the branch name, wherever in it the key is', async () => {
    const commands = await project()
    kit.file('suites/pay.yaml', 'name: refunds\ntags: [PAY-114]\nsteps:\n  - type: ok\n')
    run(['init', '-q'], kit.root)
    // Set without checking anything out: a repository with no commits still
    // has a branch, and this is the state somebody trying speq is in.
    run(['symbolic-ref', 'HEAD', 'refs/heads/feature/PAY-114-partial-refunds'], kit.root)

    const answer = await invoke(commands, ['plan'])
    expect(answer.out).toContain("key: PAY-114 (from the branch 'feature/PAY-114-partial-refunds')")
    expect(answer.out).toContain('1 of 1 test(s) selected')
  })

  it('has no key on a detached HEAD, which is how CI checks out a pull request', async () => {
    const commands = await project()
    kit.file('suites/pay.yaml', 'name: refunds\ntags: [PAY-114]\nsteps:\n  - type: ok\n')
    run(['init', '-q'], kit.root)
    run(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one'], kit.root)
    run(['checkout', '-q', '--detach', 'HEAD'], kit.root)

    const answer = await invoke(commands, ['plan'])
    expect(answer.out).toContain('no key')
    expect(answer.code).toBe(0)
  })
})

describe('what this branch did to the acceptance tests', () => {
  const git = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'
    })

  it('names the files added, changed and removed against the base', async () => {
    const commands = await project({ key: 'PAY-114' })
    kit.file('suites/kept.yaml', 'name: kept\ntags: [PAY-1]\nsteps:\n  - type: ok\n')
    kit.file('suites/doomed.yaml', 'name: doomed\ntags: [PAY-1]\nsteps:\n  - type: ok\n')

    git(['init', '-q'], kit.root)
    git(['add', '-A'], kit.root)
    git(['commit', '-q', '-m', 'the criteria as agreed'], kit.root)
    const base = git(['rev-parse', 'HEAD'], kit.root).trim()

    kit.file('suites/added.yaml', 'name: added later\ntags: [PAY-114]\nsteps:\n  - type: ok\n')
    kit.file('suites/kept.yaml', 'name: kept\ntags: [PAY-1]\nsteps:\n  - type: ok\n  - type: ok\n')
    git(['rm', '-q', 'suites/doomed.yaml'], kit.root)
    git(['add', '-A'], kit.root)
    git(['commit', '-q', '-m', 'and what the implementer thought of them'], kit.root)

    const answer = await invoke(commands, ['diff', '--base', base, '--json'])
    expect(answer.code).toBe(0)

    const document = JSON.parse(answer.out)
    // A file that still exists is named by the tests inside it, because a
    // reviewer reads names; a file that is gone has none left to read.
    expect(document.added).toEqual({ 'suites/added.yaml': ['added later'] })
    expect(document.changed).toEqual({ 'suites/kept.yaml': ['kept'] })
    expect(document.removed).toEqual(['suites/doomed.yaml'])
  })

  it('says so plainly when the base is not a ref this repository has', async () => {
    const commands = await project({ key: 'PAY-114' })
    git(['init', '-q'], kit.root)

    const answer = await invoke(commands, ['diff', '--base', 'origin/nowhere'])
    expect(answer.code).toBe(2)
    expect(answer.err).toContain("cannot compare against 'origin/nowhere'")
  })
})
