import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type TestDef } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'
import data from '@speqkit/plugin-data'

/**
 * Written through `@speqkit/test-kit`, against the real kernel.
 *
 * Most of these go through `kit.run` rather than `kit.step`, because what is
 * being pinned is not what a generator returns — it is when it is asked, and
 * how much of that answer survives a re-run.
 */

let kit: Harness

/** Somewhere for a resolved value to land where a test can read it back. */
const echo = definePlugin({
  name: 'echo',
  setup(ctx) {
    ctx.defineStepType('echo', { execute: (_exec, input) => ({ said: input.said }) })
  }
})

afterEach(async () => { await kit?.close() })

const said = (outcome: { tests: { steps: { result: Record<string, unknown> }[] }[] }, n = 0) =>
  String(outcome.tests[n]!.steps[0]!.result.said)

const echoing = (name: string, variables: Record<string, unknown>): TestDef => ({
  name,
  variables,
  steps: [{ type: 'echo', said: `\${${Object.keys(variables)[0]!}}` }]
})

describe('gen', () => {
  it('makes a uuid that is one', async () => {
    kit = await harness(data, { with: [echo] })
    const outcome = await kit.run([echoing('t', { slug: '${gen:uuid}' })])

    expect(said(outcome)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('gives two tenants two slugs', async () => {
    kit = await harness(data, { with: [echo] })
    const outcome = await kit.run([
      {
        name: 't',
        variables: { slug: '${gen:uuid}', foreignSlug: '${gen:uuid}' },
        steps: [{ type: 'echo', said: '${slug}|${foreignSlug}' }]
      }
    ])

    const [slug, foreign] = said(outcome).split('|')
    expect(slug).not.toBe(foreign)
  })

  it('gives two tests two slugs, so one run never collides with itself', async () => {
    kit = await harness(data, { with: [echo] })
    const outcome = await kit.run([
      echoing('first', { slug: '${gen:uuid}' }),
      echoing('second', { slug: '${gen:uuid}' })
    ])

    expect(said(outcome, 0)).not.toBe(said(outcome, 1))
  })

  it('gives two runs two slugs, so a run never collides with yesterday', async () => {
    const once = async () => {
      const k = await harness(data, { with: [echo] })
      try { return said(await k.run([echoing('t', { slug: '${gen:uuid}' })])) } finally { await k.close() }
    }

    expect(await once()).not.toBe(await once())
  })

  it('repeats itself exactly when told which seed to use', async () => {
    const once = async () => {
      const k = await harness(data, { with: [echo], config: { data: { seed: 'a-run-worth-repeating' } } })
      try { return said(await k.run([echoing('t', { slug: '${gen:uuid}' })])) } finally { await k.close() }
    }

    expect(await once()).toBe(await once())
  })

  it('gives a test the same data whether it runs alone or inside the suite', async () => {
    const withSeed = async (tests: TestDef[]) => {
      const k = await harness(data, { with: [echo], config: { data: { seed: 'fixed' } } })
      try { return await k.run(tests) } finally { await k.close() }
    }

    // The point of re-running one failing test out of sixty is to see what it
    // saw. Deriving each value from the test's own name rather than drawing
    // from a shared stream is what makes that true.
    const alone = await withSeed([echoing('third', { slug: '${gen:uuid}' })])
    const together = await withSeed([
      echoing('first', { slug: '${gen:uuid}' }),
      echoing('second', { slug: '${gen:uuid}' }),
      echoing('third', { slug: '${gen:uuid}' })
    ])

    expect(said(alone)).toBe(said(together, 2))
  })

  it('builds an email nobody else in the run will be handed', async () => {
    kit = await harness(data, { with: [echo], config: { data: { emailDomain: 'speq.test' } } })
    const tests = Array.from({ length: 50 }, (_, i) => echoing(`t${i}`, { mail: '${gen:email}' }))
    const outcome = await kit.run(tests)

    const addresses = outcome.tests.map((_, i) => said(outcome, i))
    expect(new Set(addresses).size).toBe(50)
    expect(addresses[0]).toMatch(/^speq-[0-9a-f]{16}@speq\.test$/)
  })

  it('keeps a generated string legal where a slug is expected', async () => {
    kit = await harness(data, { with: [echo] })
    const outcome = await kit.run([echoing('t', { name: '${gen:string}' })])

    expect(said(outcome)).toMatch(/^[a-z0-9]{16}$/)
  })

  it('takes its parameters from a generator declared once in the config', async () => {
    kit = await harness(data, {
      with: [echo],
      config: {
        data: {
          generators: {
            price: { type: 'int', min: 100, max: 999 },
            shortName: { type: 'string', minLength: 8, maxLength: 8 },
            born: { type: 'date', from: '1990-01-01', to: '1990-12-31' }
          }
        }
      }
    })
    const outcome = await kit.run([
      echoing('t', { price: '${gen:price}' }),
      echoing('n', { shortName: '${gen:shortName}' }),
      echoing('d', { born: '${gen:born}' })
    ])

    expect(Number(said(outcome, 0))).toBeGreaterThanOrEqual(100)
    expect(Number(said(outcome, 0))).toBeLessThanOrEqual(999)
    expect(said(outcome, 1)).toHaveLength(8)
    expect(said(outcome, 2)).toMatch(/^1990-\d{2}-\d{2}$/)
  })

  it('keeps the type of what it generated when a template is nothing else', async () => {
    kit = await harness(data, { with: [echo], config: { data: { generators: { n: { type: 'int' } } } } })
    const step = await kit.step({ type: 'echo', said: '${gen:n}' })

    expect(typeof step.result.said).toBe('number')
  })

  it('says what generators exist when asked for one that does not', async () => {
    kit = await harness(data, { with: [echo] })
    const outcome = await kit.run([echoing('t', { x: '${gen:uuidv4}' })])

    expect(outcome.tests[0]!.status).toBe('error')
    const problem = kit.events.find((e) => e.type === 'diagnostic') as { message: string }
    expect(problem.message).toContain('names no generator')
    expect(problem.message).toContain('date, email, int, string, uuid')
  })

  it('refuses a generator the config got wrong, before a single test runs', async () => {
    await expect(
      harness(data, { config: { data: { generators: { price: { type: 'int', min: 900, max: 100 } } } } })
    ).rejects.toThrow(/min 900 is above max 100/)

    await expect(
      harness(data, { config: { data: { generators: { x: { type: 'uid' } } } } })
    ).rejects.toThrow(/is not a generator type/)
  })

  /**
   * The one place two mentions are one value. Resolution asks a provider once
   * per pass and a step input is one pass — right for a lookup, and a corner a
   * generator has to be honest about. A given is its own pass, which is why
   * two independent values are declared rather than inlined.
   */
  it('is one value per resolution: twice in one step is once', async () => {
    kit = await harness(data, { with: [echo] })
    const step = await kit.step({ type: 'echo', said: '${gen:uuid}|${gen:uuid}' })

    const [first, second] = String(step.result.said).split('|')
    expect(first).toBe(second)
  })
})

describe('env', () => {
  afterEach(() => {
    delete process.env.SPEQ_FIXTURE_TOKEN
  })

  it('reads what CI put in the environment', async () => {
    process.env.SPEQ_FIXTURE_TOKEN = 'sekrit'
    kit = await harness(data, { with: [echo] })
    const step = await kit.step({ type: 'echo', said: '${env:SPEQ_FIXTURE_TOKEN}' })

    expect(step.result.said).toBe('sekrit')
  })

  it('takes the fallback when the variable is absent', async () => {
    kit = await harness(data, { with: [echo] })
    const step = await kit.step({ type: 'echo', said: '${env:SPEQ_FIXTURE_TOKEN:-none}' })

    expect(step.result.said).toBe('none')
  })

  it('refuses to quietly become an empty string', async () => {
    // `Bearer ` is a suite that fails for the wrong reason, or worse, passes
    // against nothing.
    kit = await harness(data, { with: [echo] })
    const step = await kit.step({ type: 'echo', said: 'Bearer ${env:SPEQ_FIXTURE_TOKEN}' })

    expect(step.status).toBe('error')
    expect(step.message).toContain('SPEQ_FIXTURE_TOKEN} is not set')
  })
})

describe('vars', () => {
  it('answers with what the project declared, environment by environment', async () => {
    kit = await harness(data, {
      with: [echo],
      config: { data: { vars: { adminApi: '/api/admin/v1' } } }
    })
    const step = await kit.step({ type: 'echo', said: '${vars:adminApi}/restaurants' })

    expect(step.result.said).toBe('/api/admin/v1/restaurants')
  })

  it('lists what is declared when asked for something that is not', async () => {
    kit = await harness(data, { with: [echo], config: { data: { vars: { adminApi: '/a' } } } })
    const step = await kit.step({ type: 'echo', said: '${vars:publicApi}' })

    expect(step.status).toBe('error')
    expect(step.message).toContain('adminApi')
  })
})
