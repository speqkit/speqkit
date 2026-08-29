import { describe, expect, it } from 'vitest'
import { definePlugin, type StepDef } from '@speqkit/plugin-api'
import { Registry, runTests, validateTests } from 'speqkit'

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

    expect(diagnostics).toContainEqual({
      file: 'a.yaml',
      path: 'steps[1]',
      message: "'to' and 'all' exclude each other"
    })
  })

  it('addresses a problem inside the step when the plugin says where', async () => {
    const registry = await registryWith(picky)
    const diagnostics = validateTests(registry, [
      { name: 't', source: 'a.yaml', steps: [{ type: 'send' }], assert: [{ type: 'arrived' }] }
    ])

    expect(diagnostics).toEqual([
      { file: 'a.yaml', path: 'assert[0].within', message: "'within' is required", hint: 'e.g. 5s' }
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
