import { describe, expect, it } from 'vitest'
import { definePlugin, type StepDef } from '@speqkit/plugin-api'
import { Registry, runTests, validateTests } from '@speqkit/core'

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
