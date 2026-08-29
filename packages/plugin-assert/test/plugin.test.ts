import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { definePlugin, type AssertionDef } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'
import assertions from '@speqkit/plugin-assert'

/**
 * Written through `@speqkit/test-kit`, against the real kernel: a step runs,
 * and the assertion is evaluated against what it left behind, exactly as a
 * test file would have it.
 */

let kit: Harness
let root: string

/** Stands in for whatever produced the result — the plugin knows no protocol. */
const responder = definePlugin({
  name: 'responder',
  setup(ctx) {
    ctx.defineStepType('respond', { execute: (_exec, input) => input.with as Record<string, unknown> })
  }
})

const RESPONSE = {
  status: 201,
  text: '{"name":"speq-item","tags":["new","featured"]}',
  body: {
    name: 'speq-item',
    price_cents: 450,
    tags: ['new', 'featured'],
    items: [{ sku: 'ABC-1' }, { sku: 'ABC-2' }],
    restaurant: { id: 'r-1', slug: 'speq-slug' },
    deleted_at: null
  }
}

async function given(response: Record<string, unknown> = RESPONSE): Promise<Harness> {
  kit = await harness(assertions, { with: [responder], root })
  await kit.step({ type: 'respond', with: response })
  return kit
}

/** One assertion against the standing result, reduced to pass/fail and why. */
async function check(assertion: AssertionDef) {
  const outcome = await kit.assert(assertion)
  return { passed: outcome.passed, message: outcome.message }
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'speq-assert-')) })
afterEach(async () => {
  await kit?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the selector', () => {
  it('reads into the whole result, not into a body it assumes is there', async () => {
    await given()

    expect((await check({ type: 'equals', path: 'status', expected: 201 })).passed).toBe(true)
    expect((await check({ type: 'equals', path: 'body.restaurant.slug', expected: 'speq-slug' })).passed).toBe(true)
    expect((await check({ type: 'equals', path: 'body.items[1].sku', expected: 'ABC-2' })).passed).toBe(true)
  })

  it('takes an explicit value, for the checks that are not about the last step', async () => {
    kit = await harness(assertions, { with: [responder], root })
    await kit.step({ id: 'created', type: 'respond', with: RESPONSE })
    await kit.step({ type: 'respond', with: { body: { name: 'something else' } } })

    // Resolved by the kernel before the assertion sees it, like any input —
    // which is how a test asserts on a step that is no longer the last one.
    const outcome = await check({ type: 'equals', value: '${created.body.name}', expected: 'speq-item' })
    expect(outcome.passed).toBe(true)
  })

  it('says a field is not there rather than comparing against nothing', async () => {
    await given()
    const outcome = await check({ type: 'at_least', path: 'body.discount', expected: 10 })

    // "got undefined" reads like a wrong number. It is a missing field.
    expect(outcome.passed).toBe(false)
    expect(outcome.message).toBe('body.discount is not there')
  })
})

describe('equality and order', () => {
  it('compares structurally, so key order is not a difference', async () => {
    await given({ body: { a: 1, b: { c: 2, d: 3 } } })

    expect((await check({ type: 'equals', path: 'body', expected: { b: { d: 3, c: 2 }, a: 1 } })).passed).toBe(true)
    expect((await check({ type: 'not_equals', path: 'body', expected: { a: 1 } })).passed).toBe(true)
  })

  it('orders numbers, inclusively where the word says so', async () => {
    await given()
    const price = (type: string, expected: number) => check({ type, path: 'body.price_cents', expected })

    expect((await price('greater_than', 449)).passed).toBe(true)
    expect((await price('greater_than', 450)).passed).toBe(false)
    expect((await price('at_least', 450)).passed).toBe(true)
    expect((await price('less_than', 451)).passed).toBe(true)
    expect((await price('at_most', 450)).passed).toBe(true)
    expect((await price('at_most', 449)).passed).toBe(false)
  })

  it('orders dates, because an ISO date compares the way it reads', async () => {
    await given({ body: { created_at: '2026-08-29T10:00:00Z' } })

    expect((await check({
      type: 'greater_than', path: 'body.created_at', expected: '2026-01-01T00:00:00Z'
    })).passed).toBe(true)
  })

  it('refuses to order two things that are not comparable', async () => {
    await given()
    const outcome = await check({ type: 'at_least', path: 'body.name', expected: 10 })

    expect(outcome.passed).toBe(false)
  })
})

describe('membership, from both sides', () => {
  it('contains: a substring of a string, an element of an array, a key of an object', async () => {
    await given()

    expect((await check({ type: 'contains', path: 'text', expected: 'speq-item' })).passed).toBe(true)
    expect((await check({ type: 'contains', path: 'body.tags', expected: 'featured' })).passed).toBe(true)
    expect((await check({ type: 'contains', path: 'body.restaurant', expected: 'slug' })).passed).toBe(true)
    expect((await check({ type: 'not_contains', path: 'text', expected: 'password' })).passed).toBe(true)
  })

  it('contains: an element that is an object, compared structurally', async () => {
    await given()

    expect((await check({ type: 'contains', path: 'body.items', expected: { sku: 'ABC-1' } })).passed).toBe(true)
    expect((await check({ type: 'contains', path: 'body.items', expected: { sku: 'ZZ-9' } })).passed).toBe(false)
  })

  it('one_of: the subject is one of the listed values', async () => {
    await given({ body: { status: 'stop_list' } })

    expect((await check({
      type: 'one_of', path: 'body.status', expected: ['active', 'stop_list', 'deleted_in_pos']
    })).passed).toBe(true)
    expect((await check({ type: 'not_one_of', path: 'body.status', expected: ['deleted'] })).passed).toBe(true)
  })
})

describe('text', () => {
  it('matches a regular expression, with flags when asked', async () => {
    await given({ body: { token: 'aaa.bbb.ccc' } })

    expect((await check({
      type: 'matches', path: 'body.token', expected: '^[a-z]+\\.[a-z]+\\.[a-z]+$'
    })).passed).toBe(true)
    expect((await check({ type: 'matches', path: 'body.token', expected: '^AAA', flags: 'i' })).passed).toBe(true)
  })

  it('starts and ends with', async () => {
    await given()

    expect((await check({ type: 'starts_with', path: 'body.name', expected: 'speq-' })).passed).toBe(true)
    expect((await check({ type: 'ends_with', path: 'body.name', expected: '-item' })).passed).toBe(true)
    expect((await check({ type: 'starts_with', path: 'body.name', expected: 'item' })).passed).toBe(false)
  })
})

describe('presence', () => {
  it('tells a missing field from one that is there and null', async () => {
    await given()

    expect((await check({ type: 'exists', path: 'body.name' })).passed).toBe(true)
    // Present in the payload, but null is not a value a test can use.
    expect((await check({ type: 'exists', path: 'body.deleted_at' })).passed).toBe(false)
    expect((await check({ type: 'missing', path: 'body.password' })).passed).toBe(true)
    expect((await check({ type: 'missing', path: 'body.name' })).passed).toBe(false)
  })

  it('empties: a string, a list, an object, and nothing at all', async () => {
    await given({ body: { s: '', list: [], obj: {}, filled: [1] } })

    expect((await check({ type: 'empty', path: 'body.s' })).passed).toBe(true)
    expect((await check({ type: 'empty', path: 'body.list' })).passed).toBe(true)
    expect((await check({ type: 'empty', path: 'body.obj' })).passed).toBe(true)
    expect((await check({ type: 'empty', path: 'body.absent' })).passed).toBe(true)
    expect((await check({ type: 'not_empty', path: 'body.filled' })).passed).toBe(true)
  })
})

describe('size and shape', () => {
  it('counts a list, a string and an object', async () => {
    await given()

    expect((await check({ type: 'length', path: 'body.items', expected: 2 })).passed).toBe(true)
    expect((await check({ type: 'length', path: 'body.name', expected: 9 })).passed).toBe(true)
    expect((await check({ type: 'length', path: 'body.restaurant', expected: 2 })).passed).toBe(true)
  })

  it('bounds a length, because "at least one item" is the common question', async () => {
    await given()

    expect((await check({ type: 'length', path: 'body.items', at_least: 1 })).passed).toBe(true)
    expect((await check({ type: 'length', path: 'body.items', at_least: 1, at_most: 2 })).passed).toBe(true)
    expect((await check({ type: 'length', path: 'body.items', at_least: 3 })).passed).toBe(false)
  })

  it('names a type, telling an integer from a number and an array from an object', async () => {
    await given()

    expect((await check({ type: 'is_type', path: 'body.items', expected: 'array' })).passed).toBe(true)
    expect((await check({ type: 'is_type', path: 'body.restaurant', expected: 'object' })).passed).toBe(true)
    expect((await check({ type: 'is_type', path: 'body.price_cents', expected: 'integer' })).passed).toBe(true)
    expect((await check({ type: 'is_type', path: 'body.price_cents', expected: 'number' })).passed).toBe(true)
    expect((await check({ type: 'is_type', path: 'body.deleted_at', expected: 'null' })).passed).toBe(true)
    expect((await check({ type: 'is_type', path: 'body.name', expected: 'number' })).passed).toBe(false)
  })
})

describe('a message a reader can act on', () => {
  it('says what was expected, of what, and what was there instead', async () => {
    await given()
    const outcome = await check({ type: 'at_least', path: 'body.price_cents', expected: 900 })

    expect(outcome.message).toBe('expected body.price_cents to be at least 900, got 450')
  })

  it('says what held, when it held', async () => {
    await given()
    const outcome = await check({ type: 'equals', path: 'body.restaurant.slug', expected: 'speq-slug' })

    expect(outcome.message).toBe('body.restaurant.slug is "speq-slug"')
  })
})

describe('schema', () => {
  const write = (relative: string, content: string) => {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }

  const ERROR_ENVELOPE = JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string', minLength: 1 } }
  })

  it('validates against a draft-07 file, keywords and all', async () => {
    write('schemas/common/error.schema.json', ERROR_ENVELOPE)
    write('schemas/list.schema.json', JSON.stringify({
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { enum: ['active', 'stop_list'] }
        }
      }
    }))

    await given({ body: { error: 'table not found' } })
    expect((await check({
      type: 'schema', path: 'body', ref: 'common/error.schema.json'
    })).passed).toBe(true)

    await kit.step({
      type: 'respond',
      with: { body: [{ id: '0f9c2a7e-1111-4222-8333-444455556666', status: 'active' }] }
    })
    expect((await check({ type: 'schema', path: 'body', ref: 'list.schema.json' })).passed).toBe(true)
  })

  it('says which part of the payload did not match', async () => {
    write('schemas/common/error.schema.json', ERROR_ENVELOPE)
    await given({ body: { error: '' } })

    const outcome = await check({ type: 'schema', path: 'body', ref: 'common/error.schema.json' })
    expect(outcome.passed).toBe(false)
    expect(outcome.message).toContain('/error')
    expect(outcome.message).toContain('fewer than 1 characters')
  })

  it('refuses a schema that is not on disk, before the run', async () => {
    kit = await harness(assertions, { with: [responder], root })
    const diagnostics = kit.validate([
      {
        name: 't',
        source: 'suites/t.yaml',
        steps: [{ type: 'respond', with: {} }],
        assert: [{ type: 'schema', path: 'body', ref: 'nope.schema.json' }]
      }
    ])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.path).toBe('assert[0].ref')
    expect(diagnostics[0]!.message).toContain('no such schema')
  })

  it('refuses a schema file that is broken, before the run', async () => {
    // Compiled during validation, not at the first assertion: a schema with a
    // typo in it is a broken test, and the run has not started yet.
    write('schemas/bad.schema.json', JSON.stringify({ type: 'objct' }))
    kit = await harness(assertions, { with: [responder], root })
    const diagnostics = kit.validate([
      {
        name: 't',
        source: 'suites/t.yaml',
        steps: [{ type: 'respond', with: {} }],
        assert: [{ type: 'schema', path: 'body', ref: 'bad.schema.json' }]
      }
    ])

    expect(diagnostics[0]!.message).toContain('not a valid schema')
  })
})

describe('what it refuses before the run', () => {
  const validating = async (assertion: AssertionDef) => {
    kit = await harness(assertions, { with: [responder], root })
    return kit.validate([
      { name: 't', source: 'suites/t.yaml', steps: [{ type: 'respond', with: {} }], assert: [assertion] }
    ])
  }

  it('a path written the way v1 wrote it, with the fix in the hint', async () => {
    const diagnostics = await validating({ type: 'equals', path: '$.name', expected: 'x' })

    expect(diagnostics[0]!.message).toContain('v1 spelling')
    expect(diagnostics[0]!.hint).toContain("'body.name'")
  })

  it('two selectors, because an assertion looks at one thing', async () => {
    const diagnostics = await validating({ type: 'equals', path: 'body', value: 'x', expected: 'y' })

    expect(diagnostics[0]!.message).toContain('exclude each other')
  })

  it('a length with no bound at all', async () => {
    const diagnostics = await validating({ type: 'length', path: 'body.items' })

    expect(diagnostics[0]!.message).toContain("one of 'expected', 'at_least' or 'at_most'")
  })

  it('a regular expression that is not one', async () => {
    const diagnostics = await validating({ type: 'matches', path: 'body.name', expected: '[unclosed' })

    expect(diagnostics[0]!.path).toBe('assert[0].expected')
    expect(diagnostics[0]!.message).toContain('not a regular expression')
  })

  it('a missing expected, from the schema the kernel checks', async () => {
    const diagnostics = await validating({ type: 'equals', path: 'body.name' })

    expect(diagnostics[0]!.message).toContain("missing required field 'expected'")
  })

  it('suggests the right word when the type is nearly one', async () => {
    const diagnostics = await validating({ type: 'euqals', path: 'body.name', expected: 'x' })

    expect(diagnostics[0]!.hint).toContain('equals')
  })
})

describe('the two names that moved out of plugin-http', () => {
  it('still work, and say what to write instead', async () => {
    await given()

    const json = await check({ type: 'jsonpath', path: 'restaurant.slug', expected: 'speq-slug' })
    expect(json.passed).toBe(true)
    expect(json.message).toContain("'equals' with 'path: body.…'")

    const text = await check({ type: 'body_contains', expected: 'speq-item' })
    expect(text.passed).toBe(true)
  })
})
