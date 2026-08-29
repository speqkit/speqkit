import { describe, expect, it } from 'vitest'
import { definePlugin, type RunEvent } from '@speqkit/plugin-api'
import { Registry, runTests, validateTests } from 'speqkit'

/**
 * The rest of the test model, pinned the same way the spine is.
 *
 * `Suite → Test → Step → Assertion` was only ever half implemented: assertions
 * existed at the test, never at the step, and a test had a body but no way to
 * build a world before it or take one down after. Both gaps are the kernel's
 * to fill — a plugin cannot express `finally` without leaking its frame back
 * into the caller, and a step type has no business reading a block that is not
 * its input.
 */

async function registryWith(...plugins: Parameters<Registry['register']>[0][]) {
  const registry = new Registry()
  for (const plugin of plugins) await registry.register(plugin)
  registry.settle()
  return registry
}

const world: string[] = []

/** A step type whose schema is closed, so `assert` had better not reach it. */
const shop = definePlugin({
  name: 'shop',
  setup(ctx) {
    ctx.defineStepType('open', {
      schema: { type: 'object', properties: { name: {} }, required: ['name'], additionalProperties: false },
      execute(_exec, input) {
        world.push(`open:${String(input.name)}`)
        return { name: input.name, status: 200 }
      }
    })
    ctx.defineStepType('close', {
      execute(_exec, input) {
        world.push(`close:${String(input.name)}`)
        return { closed: input.name }
      }
    })
    ctx.defineStepType('boom', {
      execute() {
        throw new Error('the plugin fell over')
      }
    })
    ctx.defineAssertion('status', {
      evaluate: (assert, input) => ({
        passed: assert.last?.status === input.expected,
        message: `status ${String(assert.last?.status)}`
      })
    })
    ctx.defineAssertion('named', {
      evaluate: (assert, input) => ({
        passed: assert.last?.name === input.expected,
        message: `name ${String(assert.last?.name)}`
      })
    })
  }
})

describe('a step carries its own assertions', () => {
  it('marks the step failed when one of them does not hold', async () => {
    const registry = await registryWith(shop)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [{ id: 'a', type: 'open', name: 'ada', assert: [{ type: 'status', expected: 500 }] }]
      }
    ])

    const step = outcome.tests[0]!.steps[0]!
    expect(step.status).toBe('failed')
    expect(step.assertions).toEqual([{ type: 'status', passed: false, message: 'status 200' }])
    expect(outcome.tests[0]!.status).toBe('failed')
  })

  it('never hands the block to the step type, whose schema is closed', async () => {
    const registry = await registryWith(shop)
    const test = {
      name: 't',
      steps: [{ type: 'open', name: 'ada', assert: [{ type: 'status', expected: 200 }] }]
    }

    expect(validateTests(registry, [test])).toEqual([])
    const outcome = await runTests(registry, [test])
    expect(outcome.tests[0]!.steps[0]!.status).toBe('passed')
  })

  it('evaluates every assertion in the block, not only up to the first failure', async () => {
    const registry = await registryWith(shop)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [
          {
            type: 'open',
            name: 'ada',
            assert: [
              { type: 'status', expected: 500 },
              { type: 'named', expected: 'grace' }
            ]
          }
        ]
      }
    ])

    expect(outcome.tests[0]!.steps[0]!.assertions).toHaveLength(2)
  })

  it('says which step an assertion belonged to, so a report can nest it', async () => {
    const registry = await registryWith(shop)
    const seen: RunEvent[] = []
    registry.events.subscribe((e) => seen.push(e))

    await runTests(registry, [
      { name: 't', steps: [{ id: 'a', type: 'open', name: 'ada', assert: [{ type: 'status', expected: 200 }] }] }
    ])

    const evaluated = seen.find((e) => e.type === 'assertion.evaluated')
    expect(evaluated).toMatchObject({ assertionType: 'status', passed: true, stepId: 'a' })
  })

  it('checks a step assertion before the run, like any other part of the grammar', async () => {
    const registry = await registryWith(shop)
    const diagnostics = validateTests(registry, [
      { name: 't', source: 'suites/t.yaml', steps: [{ type: 'open', name: 'ada', assert: [{ type: 'stat' }] }] }
    ])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.path).toBe('steps[0].assert[0].type')
    expect(diagnostics[0]!.hint).toContain('status')
  })
})

describe('a test has a lifecycle, and cleanup is not a trailing step', () => {
  it('runs setup in the test own scope, so the body addresses what it bound', async () => {
    const registry = await registryWith(shop)
    const outcome = await runTests(registry, [
      {
        name: 't',
        setup: [{ id: 'made', type: 'open', name: 'ada' }],
        steps: [{ id: 'used', type: 'close', name: '${made.name}' }]
      }
    ])

    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps.map((s) => s.phase)).toEqual(['setup', undefined])
    expect(outcome.tests[0]!.steps[1]!.result).toEqual({ closed: 'ada' })
  })

  it('runs cleanup after the body failed, addressing what setup bound', async () => {
    world.length = 0
    const registry = await registryWith(shop)
    const outcome = await runTests(registry, [
      {
        name: 't',
        setup: [{ id: 'made', type: 'open', name: 'ada' }],
        steps: [{ type: 'open', name: 'grace', assert: [{ type: 'status', expected: 500 }] }],
        cleanup: [{ type: 'close', name: '${made.name}' }]
      }
    ])

    expect(outcome.tests[0]!.status).toBe('failed')
    expect(world).toEqual(['open:ada', 'open:grace', 'close:ada'])
  })

  it('runs cleanup even when setup itself broke, because a half-built world is still a world', async () => {
    world.length = 0
    const registry = await registryWith(shop)
    const outcome = await runTests(registry, [
      {
        name: 't',
        setup: [{ id: 'made', type: 'open', name: 'ada' }, { type: 'boom' }],
        steps: [{ type: 'open', name: 'never' }],
        cleanup: [{ type: 'close', name: '${made.name}' }]
      }
    ])

    expect(outcome.tests[0]!.status).toBe('error')
    expect(world).toEqual(['open:ada', 'close:ada'])
  })

  it('does not run the body when setup did not finish', async () => {
    const registry = await registryWith(shop)
    const outcome = await runTests(registry, [
      {
        name: 't',
        setup: [{ type: 'open', name: 'ada', assert: [{ type: 'status', expected: 500 }] }],
        steps: [{ type: 'open', name: 'never' }]
      }
    ])

    expect(outcome.tests[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps.filter((s) => s.phase === undefined)).toEqual([])
  })

  it('is not a passing test when the teardown failed, and says so once', async () => {
    const registry = await registryWith(shop)
    const seen: RunEvent[] = []
    registry.events.subscribe((e) => seen.push(e))

    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [{ type: 'open', name: 'ada' }],
        cleanup: [{ type: 'boom' }]
      }
    ])

    expect(outcome.tests[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps.at(-1)!.phase).toBe('cleanup')
    const warnings = seen.filter((e) => e.type === 'diagnostic')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ level: 'warn' })
  })

  it('leaves an existing verdict alone: a failing test that also failed to clean up is still failed', async () => {
    const registry = await registryWith(shop)
    const outcome = await runTests(registry, [
      {
        name: 't',
        steps: [{ type: 'open', name: 'ada', assert: [{ type: 'status', expected: 500 }] }],
        cleanup: [{ type: 'boom' }]
      }
    ])

    expect(outcome.tests[0]!.status).toBe('failed')
  })

  it('checks setup and cleanup against the grammar, and points at the block they are in', async () => {
    const registry = await registryWith(shop)
    const diagnostics = validateTests(registry, [
      {
        name: 't',
        source: 'suites/t.yaml',
        setup: [{ type: 'opne', name: 'ada' }],
        steps: [{ type: 'open', name: 'ada' }],
        cleanup: [{ type: 'clsoe', name: 'ada' }]
      }
    ])

    expect(diagnostics.map((d) => d.path)).toEqual(['setup[0].type', 'cleanup[0].type'])
  })
})

describe("a test's variables", () => {
  /**
   * A provider that answers differently every time it is asked. Everything
   * below is about *when* it is asked, which is the whole of what makes
   * `variables` more than a dictionary.
   */
  const counting = definePlugin({
    name: 'counting',
    setup(ctx) {
      let n = 0
      ctx.defineValueProvider('tick', { prefix: 'tick', resolve: () => `${++n}` })
      ctx.defineValueProvider('boom', {
        prefix: 'boom',
        resolve: () => { throw new Error('the vault is down') }
      })
    }
  })

  it('binds them before anything runs, and keeps them for the whole test', async () => {
    const registry = await registryWith(shop, counting)
    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { who: 'ada' },
        setup: [{ type: 'open', name: '${who}' }],
        steps: [{ type: 'open', name: '${who}' }],
        assert: [{ type: 'named', expected: '${who}' }],
        cleanup: [{ type: 'close', name: '${who}' }]
      }
    ])

    expect(outcome.tests[0]!.status).toBe('passed')
    expect(outcome.tests[0]!.steps.map((s) => s.result)).toEqual([
      { name: 'ada', status: 200 },
      { name: 'ada', status: 200 },
      { closed: 'ada' }
    ])
  })

  it('resolves one at a time, so two givens that generate are two values', async () => {
    const registry = await registryWith(shop, counting)
    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { first: '${tick:x}', second: '${tick:x}' },
        steps: [{ type: 'open', name: '${first}-${second}' }]
      }
    ])

    // Not '1-1'. A single resolution pass asks a provider once per key, which
    // is right for a lookup and fatal for a generator: the test that exists to
    // prove two tenants stay apart would have been testing one against itself.
    expect(outcome.tests[0]!.steps[0]!.result).toMatchObject({ name: '1-2' })
  })

  it('lets a given be written in terms of the one above it', async () => {
    const registry = await registryWith(shop, counting)
    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { slug: '${tick:x}', email: 'speq-${slug}@example.com' },
        steps: [{ type: 'open', name: '${email}' }]
      }
    ])

    expect(outcome.tests[0]!.steps[0]!.result).toMatchObject({ name: 'speq-1@example.com' })
  })

  it('asks a provider once per given, not once per mention of it', async () => {
    const registry = await registryWith(shop, counting)
    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { pair: '${tick:x}/${tick:x}' },
        steps: [{ type: 'open', name: '${pair}' }]
      }
    ])

    expect(outcome.tests[0]!.steps[0]!.result).toMatchObject({ name: '1/1' })
  })

  it('does not begin the test at all when a given cannot be resolved', async () => {
    const registry = await registryWith(shop, counting)
    const seen: RunEvent[] = []
    registry.events.subscribe((e) => seen.push(e))

    const outcome = await runTests(registry, [
      {
        name: 't',
        variables: { token: '${boom:secret}' },
        setup: [{ type: 'open', name: 'ada' }],
        steps: [{ type: 'open', name: 'ada' }],
        cleanup: [{ type: 'close', name: 'ada' }]
      }
    ])

    // Nothing ran, so there is nothing to take down either — a cleanup here
    // would be written in terms of the given that never arrived.
    expect(outcome.tests[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps).toEqual([])
    const problems = seen.filter((e) => e.type === 'diagnostic')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ level: 'error' })
    expect((problems[0] as { message: string }).message).toContain("variable 'token'")
  })

  it('warns when a given and a step id are the same name', async () => {
    const registry = await registryWith(shop)
    const diagnostics = validateTests(registry, [
      {
        name: 't',
        source: 'suites/t.yaml',
        variables: { shop: 'ada' },
        steps: [{ id: 'shop', type: 'open', name: '${shop}' }]
      }
    ])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.path).toBe('variables.shop')
    expect(diagnostics[0]!.message).toContain('also a step id')
  })
})

/**
 * Annotations: what a test says about itself that the kernel carries and does
 * not read. The whole of the design is in what these tests do *not* assert —
 * nothing here changes what runs, in what order, or whether it passes.
 */
describe('a test carries what it says about itself', () => {
  const annotated = definePlugin({
    name: 'annotated',
    setup(ctx) {
      ctx.defineStepType('label', {
        // Closed on purpose: this is the plugin that would reject `owner:`
        // beside its own input, and would be right to.
        schema: { type: 'object', properties: { text: {} }, additionalProperties: false },
        execute: (_exec, input) => ({ text: input.text })
      })
      ctx.defineAssertion('is', {
        schema: { type: 'object', properties: { expected: {} }, additionalProperties: false },
        evaluate: (assert, input) => ({
          passed: assert.last?.text === input.expected,
          message: `text ${String(assert.last?.text)}`
        })
      })
    }
  })

  it('puts a test annotation on the event every reporter reads', async () => {
    const registry = await registryWith(annotated)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))

    await runTests(registry, [{
      name: 'renames a tenant',
      title: 'PATCH /tenants/{id} renames a tenant',
      meta: { owner: 'mira', epic: 'menu' },
      steps: [{ type: 'label', text: 'hi' }]
    }])

    const started = events.find((e) => e.type === 'test.started')
    expect(started).toMatchObject({
      title: 'PATCH /tenants/{id} renames a tenant',
      meta: { owner: 'mira', epic: 'menu' }
    })
  })

  it('keeps a step annotation away from the plugin that owns the step', async () => {
    const registry = await registryWith(annotated)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))

    const outcome = await runTests(registry, [{
      name: 't',
      steps: [{ type: 'label', text: 'hi', meta: { name: 'the greeting' } }]
    }])

    // The step ran, so `meta` never reached a schema that closes itself...
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result).toEqual({ text: 'hi' })
    // ...and it still reached the report.
    expect(events.find((e) => e.type === 'step.finished')).toMatchObject({
      meta: { name: 'the greeting' }
    })
  })

  it('accepts an annotation on a step whose schema is closed', async () => {
    const registry = await registryWith(annotated)
    const test = {
      name: 't',
      steps: [{ type: 'label', text: 'hi', meta: { owner: 'mira' } }],
      assert: [{ type: 'is', expected: 'hi', meta: { severity: 'blocker' } }]
    }

    // Without `meta` being lifted before the check, this is two diagnostics
    // reading "unknown field 'owner'" — and the plugin would be right.
    expect(validateTests(registry, [test])).toEqual([])
  })

  it('resolves an annotation for the report, and never at its cost', async () => {
    const registry = await registryWith(annotated)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))

    const outcome = await runTests(registry, [{
      name: 't',
      variables: { slug: 'shop-7' },
      steps: [
        { id: 'a', type: 'label', text: 'hi', meta: { name: 'GET /${slug}/menu' } },
        { type: 'label', text: 'hi', meta: { name: 'reads ${nowhere}' } }
      ]
    }])

    const labels = events
      .filter((e) => e.type === 'step.started')
      .map((e) => (e.type === 'step.started' ? e.meta?.name : undefined))

    // A label is written in terms of the run, so it is resolved. One that
    // cannot be is shown as written — an annotation is never a reason for a
    // test not to run.
    expect(labels).toEqual(['GET /shop-7/menu', 'reads ${nowhere}'])
    expect(outcome.status).toBe('passed')
  })

  it('answers ${meta:…} out of the test that is running', async () => {
    const registry = await registryWith(annotated)

    const outcome = await runTests(registry, [{
      name: 't',
      meta: { owner: 'mira' },
      steps: [{ type: 'label', text: 'owned by ${meta:owner}' }]
    }])

    // The saving: an `x-owner` header on every request needs no plugin, and
    // no ninth contribution point for declaring test fields.
    expect(outcome.tests[0]!.steps[0]!.result).toEqual({ text: 'owned by mira' })
  })

  it('refuses to let a plugin claim the prefix', async () => {
    const thief = definePlugin({
      name: 'thief',
      setup: (ctx) => ctx.defineValueProvider('meta', { prefix: 'meta', resolve: () => 'no' })
    })

    // Shadowing it would work in some projects and not others, and the
    // difference would only ever show up as a header carrying the wrong owner.
    await expect(registryWith(thief)).rejects.toThrow(/reserved by the kernel/)
  })
})
