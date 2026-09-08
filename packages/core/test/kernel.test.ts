import { describe, expect, it } from 'vitest'
import {
  ASSERTION_CODES, STEP_CODES, TEST_CODES, definePlugin,
  type ResourceScope, type RunEvent, type StepDef
} from '@speqkit/plugin-api'
import { Registry, ResourceManager, runTests, validateTests } from 'speqkit'

/**
 * These are architecture tests, not feature tests. Each one pins an invariant
 * that the whole design rests on; if one of them starts failing, the spine has
 * moved and the fix belongs in the kernel, not in the test.
 */

async function registryWith(...plugins: Parameters<Registry['register']>[0][]) {
  const registry = new Registry()
  for (const plugin of plugins) await registry.register(plugin)
  registry.settle()
  return registry
}

const echo = definePlugin({
  name: 'echo',
  setup(ctx) {
    ctx.defineStepType('echo', {
      execute: (_exec, input) => ({ value: input.value })
    })
    ctx.defineAssertion('equals', {
      evaluate: (assert, input) => ({
        passed: assert.last?.value === input.expected,
        message: `got ${String(assert.last?.value)}`
      })
    })
  }
})

const looper = definePlugin({
  name: 'looper',
  setup(ctx) {
    ctx.defineStepType('loop', {
      async execute(exec, input) {
        const seen: unknown[] = []
        for (const item of input.over as unknown[]) {
          const records = await exec.runSteps(input.steps as StepDef[], { vars: { item } })
          seen.push(records.map((r) => r.result))
        }
        return { iterations: seen.length, seen }
      }
    })
  }
})

describe('the kernel knows nothing about any protocol', () => {
  it('runs a step type it has never heard of, contributed at load time', async () => {
    const registry = await registryWith(echo)
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ id: 'a', type: 'echo', value: 'hello' }], assert: [{ type: 'equals', expected: 'hello' }] }
    ])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result).toEqual({ value: 'hello' })
  })

  it('refuses to run a step type nobody registered, and says what exists', async () => {
    const registry = await registryWith(echo)
    const outcome = await runTests(registry, [{ name: 't', steps: [{ type: 'grpc' }] }])
    expect(outcome.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.message).toContain("unknown step type 'grpc'")
    expect(outcome.tests[0]!.steps[0]!.message).toContain('echo')
  })
})

describe('control flow is expressible as a plugin', () => {
  // The single most important test in the repository: if this stops passing,
  // control flow has to move into the kernel and the plugin model is a lie.
  it('nests steps, resolves the child variable, and binds the parent result', async () => {
    const registry = await registryWith(echo, looper)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [
          { id: 'l', type: 'loop', over: ['a', 'b'], steps: [{ id: 'inner', type: 'echo', value: '${item}' }] },
          { id: 'after', type: 'echo', value: '${l.iterations}' }
        ],
        // A whole-string template keeps the resolved value's type: this is
        // the number 2, not the string '2'.
        assert: [{ type: 'equals', expected: 2 }]
      }
    ])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result.seen).toEqual([[{ value: 'a' }], [{ value: 'b' }]])
  })

  it('does not leak the child scope back to the parent', async () => {
    const registry = await registryWith(echo, looper)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [
          { id: 'l', type: 'loop', over: ['a'], steps: [{ id: 'inner', type: 'echo', value: '${item}' }] },
          { id: 'leak', type: 'echo', value: '${item}' }
        ]
      }
    ])
    expect(outcome.tests[0]!.steps[1]!.status).toBe('error')
    expect(outcome.tests[0]!.steps[1]!.message).toContain("'item' is not defined")
  })
})

describe('an assertion can see what the steps produced', () => {
  // The contract promises `results` is every step result so far, and the
  // authoring format lets an assertion say `${id.field}`. Both are read after
  // the last step has finished, which is the moment the bindings used to be
  // discarded — so both were broken, in the one place no other test looked.
  const spy = definePlugin({
    name: 'spy',
    setup(ctx) {
      ctx.defineAssertion('sees', {
        evaluate: (assert, input) => ({
          passed: input.expected === input.actual,
          message: `results: ${Object.keys(assert.results).sort().join(',') || '(none)'}`
        })
      })
    }
  })

  it('resolves a step id in an assertion, after every step has finished', async () => {
    const registry = await registryWith(echo, spy)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [{ id: 'a', type: 'echo', value: 'hello' }],
        assert: [{ type: 'sees', expected: 'hello', actual: '${a.value}' }]
      }
    ])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.assertions[0]!.message).toBe('results: a')
  })

  it('keeps the parent binding while hiding the child scope', async () => {
    const registry = await registryWith(echo, looper, spy)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [{ id: 'l', type: 'loop', over: ['a'], steps: [{ id: 'inner', type: 'echo', value: '${item}' }] }],
        assert: [{ type: 'sees', expected: 1, actual: '${l.iterations}' }]
      }
    ])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.assertions[0]!.message).toBe('results: l')
  })
})

describe('a path says which elements it means, and stops when there are none', () => {
  /**
   * The wildcard is on the contract, so this is the kernel's half of it: what
   * `${…}` does with `[*]`, and what it says when the thing it was told to
   * take each of is not a list. The other half — the same four rules inside an
   * assertion's `path:` — is pinned in `@speqkit/plugin-assert`, against the
   * same reader.
   */
  const snapshot = {
    categories: [
      { items: [{ sku: 'a' }, { sku: 'b' }] },
      { items: [{ sku: 'c' }] }
    ],
    restaurant: { id: 'r-1' }
  }

  it('reads every element, and flattens one level for each wildcard', async () => {
    const registry = await registryWith(echo)
    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { snapshot },
        steps: [
          { id: 'flat', type: 'echo', value: '${snapshot.categories[*].items[*].sku}' },
          { id: 'nested', type: 'echo', value: '${snapshot.categories[*].items}' }
        ]
      }
    ])

    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result.value).toEqual(['a', 'b', 'c'])
    expect((outcome.tests[0]!.steps[1]!.result.value as unknown[]).length).toBe(2)
  })

  it('refuses to read a wildcard over something that is not a list', async () => {
    const registry = await registryWith(echo)
    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { snapshot },
        steps: [{ id: 'oops', type: 'echo', value: '${snapshot.restaurant[*].id}' }]
      }
    ])

    // `error`, not `failed`: a reference that cannot be read is the suite
    // being wrong about itself, not the system under test being wrong.
    expect(outcome.status).toBe('error')
    // And not "is not defined": nothing is misspelled, and sending the author
    // looking for a typo in a name that is right is the worse of the two.
    expect(outcome.tests[0]!.steps[0]!.message).toContain("'[*]' means every element")
    expect(outcome.tests[0]!.steps[0]!.message).toContain("'restaurant' is not a list")
  })

  it('answers an empty list where nothing has the field, which is an answer', async () => {
    const registry = await registryWith(echo)
    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { snapshot: { categories: [] } },
        steps: [{ id: 'none', type: 'echo', value: '${snapshot.categories[*].items[*].sku}' }]
      }
    ])

    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result.value).toEqual([])
  })
})

describe('resources close in reverse order when their scope ends', () => {
  it('opens a run-scoped resource once and a test-scoped one per test', async () => {
    const log: string[] = []
    const plugin = definePlugin({
      name: 'res',
      setup(ctx) {
        ctx.defineResource('browser', {
          scope: 'run',
          setup: () => { log.push('browser up'); return 'B' },
          teardown: () => { log.push('browser down') }
        })
        ctx.defineResource('page', {
          scope: 'test',
          setup: () => { log.push('page up'); return 'P' },
          teardown: () => { log.push('page down') }
        })
        ctx.defineStepType('visit', {
          async execute(exec) {
            await exec.resource('browser')
            await exec.resource('page')
            return {}
          }
        })
      }
    })
    const registry = await registryWith(plugin)
    await runTests(registry, [
      { name: 'one', steps: [{ type: 'visit' }] },
      { name: 'two', steps: [{ type: 'visit' }] }
    ])
    expect(log).toEqual([
      'browser up', 'page up', 'page down',
      'page up', 'page down',
      'browser down'
    ])
  })
})

describe('a resource frame belongs to whoever opened it', () => {
  const configFor = () => ({})

  /**
   * One resource, a counter, and a log of what went up and what came down.
   * `slowMs` is the whole point of the first test: the fault these pin is a
   * window the length of `setup`, and a setup that returns immediately has
   * no window to race in.
   */
  function counting(log: string[], scope: ResourceScope, slowMs = 0) {
    const resources = new ResourceManager()
    let issued = 0
    resources.define('conn', 'res', {
      scope,
      setup: async () => {
        const id = ++issued
        log.push(`up ${id}`)
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs))
        return id
      },
      teardown: (value) => { log.push(`down ${String(value)}`) }
    })
    return resources
  }

  it('hands one value to everyone who asks at the same moment', async () => {
    const log: string[] = []
    const run = counting(log, 'suite', 20).open('run')
    const suite = run.open('suite')

    // Two tests of one suite, both asking before either answer arrives. The
    // cache used to hold the resolved value, so both found it empty, both ran
    // `setup`, and the second overwrote the first: one resource leaked and
    // the other was torn down twice.
    const [first, second] = await Promise.all([
      suite.open('test').acquire('conn', configFor),
      suite.open('test').acquire('conn', configFor)
    ])

    expect(first).toBe(second)
    await suite.close(configFor)
    expect(log).toEqual(['up 1', 'down 1'])
  })

  it('gives each suite its own, and takes each one down once', async () => {
    const log: string[] = []
    const run = counting(log, 'suite', 20).open('run')
    const one = run.open('suite')
    const two = run.open('suite')

    const values = await Promise.all([
      one.acquire('conn', configFor),
      two.acquire('conn', configFor)
    ])
    expect(new Set(values).size).toBe(2)

    await Promise.all([one.close(configFor), two.close(configFor)])
    expect(log.filter((l) => l.startsWith('down')).sort()).toEqual(['down 1', 'down 2'])
  })

  it('closes the frame it was told to, not the innermost one', async () => {
    const log: string[] = []
    const run = counting(log, 'test').open('run')
    const here = run.open('suite').open('test')
    const there = run.open('suite').open('test')

    expect(await here.acquire('conn', configFor)).toBe(1)
    expect(await there.acquire('conn', configFor)).toBe(2)

    // The frames were one stack, so this popped whichever was opened last —
    // `there`. The suite that was still running then acquired a second time,
    // and its teardown ran against a scope that had already ended.
    await here.close(configFor)
    expect(await there.acquire('conn', configFor)).toBe(2)

    await there.close(configFor)
    expect(log).toEqual(['up 1', 'up 2', 'down 1', 'down 2'])
  })

  it('does not tear down, or retry, a setup that never succeeded', async () => {
    const log: string[] = []
    const resources = new ResourceManager()
    let attempts = 0
    resources.define('conn', 'res', {
      scope: 'test',
      setup: () => { attempts += 1; throw new Error('no route to host') },
      teardown: () => { log.push('down') }
    })

    const frame = resources.open('run').open('suite').open('test')
    await expect(frame.acquire('conn', configFor)).rejects.toThrow('no route to host')
    await expect(frame.acquire('conn', configFor)).rejects.toThrow('no route to host')

    await frame.close(configFor)
    expect(attempts).toBe(1)
    expect(log).toEqual([])
  })

  it('refuses to set anything up in a scope that has ended', async () => {
    const log: string[] = []
    const frame = counting(log, 'test').open('run').open('suite').open('test')
    await frame.close(configFor)
    await expect(frame.acquire('conn', configFor)).rejects.toThrow(
      "resource 'conn' was asked for after its 'test' scope closed"
    )
  })
})

describe('what a step ran underneath itself is part of what it reports', () => {
  /**
   * `StepRecord.children` was on the contract from the first commit and
   * nothing ever filled it. A step that failed inside a loop was in the event
   * stream and nowhere in the `TestOutcome` — which is what `run --json`
   * hands a caller, and what a repair loop reads. The seventh dead mechanism
   * of the same kind, after `defineReporter`, `attach`, `AssertContext.results`,
   * `tags`, `configSchema` and the schema keywords.
   */
  it('carries the nested records, iteration by iteration', async () => {
    const registry = await registryWith(echo, looper)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [{ id: 'l', type: 'loop', over: [1, 2], steps: [{ id: 'in', type: 'echo', value: '${item}' }] }]
      }
    ])

    const loop = outcome.tests[0]!.steps[0]!
    expect(loop.children?.map((c) => c.result)).toEqual([{ value: 1 }, { value: 2 }])
  })

  it('keeps them on a step that threw, because what it did first is the evidence', async () => {
    const thrower = definePlugin({
      name: 'thrower',
      setup(ctx) {
        ctx.defineStepType('half', {
          async execute(exec, input) {
            await exec.runSteps(input.steps as StepDef[])
            throw new Error('and then it went wrong')
          }
        })
      }
    })
    const registry = await registryWith(echo, thrower)
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ type: 'half', steps: [{ id: 'in', type: 'echo', value: 'done' }] }] }
    ])

    expect(outcome.tests[0]!.steps[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.children?.map((c) => c.status)).toEqual(['passed'])
  })
})

describe('a test is the atomic unit', () => {
  const branching = definePlugin({
    name: 'branching',
    setup(ctx) {
      ctx.defineStepType('both', {
        async execute(exec, input) {
          const [left, right] = input.steps as StepDef[]
          const branches = await Promise.all([exec.runSteps([left!]), exec.runSteps([right!])])
          return { branches: branches.map((b) => b.map((r) => r.result)) }
        }
      })
    }
  })

  it('refuses a step type that runs two branches at once, and says why', async () => {
    const registry = await registryWith(echo, branching)
    const outcome = await runTests(registry, [{
      name: 'two branches',
      steps: [{
        type: 'both',
        steps: [{ id: 'l', type: 'echo', value: 'left' }, { id: 'r', type: 'echo', value: 'right' }]
      }]
    }])

    // It used to answer, and answer wrongly: both branches shared one frame
    // stack, so this returned the same branch twice and the step passed.
    expect(outcome.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.message).toContain(
      "step type 'both' called runSteps while its own nested steps were still running"
    )
    expect(outcome.tests[0]!.steps[0]!.message).toContain('concurrency lives between suites')
  })

  it('leaves nesting alone, which is what runSteps is for', async () => {
    const registry = await registryWith(echo, looper)
    const outcome = await runTests(registry, [{
      name: 'a loop inside a loop',
      steps: [{
        id: 'outer',
        type: 'loop',
        over: [1, 2],
        steps: [{ id: 'inner', type: 'loop', over: ['a', 'b'], steps: [{ type: 'echo', value: '${item}' }] }]
      }]
    }])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result.iterations).toBe(2)
  })
})

describe('a hook knows which suite it is firing in', () => {
  it('names the suite on every hook that has one', async () => {
    const seen: string[] = []
    const watcher = definePlugin({
      name: 'watcher',
      setup(ctx) {
        for (const name of ['suite:before', 'test:before', 'step:before', 'step:after', 'test:after', 'suite:after'] as const) {
          ctx.defineHook(name, (payload) => { seen.push(`${name} ${payload.suite ?? 'nowhere'}`) })
        }
      }
    })

    const registry = await registryWith(echo, watcher)
    await runTests(registry, [
      { name: 'one', source: 'suites/a.yaml', steps: [{ type: 'echo', value: 1 }] },
      { name: 'two', source: 'suites/b.yaml', steps: [{ type: 'echo', value: 2 }] }
    ])

    // `HookPayload.suite` was declared from the first commit and populated
    // only for `suite:before` and `suite:after`. The other four are the ones a
    // hook holding per-suite state actually fires on, and under concurrency the
    // same function is called by two suites at once.
    expect(seen).toEqual([
      'suite:before suites/a.yaml',
      'test:before suites/a.yaml',
      'step:before suites/a.yaml',
      'step:after suites/a.yaml',
      'test:after suites/a.yaml',
      'suite:after suites/a.yaml',
      'suite:before suites/b.yaml',
      'test:before suites/b.yaml',
      'step:before suites/b.yaml',
      'step:after suites/b.yaml',
      'test:after suites/b.yaml',
      'suite:after suites/b.yaml'
    ])
  })
})

describe('suites are what run at once', () => {
  /** A step that says when it started and when it stopped. */
  function timed(order: string[]) {
    return definePlugin({
      name: 'timed',
      setup(ctx) {
        ctx.defineStepType('wait', {
          async execute(_exec, input) {
            const tag = String(input.tag)
            order.push(`${tag} start`)
            await new Promise((r) => setTimeout(r, Number(input.ms)))
            order.push(`${tag} end`)
            return { tag }
          }
        })
      }
    })
  }

  const suites = [
    { name: 'slow', source: 'suites/slow.yaml', steps: [{ type: 'wait', tag: 'slow', ms: 40 }] },
    { name: 'quick', source: 'suites/quick.yaml', steps: [{ type: 'wait', tag: 'quick', ms: 5 }] }
  ]

  it('runs one suite at a time unless asked otherwise', async () => {
    const order: string[] = []
    const registry = await registryWith(timed(order))
    await runTests(registry, suites)
    expect(order).toEqual(['slow start', 'slow end', 'quick start', 'quick end'])
  })

  it('overlaps two suites when asked, and the quick one does not wait', async () => {
    const order: string[] = []
    const registry = await registryWith(timed(order))
    await runTests(registry, suites, { concurrency: 2 })
    expect(order).toEqual(['slow start', 'quick start', 'quick end', 'slow end'])
  })

  it('reports them in the order they were discovered, not the order they finished', async () => {
    const order: string[] = []
    const registry = await registryWith(timed(order))
    const outcome = await runTests(registry, suites, { concurrency: 2 })

    // `outcomes.push(await …)` would have put 'quick' first, so the same two
    // suites produced a different report on every run. A report is not the
    // event log: the log is chronological because it records what happened,
    // and the report is addressed by name.
    expect(outcome.tests.map((t) => t.name)).toEqual(['slow', 'quick'])
    expect(outcome.passed).toBe(2)
  })

  it('keeps each suite in order while the two of them interleave', async () => {
    const order: string[] = []
    const registry = await registryWith(timed(order))
    const seen: string[] = []
    registry.events.subscribe((e) => {
      if (e.type === 'suite.started') seen.push(`${e.suite} open`)
      if (e.type === 'test.started') seen.push(`${e.test} test`)
      if (e.type === 'suite.finished') seen.push(`${e.suite} shut`)
    })
    await runTests(registry, suites, { concurrency: 2 })

    // G4: different suites interleave, one suite does not. Whatever order the
    // four groups arrive in, each suite's three events keep theirs.
    const slow = seen.filter((s) => s.includes('slow'))
    const quick = seen.filter((s) => s.includes('quick'))
    expect(slow).toEqual(['suites/slow.yaml open', 'slow test', 'suites/slow.yaml shut'])
    expect(quick).toEqual(['suites/quick.yaml open', 'quick test', 'suites/quick.yaml shut'])
    expect(seen.indexOf('suites/quick.yaml open')).toBeLessThan(seen.indexOf('suites/slow.yaml shut'))
  })

  it('gives a failed suite its slot back instead of stopping the run', async () => {
    const order: string[] = []
    const registry = await registryWith(echo, timed(order))
    const outcome = await runTests(registry, [
      { name: 'breaks', source: 'suites/a.yaml', steps: [{ type: 'nope' }] },
      { name: 'runs', source: 'suites/b.yaml', steps: [{ type: 'echo', value: 1 }] },
      { name: 'also runs', source: 'suites/c.yaml', steps: [{ type: 'echo', value: 2 }] }
    ], { concurrency: 2 })

    expect(outcome.errored).toBe(1)
    expect(outcome.passed).toBe(2)
    expect(outcome.tests.map((t) => t.name)).toEqual(['breaks', 'runs', 'also runs'])
  })
})

describe('a plugin contributes to a surface that may not be loaded', () => {
  const contributor = definePlugin({
    name: 'contributor',
    setup(ctx) {
      ctx.inject(['cli'], (resolved) => {
        (resolved.cli as { register(n: string): void }).register('seed')
      })
    }
  })

  it('registers the command when the surface is there', async () => {
    const registered: string[] = []
    const surface = definePlugin({
      name: 'surface',
      setup: (ctx) => ctx.provide('cli', { register: (n: string) => registered.push(n) })
    })
    await registryWith(surface, contributor)
    expect(registered).toEqual(['seed'])
  })

  it('stays perfectly usable when nobody provides it', async () => {
    await expect(registryWith(contributor)).resolves.toBeDefined()
  })
})

describe('the kernel protects its own contracts', () => {
  it('refuses two plugins claiming the same step type', async () => {
    const other = definePlugin({
      name: 'other',
      setup: (ctx) => ctx.defineStepType('echo', { execute: () => ({}) })
    })
    await expect(registryWith(echo, other)).rejects.toThrow(/already provided by plugin 'echo'/)
  })

  it('refuses a plugin built against a different plugin-api major', async () => {
    const future = definePlugin({ name: 'future', apiVersion: 2, setup: () => {} })
    await expect(registryWith(future)).rejects.toThrow(/targets @speqkit\/plugin-api v2/)
  })

  it('reports a plugin crash as error, not as a failed test', async () => {
    const boom = definePlugin({
      name: 'boom',
      setup: (ctx) => ctx.defineStepType('boom', {
        execute: () => { throw new Error('driver exploded') }
      })
    })
    const registry = await registryWith(boom)
    const outcome = await runTests(registry, [{ name: 't', steps: [{ type: 'boom' }] }])
    expect(outcome.status).toBe('error')
    expect(outcome.errored).toBe(1)
    expect(outcome.failed).toBe(0)
  })
})

describe('validation uses the grammar the plugins defined', () => {
  it('names the unknown type and suggests the near miss', async () => {
    const registry = await registryWith(echo)
    const diagnostics = validateTests(registry, [
      { name: 't', steps: [{ type: 'ehco' }], assert: [], source: 'a.yaml' }
    ])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.hint).toContain("did you mean 'echo'")
  })

  it('catches a duplicate step id, including inside nested steps', async () => {
    const registry = await registryWith(echo)
    const diagnostics = validateTests(registry, [
      {
        name: 't',
        source: 'a.yaml',
        steps: [
          { id: 'x', type: 'echo' },
          { id: 'y', type: 'echo', steps: [{ id: 'x', type: 'echo' }] }
        ]
      }
    ])
    expect(diagnostics.some((d) => d.message.includes("duplicate step id 'x'"))).toBe(true)
  })

  it('catches two tests sharing a name, and says where the first one is', async () => {
    const registry = await registryWith(echo)
    const diagnostics = validateTests(registry, [
      { name: 'orders.create', source: 'a.yaml', steps: [{ type: 'echo' }] },
      { name: 'orders.create', source: 'b.yaml', steps: [{ type: 'echo' }] }
    ])

    // Every event a run emits is keyed by the name, and nothing checked it was
    // unique: two tests sharing one produced a report where the second
    // overwrote the first, with no sign that anything had been lost.
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ file: 'b.yaml', path: 'name' })
    expect(diagnostics[0]!.message).toBe("duplicate test name 'orders.create'")
    expect(diagnostics[0]!.hint).toContain('a.yaml')
  })

  it('reports the same name in one file too, since a file holds many tests', async () => {
    const registry = await registryWith(echo)
    const diagnostics = validateTests(registry, [
      { name: 't', source: 'a.yaml', steps: [{ type: 'echo' }] },
      { name: 't', source: 'a.yaml', steps: [{ type: 'echo' }] }
    ])

    expect(diagnostics[0]!.hint).toContain('in this file')
  })
})

/**
 * The shape of an input, read against the whole schema and not two words of it.
 *
 * `InputSchema` had been JSON-Schema-shaped since the first commit, and the
 * kernel read `required` and `additionalProperties: false` — enough to catch
 * `bodyRaw:` for `body:`, and not `method: GETT`, `attempts: "3"`, or a typo
 * one level down in `retry:`, because a nested mapping was never opened and
 * a type was never compared. All of those went out on the wire.
 */
describe('an input is checked against the shape its schema declares', () => {
  const shaped = definePlugin({
    name: 'shaped',
    setup(ctx) {
      ctx.defineStepType('ship', {
        schema: {
          type: 'object',
          properties: {
            to: { type: 'string', minLength: 1 },
            method: { type: 'string', enum: ['air', 'sea'] },
            weight: { type: 'number', minimum: 0, maximum: 100 },
            count: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
            options: {
              type: 'object',
              properties: { insured: { type: 'boolean' }, note: { type: 'string' } },
              additionalProperties: false
            },
            parts: {
              type: 'object',
              additionalProperties: {
                anyOf: [{ type: 'string' }, { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false }]
              }
            },
            ref: { type: 'string', pattern: '^REF-[0-9]+$' }
          },
          required: ['to'],
          additionalProperties: false
        },
        execute: () => ({})
      })
      ctx.defineAssertion('arrived', {
        schema: { type: 'object', properties: { within: { type: 'number' } }, additionalProperties: false },
        evaluate: () => ({ passed: true, message: 'arrived' })
      })
      ctx.defineValueProvider('vars', { prefix: 'vars', resolve: () => 1 })
    }
  })

  const check = async (step: Record<string, unknown>) => {
    const registry = await registryWith(shaped)
    return validateTests(registry, [{ name: 't', source: 't.yaml', steps: [{ type: 'ship', to: 'x', ...step }] }])
      .map((d) => [d.code, d.path, d.message])
  }

  it('reads a type, an enum and a bound', async () => {
    expect(await check({ method: 'rail' })).toEqual([
      ['invalid-value', 'steps[0].method', "method is 'rail', not one of 'air', 'sea'"]
    ])
    expect(await check({ weight: '12' })).toEqual([['invalid-value', 'steps[0].weight', "weight is '12', not a number"]])
    expect(await check({ weight: 101 })).toEqual([['invalid-value', 'steps[0].weight', 'weight is 101, above the maximum of 100']])
    expect(await check({ count: 1.5 })).toEqual([['invalid-value', 'steps[0].count', 'count is 1.5, not a whole number']])
    expect(await check({ ref: 'REF-x' })).toEqual([
      ['invalid-value', 'steps[0].ref', "ref is 'REF-x', which does not match /^REF-[0-9]+$/"]
    ])
    expect(await check({ tags: ['a', 2, 'c'] })).toEqual([
      ['invalid-value', 'steps[0].tags', 'tags has 3 item(s), more than 2'],
      ['invalid-value', 'steps[0].tags[1]', 'tags[1] is 2, not a string']
    ])
  })

  it('opens a nested mapping, which is where the typo that mattered was', async () => {
    expect(await check({ options: { insurred: true, note: 3 } })).toEqual([
      ['invalid-value', 'steps[0].options.note', 'options.note is 3, not a string'],
      ['unknown-field', 'steps[0].options', "unknown field 'options.insurred' — did you mean 'insured'?"]
    ])
  })

  it('names the branch that was meant when a value may take several shapes', async () => {
    expect(await check({ parts: { doc: 'plain', pic: { file: 'a.png', filenam: 'b' } } })).toEqual([
      ['unknown-field', 'steps[0].parts.pic', "unknown field 'parts.pic.filenam' — available: file"]
    ])
    expect(await check({ parts: { doc: 7 } })).toEqual([
      ['invalid-value', 'steps[0].parts.doc', 'parts.doc is 7, which matches none of the 2 shapes it may take']
    ])
  })

  it('reads a whole-template value as fitting any shape, and a template inside a string as a string', async () => {
    expect(await check({ weight: '${vars:kg}', method: '${mode}', count: '${n}' })).toEqual([
      ['unresolved-reference', 'steps[0].method', "${mode}: 'mode' is not defined here"],
      ['unresolved-reference', 'steps[0].count', "${n}: 'n' is not defined here"]
    ])
    expect(await check({ weight: '${vars:kg} kg' })).toEqual([
      ['invalid-value', 'steps[0].weight', "weight is '${vars:kg} kg', not a number"]
    ])
  })

  it('keeps the kernel\'s own keys on a step, and only those on an assertion', async () => {
    const registry = await registryWith(shaped)
    const diagnostics = validateTests(registry, [{
      name: 't',
      source: 't.yaml',
      steps: [{ id: 'a', type: 'ship', to: 'x', timeout: 5, meta: { owner: 'me' }, assert: [{ type: 'arrived', within: 3, id: 'no', meta: {} }] }]
    }])

    expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['unknown-field', 'steps[0].assert[0]', "unknown field 'id' — available: meta, type, within"]
    ])
  })
})

/**
 * The joins, read before the run.
 *
 * Validation stopped at the words — a step type, its fields — and a test whose
 * every word was right could still name a step that runs below it, a given
 * that was never declared, or a `${env:…}` in a project with nothing loaded
 * to answer it. All three were found out as an errored step in the middle of
 * a run, and a model writing a suite gets exactly those wrong more often than
 * it misspells `http`. The kernel knows every name a test binds itself, so a
 * reference to none of them is a diagnostic; what a nesting step binds for
 * the steps under it is the plugin's to declare, and one that declares
 * nothing is not second-guessed.
 */
describe('a reference is checked against what the test binds', () => {
  const nesting = definePlugin({
    name: 'nesting',
    setup(ctx) {
      ctx.defineStepType('each', {
        binds: (step) => [String(step.as ?? 'item')],
        execute: async (exec, input) => {
          await exec.runSteps((input.steps as StepDef[]) ?? [], { vars: { [String(input.as ?? 'item')]: 1 } })
          return {}
        }
      })
      ctx.defineStepType('opaque', {
        execute: async (exec, input) => {
          await exec.runSteps((input.steps as StepDef[]) ?? [], { vars: { whatever: 1 } })
          return {}
        }
      })
      ctx.defineValueProvider('secrets', { prefix: 'vault', resolve: () => 'shh' })
    }
  })

  const test = (fields: Partial<Parameters<typeof validateTests>[1][number]>) =>
    ({ name: 't', source: 't.yaml', steps: [{ type: 'echo' }], ...fields })

  it('lets a step read a given, a step above it, and itself from its own assertions', async () => {
    const registry = await registryWith(echo, nesting)
    const diagnostics = validateTests(registry, [test({
      variables: { base: 'x', derived: '${base}/y' },
      setup: [{ id: 'made', type: 'echo', value: '${derived}' }],
      steps: [
        { id: 'a', type: 'echo', value: '${made.value}', assert: [{ type: 'equals', expected: '${a.value}' }] },
        { id: 'b', type: 'echo', value: '${a.value} ${vault:token} ${meta:owner}' }
      ],
      assert: [{ type: 'equals', expected: '${b.value}' }],
      cleanup: [{ type: 'echo', value: '${a.value} ${b.value}' }]
    })])

    expect(diagnostics).toEqual([])
  })

  it('refuses a name nothing binds, and says what is bound', async () => {
    const registry = await registryWith(echo)
    const diagnostics = validateTests(registry, [test({
      variables: { base: 'x' },
      steps: [{ id: 'a', type: 'echo', value: '${bsae}/${nowhere.at.all}' }]
    })])

    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['unresolved-reference', 'steps[0].value'],
      ['unresolved-reference', 'steps[0].value']
    ])
    expect(diagnostics[0]!.message).toBe("${bsae}: 'bsae' is not defined here")
    expect(diagnostics[0]!.hint).toBe("did you mean 'base'?")
    expect(diagnostics[1]!.hint).toBe('defined here: base')
  })

  it('tells a step below from a name that is nowhere', async () => {
    const registry = await registryWith(echo)
    const diagnostics = validateTests(registry, [test({
      steps: [
        { id: 'a', type: 'echo', value: '${b.value}' },
        { id: 'b', type: 'echo', value: '${b.value}' }
      ]
    })])

    expect(diagnostics.map((d) => d.code)).toEqual(['forward-reference', 'forward-reference'])
    expect(diagnostics[0]!.message).toContain("names step 'b', which runs after this")
    expect(diagnostics[1]!.message).toContain("names this step's own result")
  })

  it('reads a given in declaration order, one at a time', async () => {
    const registry = await registryWith(echo)
    const diagnostics = validateTests(registry, [test({
      variables: { derived: '${base}/y', base: 'x' }
    })])

    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([['unresolved-reference', 'variables.derived']])
  })

  it('refuses a prefix nothing loaded claims, wherever it is written', async () => {
    const registry = await registryWith(echo, nesting)
    const diagnostics = validateTests(registry, [test({
      variables: { token: '${env:TOKEN}' },
      steps: [{ type: 'opaque', steps: [{ type: 'echo', value: '${gen:uuid} ${vault:ok}' }] }]
    })])

    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['unknown-provider', 'variables.token'],
      ['unknown-provider', 'steps[0].steps[0].value']
    ])
    expect(diagnostics[0]!.message).toContain("'env'")
    expect(diagnostics[0]!.hint).toContain('@speqkit/plugin-data')
    expect(diagnostics[0]!.hint).toContain('loaded: vault')
  })

  it('reads a nesting step\'s body against what the step says it binds', async () => {
    const registry = await registryWith(echo, nesting)
    const diagnostics = validateTests(registry, [test({
      steps: [
        { id: 'a', type: 'echo' },
        {
          id: 'loop',
          type: 'each',
          as: 'row',
          steps: [
            { id: 'first', type: 'echo', value: '${row} ${a.value}' },
            { type: 'echo', value: '${first.value} ${roww}' }
          ]
        },
        { type: 'echo', value: '${first.value} ${loop.value}' }
      ]
    })])

    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['unresolved-reference', 'steps[1].steps[1].value'],
      ['unresolved-reference', 'steps[2].value']
    ])
    expect(diagnostics[0]!.hint).toBe("did you mean 'row'?")
    // A child scope is popped when its step returns; what survives is the
    // outer step's own result, and the message says to read that instead.
    expect(diagnostics[1]!.message).toContain("nested under 'loop' and not visible outside it")
    expect(diagnostics[1]!.hint).toContain('${loop.…}')
  })

  it('takes a nesting step that declares nothing at its word', async () => {
    const registry = await registryWith(echo, nesting)
    const diagnostics = validateTests(registry, [test({
      steps: [{ type: 'opaque', steps: [{ type: 'echo', value: '${whatever} ${anything.at.all}' }] }]
    })])

    expect(diagnostics).toEqual([])
  })

  it('checks a suite\'s own setup against the suite\'s own names', async () => {
    const registry = await registryWith(echo)
    const suite = {
      name: 'orders',
      source: 'suites/suite.yaml',
      setup: [{ id: 'tenant', type: 'echo' }, { type: 'echo', value: '${tenant.value} ${nope}' }],
      cleanup: [{ type: 'echo', value: '${tenant.value}' }]
    }
    const diagnostics = validateTests(registry, [
      test({ steps: [{ type: 'echo', value: '${tenant.value}' }], suites: [suite] })
    ])

    // The suite's second setup step reads a name that is nowhere; the test
    // cannot see the suite's `tenant` at all, by design, and is told so.
    expect(diagnostics.map((d) => [d.file, d.code, d.path])).toEqual([
      ['suites/suite.yaml', 'unresolved-reference', 'setup[1].value'],
      ['t.yaml', 'unresolved-reference', 'steps[0].value']
    ])
  })
})

/**
 * A message is written for a person and may be reworded in any release; a code
 * is written for a program and may not. Without the second one the only way to
 * tell a step type that does not exist from one whose input is malformed was
 * to match substrings of coloured stderr — which is to say that a suite a
 * model generated could not be repaired without a human reading the output.
 *
 * The list below is the kernel's whole vocabulary. Adding a diagnostic without
 * a code, or renaming one of these, breaks a caller that cannot be seen from
 * here; this test is where that gets noticed.
 */
describe('every diagnostic says what is wrong in a word a program can read', () => {
  const strict = definePlugin({
    name: 'speqkit-plugin-strict',
    setup(ctx) {
      ctx.defineStepType('send', {
        schema: { type: 'object', properties: { to: {} }, required: ['to'], additionalProperties: false },
        execute: () => ({})
      })
      ctx.defineStepType('brittle', {
        validate: () => { throw new Error('I am the bug') },
        execute: () => ({})
      })
      ctx.defineStepType('count', {
        schema: { type: 'object', properties: { n: { type: 'integer' } }, additionalProperties: false },
        execute: () => ({})
      })
    }
  })

  /** One of everything the kernel knows how to refuse. */
  const wrong = (): Parameters<typeof validateTests>[1] => {
    const suite = { name: 'orders', source: 'suites/suite.yaml', pending: true }
    return [
      { name: 'a', source: 'a.yaml', steps: [{ type: 'send', to: 'x' }], suites: [suite] },
      { name: '', source: 'b.yaml', steps: [{ type: 'send', to: 'x' }] },
      { name: 'a', source: 'c.yaml', steps: [{ type: 'send', to: 'x' }] },
      { name: 'd', source: 'd.yaml', steps: [] },
      {
        name: 'e',
        source: 'e.yaml',
        pending: 3,
        variables: { one: 1 },
        steps: [
          { id: 'one', type: 'send', to: 'x' },
          { id: 'one', type: 'send', to: 'x' },
          { type: 'nope' },
          { type: 'send' },
          { type: 'send', to: 'x', extra: 1 },
          { type: 'brittle' },
          { type: 'count', n: 'three' }
        ],
        assert: [{ type: 'nope' }]
      },
      {
        name: 'r',
        source: 'r.yaml',
        steps: [
          { type: 'send', to: '${later.value} ${nowhere} ${vault:token}' },
          { id: 'later', type: 'send', to: 'x' }
        ]
      },
      { name: 'f', source: 'f.yaml', steps: [{ type: 'send', to: 'x' }], cases: 'no' },
      { name: 'g', source: 'g.yaml', steps: [{ type: 'send', to: 'x' }], cases: [] },
      {
        name: 'h',
        source: 'h.yaml',
        steps: [{ type: 'send', to: 'x' }],
        cases: [1, { id: '' }, { id: 'x' }, { id: 'x' }]
      }
    ] as unknown as Parameters<typeof validateTests>[1]
  }

  it('carries a code on every one of them', async () => {
    const registry = await registryWith(strict)
    const diagnostics = validateTests(registry, wrong())

    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics.filter((d) => !d.code)).toEqual([])
  })

  it('spells them the same way every release', async () => {
    const registry = await registryWith(strict)
    const diagnostics = validateTests(registry, wrong())

    expect([...new Set(diagnostics.map((d) => d.code))].sort()).toEqual([
      'case-has-no-id',
      'case-is-not-a-mapping',
      'cases-is-empty',
      'cases-is-not-a-list',
      'duplicate-case-id',
      'duplicate-step-id',
      'duplicate-test-name',
      'forward-reference',
      'invalid-value',
      'missing-field',
      'pending-needs-reason',
      'plugin-check-threw',
      'test-has-no-name',
      'test-has-no-steps',
      'unknown-assertion',
      'unknown-field',
      'unknown-provider',
      'unknown-step-type',
      'unresolved-reference',
      'variable-is-a-step-id'
    ])
  })
})

describe('a step can be written and not run', () => {
  /**
   * `when:` is a field of the spine, and the reason is the same one `assert`
   * has: a plugin cannot express it. Whether a step runs is decided before its
   * type is looked up, so a condition owned by a step type would be one every
   * step type had to implement in its own spelling — and a step whose plugin
   * is not loaded here could not be switched off at all.
   */
  const strict = definePlugin({
    name: 'strict-input',
    setup(ctx) {
      ctx.defineStepType('only-value', {
        // Closed, so the test fails if `when` is ever handed to a plugin as
        // input. This is the mistake `meta` had to be lifted out for.
        schema: {
          type: 'object',
          properties: { value: {} },
          required: ['value'],
          additionalProperties: false
        },
        execute: (_exec, input) => ({ value: input.value })
      })
    }
  })

  const run = async (steps: StepDef[], variables?: Record<string, unknown>) => {
    const registry = await registryWith(strict)
    const outcome = await runTests(registry, [
      { name: 't', ...(variables ? { variables } : {}), steps }
    ])
    return outcome
  }

  it('skips the step, and the test is none the worse for it', async () => {
    const outcome = await run([
      { type: 'only-value', value: 1, when: false },
      { type: 'only-value', value: 2 }
    ])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps.map((s) => [s.status, s.code])).toEqual([
      ['skipped', 'when-false'],
      ['passed', undefined]
    ])
  })

  it('reads the dull false values, and nothing cleverer', async () => {
    const off = ['false', 'no', '0', '  ', 0]
    for (const value of off) {
      const outcome = await run([{ type: 'only-value', value: 1, when: '${flag}' }], { flag: value })
      expect(outcome.tests[0]!.steps[0]!.status, `when: ${JSON.stringify(value)}`).toBe('skipped')
    }
    for (const value of ['yes', 'FALSEY', 1, true, 'true']) {
      const outcome = await run([{ type: 'only-value', value: 1, when: '${flag}' }], { flag: value })
      expect(outcome.tests[0]!.steps[0]!.status, `when: ${JSON.stringify(value)}`).toBe('passed')
    }
  })

  it('never hands the condition to the plugin as input', async () => {
    const outcome = await run([{ type: 'only-value', value: 1, when: true }])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result).toEqual({ value: 1 })
  })

  it('binds nothing when it did not run, and says so where it is used', async () => {
    const outcome = await run([
      { id: 'maybe', type: 'only-value', value: 1, when: false },
      { type: 'only-value', value: '${maybe.value}' }
    ])
    expect(outcome.tests[0]!.steps[1]!.code).toBe('unresolved-reference')
  })

  it('is a condition, not a place for a name that binds nothing', async () => {
    const outcome = await run([{ type: 'only-value', value: 1, when: '${nowhere}' }])
    expect(outcome.tests[0]!.steps[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.code).toBe('unresolved-reference')
  })

  it('does not read a skipped setup step as a setup that broke', async () => {
    const registry = await registryWith(strict)
    const outcome = await runTests(registry, [
      {
        name: 't',
        setup: [{ type: 'only-value', value: 1, when: false }],
        steps: [{ type: 'only-value', value: 2 }]
      }
    ])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.code).toBeUndefined()
  })

  it('refuses a condition that is reaching for an expression language', async () => {
    const registry = await registryWith(strict)
    const diagnostics = validateTests(registry, [
      {
        name: 't',
        source: 't.yaml',
        steps: [{ type: 'only-value', value: 1, when: [1, 2] }]
      }
    ] as unknown as Parameters<typeof validateTests>[1])
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([['invalid-value', 'steps[0].when']])
  })
})

describe('a test says how long it may take, and the teardown is not part of it', () => {
  /**
   * `timeout` was the clearest case of the trap `meta` sets: written at the
   * top of a test it read as an annotation, was carried and never read, and
   * `1 test(s) valid` said so — while the number that actually applied was
   * the step's. A key that looks like behaviour and is filed as a label is
   * worse than a refusal.
   */
  const slow = definePlugin({
    name: 'slow',
    setup(ctx) {
      ctx.defineStepType('slow', {
        timeoutMs: 10_000,
        execute: (exec, input) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ slept: input.ms }), Number(input.ms))
          exec.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(exec.signal.reason)
          }, { once: true })
        })
      })
      ctx.defineStepType('note', { execute: (_e, input) => ({ value: input.value }) })
    }
  })

  const cleaned: unknown[] = []
  const recorder = definePlugin({
    name: 'recorder',
    setup(ctx) {
      ctx.defineStepType('remember', {
        execute: (_e, input) => { cleaned.push(input.value); return {} }
      })
    }
  })

  it('stops the test where it stands, and says whose budget it was', async () => {
    const registry = await registryWith(slow, recorder)
    const outcome = await runTests(registry, [
      { name: 't', timeout: 40, steps: [{ type: 'slow', ms: 5_000 }, { type: 'note', value: 1 }] }
    ])

    expect(outcome.status).toBe('error')
    // The step's own budget was ten seconds and was not the one that ran out.
    // Which of the two it was is the difference between raising a number and
    // going to look at the step.
    expect(outcome.tests[0]!.steps[0]!.code).toBe('test-timeout')
    expect(outcome.tests[0]!.code).toBe('test-timeout')
    // The step after it never started: there was no time left to start it in.
    expect(outcome.tests[0]!.steps).toHaveLength(1)
  })

  it('still runs the cleanup, which is the whole reason the budget is not a race', async () => {
    cleaned.length = 0
    const registry = await registryWith(slow, recorder)
    const outcome = await runTests(registry, [
      {
        name: 't',
        timeout: 40,
        steps: [{ id: 'made', type: 'slow', ms: 5_000 }],
        cleanup: [{ type: 'remember', value: 'deleted the tenant' }]
      }
    ])

    expect(outcome.status).toBe('error')
    expect(cleaned).toEqual(['deleted the tenant'])
  })

  it('takes a duration the way a step does', async () => {
    const registry = await registryWith(slow, recorder)
    const outcome = await runTests(registry, [
      { name: 'fine', timeout: '30s', steps: [{ type: 'note', value: 1 }] }
    ])
    expect(outcome.status).toBe('passed')
  })

  it('refuses a budget that is not one, before the run', async () => {
    const registry = await registryWith(slow, recorder)
    const diagnostics = validateTests(registry, [
      { name: 't', source: 't.yaml', timeout: 'soon', steps: [{ type: 'note', value: 1 }] }
    ] as unknown as Parameters<typeof validateTests>[1])

    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([['invalid-value', 'timeout']])
  })

  it('warns about a word under meta that reads like behaviour, and does not refuse it', async () => {
    const registry = await registryWith(slow, recorder)
    const diagnostics = validateTests(registry, [
      {
        name: 't',
        source: 't.yaml',
        steps: [{ type: 'note', value: 1 }],
        meta: { retries: 3, owner: 'mira' }
      }
    ] as unknown as Parameters<typeof validateTests>[1])

    // `owner` is exactly what meta is for and is not mentioned. `retries` is
    // a promise the file does not keep, so it is said — and said as a warning,
    // because refusing it would break every project that annotates in good
    // faith, and saying nothing is how the same afternoon gets lost twice.
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.code).toBe('meta-looks-like-behaviour')
    expect(diagnostics[0]!.level).toBe('warn')
    expect(diagnostics[0]!.hint).toContain("'retry' step")
  })
})

describe('a failure that already happened says why in a word a program can read', () => {
  /**
   * The same removal `Diagnostic.code` made for what `validate` says, one
   * layer later: on the run itself. A repair loop reading `run --json` had a
   * status and a sentence, and "the plugin threw", "the budget ran out" and
   * "a name binds nothing" want three different fixes.
   */
  const breaks = definePlugin({
    name: 'breaks',
    setup(ctx) {
      ctx.defineStepType('throws', {
        execute: () => { throw new Error('the library said no') }
      })
      ctx.defineStepType('hangs', {
        timeoutMs: 20,
        execute: (exec) => new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
        })
      })
      ctx.defineStepType('ok', { execute: (_exec, input) => ({ value: input.value }) })
      ctx.defineAssertion('no', {
        evaluate: () => ({ passed: false, message: 'no', expected: 1, actual: 2 })
      })
      ctx.defineAssertion('boom', {
        evaluate: () => { throw new Error('the assertion is the bug') }
      })
    }
  })

  const codesOf = async (steps: StepDef[]) => {
    const registry = await registryWith(breaks)
    const outcome = await runTests(registry, [{ name: 't', steps }])
    return outcome.tests[0]!.steps.map((s) => s.code)
  }

  it('tells a plugin that threw from a budget that ran out', async () => {
    expect(await codesOf([{ type: 'throws' }])).toEqual(['plugin-threw'])
    expect(await codesOf([{ type: 'hangs' }])).toEqual(['step-timeout'])
  })

  it('names a reference that binds nothing as that, and not as a plugin fault', async () => {
    expect(await codesOf([{ type: 'ok', value: '${nowhere}' }])).toEqual(['unresolved-reference'])
  })

  it('says which of the four an unknown name is', async () => {
    expect(await codesOf([{ type: 'grpc' }])).toEqual(['unknown-step-type'])

    const registry = await registryWith(breaks)
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ type: 'ok', value: 1, assert: [{ type: 'nope' }] }] }
    ])
    // The step says its assertions disagreed; the assertion says nothing
    // defines that name. Two different repairs, and the second is not the
    // step type's fault.
    expect(outcome.tests[0]!.steps[0]!.code).toBe('assertion-failed')
    expect(outcome.tests[0]!.steps[0]!.assertions![0]!.code).toBe('unknown-assertion')
  })

  it('leaves a working assertion that disagreed without a code of its own', async () => {
    const registry = await registryWith(breaks)
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ type: 'ok', value: 1, assert: [{ type: 'no' }, { type: 'boom' }] }] }
    ])
    const [disagreed, threw] = outcome.tests[0]!.steps[0]!.assertions!
    expect(disagreed!.code).toBeUndefined()
    expect(threw!.code).toBe('assertion-threw')
    expect(outcome.tests[0]!.steps[0]!.code).toBe('assertion-failed')
  })

  it('passes without one, because a code is a reason and a green step has none', async () => {
    expect(await codesOf([{ type: 'ok', value: 1 }])).toEqual([undefined])
  })

  it('says on the test what no step of it can say', async () => {
    const registry = await registryWith(breaks)
    const outcome = await runTests(registry, [
      { name: 'givens', variables: { a: '${nowhere}' }, steps: [{ type: 'ok', value: 1 }] },
      { name: 'setup', setup: [{ type: 'throws' }], steps: [{ type: 'ok', value: 1 }] },
      { name: 'cleanup', steps: [{ type: 'ok', value: 1 }], cleanup: [{ type: 'throws' }] },
      { name: 'body', steps: [{ type: 'throws' }] }
    ])
    expect(outcome.tests.map((t) => [t.name, t.code])).toEqual([
      ['givens', 'variables-unresolved'],
      ['setup', 'setup-failed'],
      ['cleanup', 'cleanup-failed'],
      // Nothing: the step below it already carries `plugin-threw`, and a copy
      // here would be a second place to keep true.
      ['body', undefined]
    ])
  })

  it('carries the code on the stream, so a replayed report reads the same', async () => {
    const registry = await registryWith(breaks)
    const events: RunEvent[] = []
    registry.events.subscribe((event) => { events.push(event) })
    await runTests(registry, [{ name: 't', setup: [{ type: 'throws' }], steps: [{ type: 'ok', value: 1 }] }])

    const step = events.find((e) => e.type === 'step.finished')
    const test = events.find((e) => e.type === 'test.finished')
    expect(step && 'code' in step ? step.code : undefined).toBe('plugin-threw')
    expect(test && 'code' in test ? test.code : undefined).toBe('setup-failed')
  })

  it('spells them the same way every release', () => {
    expect([...STEP_CODES]).toEqual([
      'unknown-step-type',
      'unresolved-reference',
      'step-timeout',
      'test-timeout',
      'plugin-threw',
      'assertion-failed',
      'step-failed',
      'when-false'
    ])
    expect([...ASSERTION_CODES]).toEqual(['unknown-assertion', 'assertion-threw'])
    expect([...TEST_CODES]).toEqual([
      'variables-unresolved',
      'setup-failed',
      'cleanup-failed',
      'suite-setup-failed',
      'test-timeout'
    ])
  })
})

describe('a plugin checks its own inputs, beyond their shape', () => {
  // A schema settles shape. Whether the input means anything — a file that
  // must exist, two fields that exclude each other — only the plugin knows,
  // and before this it had nowhere to say so but the middle of the run.
  const picky = definePlugin({
    name: 'speqkit-plugin-picky',
    setup(ctx) {
      ctx.defineStepType('send', {
        schema: { type: 'object', properties: { to: {}, all: {} }, additionalProperties: false },
        validate(step) {
          const problems: string[] = []
          if (step.to && step.all) problems.push("'to' and 'all' exclude each other")
          const { known = [] } = ctx.config<{ known?: string[] }>()
          if (typeof step.to === 'string' && known.length > 0 && !known.includes(step.to)) {
            problems.push(`'${step.to}' is not one of the configured recipients`)
          }
          return problems
        },
        execute: () => ({})
      })
      ctx.defineAssertion('arrived', {
        validate: (assertion) =>
          assertion.within === undefined ? [{ path: 'within', message: "'within' is required", hint: 'e.g. 5s' }] : [],
        evaluate: () => ({ passed: true, message: 'ok' })
      })
      ctx.defineStepType('broken', {
        validate: () => { throw new Error('I am the bug') },
        execute: () => ({})
      })
    }
  })

  it('files a problem the plugin found against the right step', async () => {
    const registry = await registryWith(picky)
    const diagnostics = validateTests(registry, [
      { name: 't', source: 'a.yaml', steps: [{ type: 'echo' }, { type: 'send', to: 'a', all: true }] }
    ])

    // The code is namespaced by the plugin that found the problem — always,
    // including when the plugin named none. Whose check refused is readable
    // without reading the sentence, and a plugin that starts naming its
    // problems tomorrow cannot collide with a kernel code invented today.
    expect(diagnostics).toContainEqual({
      file: 'a.yaml',
      path: 'steps[1]',
      code: 'picky/invalid',
      message: "'to' and 'all' exclude each other"
    })
  })

  it('addresses a problem inside the step when the plugin says where', async () => {
    const registry = await registryWith(picky)
    const diagnostics = validateTests(registry, [
      { name: 't', source: 'a.yaml', steps: [{ type: 'send' }], assert: [{ type: 'arrived' }] }
    ])

    expect(diagnostics).toEqual([
      {
        file: 'a.yaml',
        path: 'assert[0].within',
        code: 'picky/invalid',
        message: "'within' is required",
        hint: 'e.g. 5s'
      }
    ])
  })

  it('gives the validator the config for that plugin', async () => {
    const registry = new Registry()
    registry.setConfig({ picky: { known: ['ada'] } })
    await registry.register(picky)
    registry.settle()

    const diagnostics = validateTests(registry, [
      { name: 't', source: 'a.yaml', steps: [{ type: 'send', to: 'grace' }] }
    ])

    expect(diagnostics[0]!.message).toContain("'grace' is not one of the configured recipients")
  })

  it('reports a throwing validator as a bug in the plugin, and keeps going', async () => {
    const registry = await registryWith(picky)
    const diagnostics = validateTests(registry, [
      { name: 't', source: 'a.yaml', steps: [{ type: 'broken' }, { type: 'nosuch' }] }
    ])

    // Both: the crash did not swallow the diagnostic the user needed.
    expect(diagnostics[0]).toMatchObject({
      path: 'steps[0]',
      message: expect.stringContaining("threw inside plugin 'speqkit-plugin-picky': I am the bug"),
      hint: 'this is a bug in the plugin, not in the test'
    })
    expect(diagnostics[1]!.message).toContain("unknown step type 'nosuch'")
  })

  it('says nothing when a plugin declares no validator', async () => {
    const registry = await registryWith(echo)
    expect(validateTests(registry, [{ name: 't', source: 'a.yaml', steps: [{ type: 'echo' }] }])).toEqual([])
  })
})

describe('a value provider may take its time', () => {
  /**
   * A secret lives in a vault, a fixture lives in a database: the answer to
   * `${...}` is not always in memory. The contract has always typed `resolve`
   * as maybe-async; until now the kernel never awaited it and put the Promise
   * itself into the request body, silently.
   *
   * The awaiting happens where speq resolves a step input or an assertion, so
   * `ExecContext.resolve` stays synchronous for plugins.
   */
  function vault(log: string[] = [], delayMs = 0) {
    return definePlugin({
      name: 'vault',
      setup(ctx) {
        ctx.defineValueProvider('vault', {
          prefix: 'vault',
          async resolve(key) {
            log.push(key)
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
            if (key === 'missing') throw new Error('no such secret')
            return `secret-${key}`
          }
        })
      }
    })
  }

  it('awaits the provider instead of handing the step a Promise', async () => {
    const registry = await registryWith(echo, vault())
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ id: 'a', type: 'echo', value: '${vault:token}' }] }
    ])

    expect(outcome.tests[0]!.steps[0]!.result.value).toBe('secret-token')
  })

  it('asks once per step, however many times the key is written', async () => {
    const log: string[] = []
    const registry = await registryWith(echo, vault(log))
    await runTests(registry, [
      {
        name: 't',
        steps: [
          { type: 'echo', value: '${vault:token} and ${vault:token}', other: ['${vault:token}'] },
          { type: 'echo', value: '${vault:token}' }
        ]
      }
    ])

    // A provider is a lookup, not a generator — but the pass is one step
    // wide, so a value that changed between the two steps is read again.
    expect(log).toEqual(['token', 'token'])
  })

  it('asks for every key it needs at once, not one after another', async () => {
    const registry = await registryWith(echo, vault([], 60))
    const started = Date.now()
    await runTests(registry, [
      { name: 't', steps: [{ type: 'echo', a: '${vault:one}', b: '${vault:two}', c: '${vault:three}' }] }
    ])

    expect(Date.now() - started).toBeLessThan(150)
  })

  it('errors the step when the provider rejects, with the reason it gave', async () => {
    const registry = await registryWith(echo, vault())
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ type: 'echo', value: '${vault:missing}' }] }
    ])

    expect(outcome.tests[0]!.steps[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.message).toBe('no such secret')
  })

  it('resolves an assertion the same way', async () => {
    const registry = await registryWith(echo, vault())
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [{ type: 'echo', value: 'secret-token' }],
        assert: [{ type: 'equals', expected: '${vault:token}' }]
      }
    ])

    expect(outcome.status).toBe('passed')
  })

  it('gives a step its timeout to wait, rather than hanging on the provider', async () => {
    // Short enough that the timer this leaves behind does not outlive the
    // test run, long enough that the step's timeout wins.
    const registry = await registryWith(echo, vault([], 200))
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ type: 'echo', timeout: 20, value: '${vault:token}' }] }
    ])

    expect(outcome.tests[0]!.steps[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.message).toContain('timed out')
  })

  it('tells a plugin resolving by hand that this one cannot be awaited', async () => {
    const byHand = definePlugin({
      name: 'by-hand',
      setup: (ctx) =>
        ctx.defineStepType('by-hand', {
          execute: (exec) => ({ value: exec.resolve('${vault:token}') })
        })
    })
    const registry = await registryWith(byHand, vault())
    const outcome = await runTests(registry, [{ name: 't', steps: [{ type: 'by-hand' }] }])

    // Rather than a Promise ending up in the result, which is what the old
    // behaviour did everywhere.
    expect(outcome.tests[0]!.steps[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.message).toContain('answers asynchronously')
  })

  it('leaves a synchronous provider synchronous', async () => {
    const now = definePlugin({
      name: 'now',
      setup: (ctx) => ctx.defineValueProvider('now', { prefix: 'now', resolve: (key) => `${key}!` })
    })
    const registry = await registryWith(echo, now)
    const outcome = await runTests(registry, [
      { name: 't', steps: [{ type: 'echo', value: '${now:hi}' }] }
    ])

    expect(outcome.tests[0]!.steps[0]!.result.value).toBe('hi!')
  })
})

/**
 * The stream carried a status, a duration and a sentence, and never what the
 * step had actually done — so no reporter could print a request and a
 * response, whatever flag it was given, and the only way to see an exchange
 * was to run the test again with a proxy in front of it.
 */
describe('a step says what it was doing, when it did not go well', () => {
  const recorder = definePlugin({
    name: 'recorder',
    setup(ctx) {
      ctx.defineStepType('recording', {
        execute(exec, input) {
          exec.record({ tried: input.tried })
          if (input.throws) throw new Error('the connection went away')
          return { value: input.value }
        }
      })

      // Records its own before running children that record theirs.
      ctx.defineStepType('outer', {
        async execute(exec, input) {
          exec.record({ tried: 'outer' })
          const records = await exec.runSteps(input.steps as StepDef[])
          return { children: records.length }
        }
      })
    }
  })

  async function run(tests: Parameters<typeof runTests>[1]) {
    const registry = await registryWith(echo, recorder)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))
    const outcome = await runTests(registry, tests)
    return { outcome, steps: events.filter((e) => e.type === 'step.finished') }
  }

  it('keeps nothing when the step passed, so a green run logs what it always did', async () => {
    const { outcome, steps } = await run([
      { name: 't', steps: [{ id: 'a', type: 'recording', tried: 'GET /x', value: 'ok' }] }
    ])

    expect(outcome.status).toBe('passed')
    // The key is absent rather than undefined: a reporter that asks whether
    // there is an exchange to show must not be handed an empty one.
    expect(steps[0]).not.toHaveProperty('detail')
    expect(outcome.tests[0]!.steps[0]!.detail).toBeUndefined()
  })

  it('carries it on a step whose answer was wrong', async () => {
    const { outcome, steps } = await run([
      {
        name: 't',
        steps: [{
          id: 'a', type: 'recording', tried: 'GET /x', value: 'ok',
          assert: [{ type: 'equals', expected: 'nope' }]
        }]
      }
    ])

    expect(outcome.status).toBe('failed')
    expect(steps[0]!.detail).toEqual({ tried: 'GET /x' })
    expect(outcome.tests[0]!.steps[0]!.detail).toEqual({ tried: 'GET /x' })
  })

  /**
   * The case the buffered design exists for. A callback handed the step's
   * result could not answer here — there is no result — and this is exactly
   * the failure an agent is worst equipped to guess at: a request that never
   * came back and a message that names no body.
   */
  it('carries what was recorded before the step threw', async () => {
    const { outcome, steps } = await run([
      { name: 't', steps: [{ id: 'a', type: 'recording', tried: 'GET /gone', throws: true }] }
    ])

    expect(outcome.status).toBe('error')
    expect(steps[0]!.status).toBe('error')
    expect(steps[0]!.detail).toEqual({ tried: 'GET /gone' })
  })

  it('does not hand a step whatever its children recorded', async () => {
    const { steps } = await run([
      {
        name: 't',
        steps: [{
          id: 'o',
          type: 'outer',
          steps: [{ id: 'i', type: 'recording', tried: 'inner', value: 'ok' }],
          assert: [{ type: 'equals', expected: 'nope' }]
        }]
      }
    ])

    const outer = steps.find((s) => s.stepId === 'o')!
    const inner = steps.find((s) => s.stepId === 'i')!
    expect(outer.detail).toEqual({ tried: 'outer' })
    expect(inner).not.toHaveProperty('detail')
  })
})

/**
 * A test used to be identified in the stream by everything except the two
 * things reporters group by.
 *
 * `tags` is what `--tags` selected the run with, and the stream never said it,
 * so a report per ticket had to re-discover the project to find out what it
 * had just watched. `suite` was said only by the bracketing, and the bracketing
 * is adjacency — which G4 takes away the moment two suites run at once.
 */
describe('a test names its suite and its labels itself', () => {
  async function started(tests: Parameters<typeof runTests>[1]) {
    const registry = await registryWith(echo)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))
    await runTests(registry, tests)
    return events.filter((e) => e.type === 'test.started')
  }

  it('carries the suite it is in, on the event rather than on the one before it', async () => {
    const events = await started([
      { name: 'a', source: 'suites/orders.yaml', steps: [{ type: 'echo', value: 1 }] },
      { name: 'b', source: 'suites/menu.yaml', steps: [{ type: 'echo', value: 1 }] }
    ])

    expect(events.map((e) => [e.test, e.suite])).toEqual([
      ['a', 'suites/orders.yaml'],
      ['b', 'suites/menu.yaml']
    ])
  })

  it('carries its labels, and leaves the key off when it has none', async () => {
    const events = await started([
      { name: 'a', tags: ['PAY-114', 'smoke'], steps: [{ type: 'echo', value: 1 }] },
      { name: 'b', steps: [{ type: 'echo', value: 1 }] }
    ])

    expect(events[0]!.tags).toEqual(['PAY-114', 'smoke'])
    // Absent rather than empty, on the same terms as `meta`: a reporter asking
    // whether a test is labelled must not be handed a list that says nothing.
    expect(events[1]).not.toHaveProperty('tags')
  })

  it('says both for a test the suite blocked, which never ran at all', async () => {
    const registry = await registryWith(echo)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))
    await runTests(registry, [{
      name: 'a',
      source: 'suites/orders.yaml',
      tags: ['PAY-114'],
      suites: [{
        name: 'suites',
        setup: [{ type: 'echo', value: 1, assert: [{ type: 'equals', expected: 'nope' }] }]
      }],
      steps: [{ type: 'echo', value: 1 }]
    }])

    expect(events.find((e) => e.type === 'test.finished')!.status).toBe('error')
    const start = events.find((e) => e.type === 'test.started')!
    // The row a blocked test gets is the whole of what a report can say about
    // it, so it is not the row that may be missing its grouping.
    expect(start.suite).toBe('suites/orders.yaml')
    expect(start.tags).toEqual(['PAY-114'])
  })
})
