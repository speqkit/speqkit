import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type TestDef } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'
import data from '@speqkit/plugin-data'
import assert from '@speqkit/plugin-assert'

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
    ctx.defineStepType('echo', {
      // `pause` is how a test here interleaves two suites deliberately.
      async execute(_exec, input) {
        if (input.pause) await new Promise((r) => setTimeout(r, Number(input.pause)))
        return { said: input.said }
      }
    })
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

    // The schema catches this one now, before setup() is even called, and
    // the refusal is the kernel's: a config block that does not match.
    await expect(
      harness(data, { config: { data: { generators: { x: { type: 'uid' } } } } })
    ).rejects.toThrow(/generators.x.type is 'uid', not one of/)
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

describe('set', () => {
  it('binds a value the steps below can read, in the order somebody reads', async () => {
    kit = await harness(data, { with: [echo] })
    const outcome = await kit.run([
      {
        name: 'derives a given from a step',
        steps: [
          { id: 'created', type: 'echo', said: 'order-17' },
          { id: 'order', type: 'set', value: '${created.said}' },
          { id: 'read', type: 'echo', said: 'GET /orders/${order.value}' }
        ]
      }
    ])

    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[2]!.result.said).toBe('GET /orders/order-17')
  })

  it('keeps whatever shape it was given, not only strings', async () => {
    kit = await harness(data, { with: [echo] })
    const step = await kit.step({ type: 'set', value: { id: 7, tags: ['a'] } })

    expect(step.result.value).toEqual({ id: 7, tags: ['a'] })
  })

  it('is checked before it runs, like anything else with a schema', async () => {
    kit = await harness(data, { with: [echo] })
    const diagnostics = kit.validate([
      { name: 't', source: 't.yaml', steps: [{ type: 'set', values: 1 }] }
    ] as Parameters<typeof kit.validate>[0])

    expect(diagnostics.map((d) => d.code).sort()).toEqual(['missing-field', 'unknown-field'])
  })
})

describe('generated values under concurrency', () => {
  /**
   * The claim the seeding exists to make is that a test re-run alone sees the
   * data it saw inside the whole suite. It was made by a `test:before` hook
   * setting a variable to the last test that started — which is adjacency, and
   * suites run at once. Under `--workers 4` the variable held whichever suite
   * got there first, so a value generated for one test was keyed by another's
   * name, and two tests could be handed the same "unique" tenant: the exact
   * failure the seeding is for.
   */
  const suites = [
    {
      name: 'a',
      source: 'suites/one/a.yaml',
      suite: 'suites/one',
      variables: { slug: '${gen:uuid}' },
      steps: [{ type: 'echo', said: '${slug}', pause: 25 }]
    },
    {
      name: 'b',
      source: 'suites/two/b.yaml',
      suite: 'suites/two',
      variables: { slug: '${gen:uuid}' },
      steps: [{ type: 'echo', said: '${slug}' }]
    }
  ]

  const values = (outcome: { tests: { name: string; steps: { result: Record<string, unknown> }[] }[] }) =>
    Object.fromEntries(outcome.tests.map((t) => [t.name, t.steps[0]!.result.said]))

  it('hands each test the same value whether one suite runs or four', async () => {
    kit = await harness(data, { with: [echo], config: { data: { seed: 'fixed' } } })
    const sequential = values(await kit.run(suites as never, [], { concurrency: 1 }))
    await kit.close()

    kit = await harness(data, { with: [echo], config: { data: { seed: 'fixed' } } })
    const concurrent = values(await kit.run(suites as never, [], { concurrency: 4 }))

    expect(concurrent).toEqual(sequential)
    // And the two tests are not each other, which is the half that matters
    // most: a suite proving two tenants stay apart must not be given one.
    expect(concurrent.a).not.toBe(concurrent.b)
  })
})

/**
 * The menu snapshot these two describe blocks work over, cut down from the
 * project M12 is being run against: two categories, and exactly one item with
 * a required option group in it. Which item that is cannot be written as a row
 * number, and that is the whole point.
 */
const menu = {
  categories: [
    {
      name: 'Drinks',
      items: [
        { id: 'water', priceMinor: 15000, optionGroups: [] },
        { id: 'tea', priceMinor: 25000, optionGroups: [{ required: false, options: [{ id: 'lemon', priceDeltaMinor: 5000 }] }] }
      ]
    },
    {
      name: 'Mains',
      items: [
        { id: 'soup', priceMinor: 39000, optionGroups: [{ required: false, options: [{ id: 'bread', priceDeltaMinor: 0 }] }] },
        {
          id: 'burger',
          priceMinor: 45000,
          optionGroups: [
            { required: true, options: [{ id: 'plain', priceDeltaMinor: 0 }, { id: 'bacon', priceDeltaMinor: 9000 }] }
          ]
        }
      ]
    }
  ]
}

/** The two steps every one of these starts with: bind the snapshot, choose from it. */
const choosing = (where: unknown[], from = '${menu.value.categories[*].items[*]}'): unknown[] => [
  { id: 'menu', type: 'set', value: '${snapshot}' },
  { id: 'chosen', type: 'pick', from, where }
]

describe('pick', () => {
  it('finds the element by what is in it, not by where it sits', async () => {
    kit = await harness(data, { with: [assert] })
    const [, chosen] = await kit.steps(
      choosing([{ type: 'contains', path: 'optionGroups[*].required', expected: true }]) as never,
      { snapshot: menu }
    )

    expect(chosen!.status).toBe('passed')
    expect((chosen!.result.value as { id: string }).id).toBe('burger')
    // The row number the suite would otherwise have written. It is 3 today.
    expect(chosen!.result.index).toBe(3)
  })

  /**
   * Narrowing is composed rather than combined: a clause reads a wildcard path
   * as the list it is, so "the option that costs extra" is a second `pick`
   * over the first one's result, where the subject is a single option and
   * `greater_than` has a number to compare.
   */
  it('narrows again over what it just chose', async () => {
    kit = await harness(data, { with: [assert] })
    const [, , option] = await kit.steps(
      [
        ...choosing([{ type: 'contains', path: 'optionGroups[*].required', expected: true }]),
        {
          id: 'option',
          type: 'pick',
          from: '${chosen.value.optionGroups[*].options[*]}',
          where: [{ type: 'greater_than', path: 'priceDeltaMinor', expected: 0 }]
        }
      ] as never,
      { snapshot: menu }
    )

    expect((option!.result.value as { id: string }).id).toBe('bacon')
  })

  /**
   * The failure that matters. A filter matching nothing must not read like a
   * filter that matched, and it has to name the clause that did the excluding
   * — otherwise the author diffs every clause against every element by hand.
   */
  it('says how many it looked at, and what the closest one failed on', async () => {
    kit = await harness(data, { with: [assert] })
    const [, chosen] = await kit.steps(
      choosing([
        { type: 'equals', path: 'id', expected: 'burger' },
        { type: 'equals', path: 'priceMinor', expected: 1 }
      ]) as never,
      { snapshot: menu }
    )

    expect(chosen!.status).toBe('error')
    expect(chosen!.message).toContain('4 examined')
    expect(chosen!.message).toContain('priceMinor')
  })

  it('refuses a clause no loaded plugin can answer, rather than matching nothing', async () => {
    kit = await harness(data, { with: [assert] })
    const [, chosen] = await kit.steps(choosing([{ type: 'approximately', expected: 1 }]) as never, {
      snapshot: menu
    })

    expect(chosen!.status).toBe('error')
    expect(chosen!.message).toContain("unknown assertion 'approximately'")
  })

  it('says so when `from` is not a list at all', async () => {
    kit = await harness(data, { with: [assert] })
    const [, chosen] = await kit.steps(
      choosing([{ type: 'exists', path: 'id' }], '${menu.value.categories}') as never,
      { snapshot: { categories: { first: 'not a list' } } }
    )

    expect(chosen!.status).toBe('error')
    expect(chosen!.message).toContain('pick searches a list')
  })
})

describe('calc', () => {
  const value = (record: { result: Record<string, unknown> }) => record.result.value

  it('works the total out of what the test read, so no constant stands in for it', async () => {
    kit = await harness(data, { with: [assert] })
    const records = await kit.steps(
      [
        ...choosing([{ type: 'contains', path: 'optionGroups[*].required', expected: true }]),
        {
          id: 'option',
          type: 'pick',
          from: '${chosen.value.optionGroups[*].options[*]}',
          where: [{ type: 'greater_than', path: 'priceDeltaMinor', expected: 0 }]
        },
        {
          id: 'total',
          type: 'calc',
          multiply: [{ add: ['${chosen.value.priceMinor}', '${option.value.priceDeltaMinor}'] }, 2]
        }
      ] as never,
      { snapshot: menu }
    )

    expect(records.every((r) => r.status === 'passed')).toBe(true)
    expect(value(records.at(-1)!)).toBe((45000 + 9000) * 2)
  })

  it('sums a wildcard path, because a list operand is its elements', async () => {
    kit = await harness(data)
    const [total] = await kit.steps([{ id: 'total', type: 'calc', add: ['${lines[*].amount}'] }] as never, {
      lines: [{ amount: 100 }, { amount: 250 }, { amount: 7 }]
    })

    expect(value(total!)).toBe(357)
  })

  it('refuses an operand that is not a number, and says what it was instead', async () => {
    kit = await harness(data)
    const [total] = await kit.steps([{ id: 'total', type: 'calc', add: ['${amount}', 1] }] as never, {
      amount: '450.00'
    })

    expect(total!.status).toBe('error')
    expect(total!.message).toContain('"450.00"')
  })

  it('takes exactly two operands from subtract, and complains about a third', async () => {
    kit = await harness(data)
    const [total] = await kit.steps([{ id: 'total', type: 'calc', subtract: [10, 3, 1] }] as never)

    expect(total!.status).toBe('error')
    expect(total!.message).toContain('exactly two operands')
  })
})
