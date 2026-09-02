import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { definePlugin } from '@speqkit/plugin-api'
import { harness } from '@speqkit/test-kit'

/**
 * Three plugins a user would actually want, written against the published API
 * and nothing else — the M3 gate's question asked again, of the cases that
 * decide whether `@speqkit/plugin-api` can be frozen at 1.0.
 *
 *   1. a client we never shipped        — works, no kernel change
 *   2. schemas kept under the speq root — works at run time; cannot report a
 *                                         bad reference at validate time
 *   3. variables a test writes          — works through a value provider;
 *                                         a step cannot bind into its own scope
 *
 * The tests marked THE GAP assert what is *not* possible. They are here so the
 * limits are pinned rather than remembered, and so closing one is a visible
 * change to this file.
 */

/* ---------------- case 1: a mongodb client nobody published ------------- */

interface FakeClient { closed: boolean; docs: Map<string, Record<string, unknown>[]> }
const opened: FakeClient[] = []

const mongo = definePlugin({
  name: 'speqkit-plugin-mongo',
  configSchema: { type: 'object', properties: { url: { type: 'string' }, database: { type: 'string' } } },
  setup(ctx) {
    ctx.defineResource<FakeClient>('mongo.client', {
      scope: 'run',
      setup(res) {
        const { url } = res.config<{ url?: string }>()
        if (!url) throw new Error('mongo.url is not configured')
        const client = { closed: false, docs: new Map() }
        opened.push(client)
        return client
      },
      teardown: (client) => { client.closed = true }
    })
    ctx.defineStepType('mongo.insert', {
      schema: { type: 'object', properties: { collection: {}, document: {} }, required: ['collection', 'document'], additionalProperties: false },
      async execute(exec, input) {
        const client = await exec.resource<FakeClient>('mongo.client')
        const list = client.docs.get(String(input.collection)) ?? []
        list.push(input.document as Record<string, unknown>)
        client.docs.set(String(input.collection), list)
        return { insertedId: `id-${list.length}` }
      }
    })
    ctx.defineStepType('mongo.find', {
      schema: { type: 'object', properties: { collection: {}, where: {} }, required: ['collection'], additionalProperties: false },
      async execute(exec, input) {
        const client = await exec.resource<FakeClient>('mongo.client')
        // The driver would take the signal; this proves one is there to pass.
        expect(exec.signal.aborted).toBe(false)
        const all = client.docs.get(String(input.collection)) ?? []
        const where = (input.where ?? {}) as Record<string, unknown>
        const docs = all.filter((d) => Object.entries(where).every(([k, v]) => d[k] === v))
        return { docs, count: docs.length }
      }
    })
    ctx.defineAssertion('document_count', {
      evaluate: (assert, input) => ({
        passed: assert.last?.count === input.expected,
        message: `found ${String(assert.last?.count)}`
      })
    })
  }
})

describe('case 1 — a plugin for a client we never shipped', () => {
  it('connects once per run, reads its config, and closes after', async () => {
    opened.length = 0
    const kit = await harness(mongo, { config: { mongo: { url: 'mongodb://localhost', database: 'test' } } })

    const outcome = await kit.run([
      { name: 'one', steps: [
        { id: 'ins', type: 'mongo.insert', collection: 'users', document: { name: 'ada' } },
        { id: 'found', type: 'mongo.find', collection: 'users', where: { name: 'ada' } }
      ], assert: [{ type: 'document_count', expected: 1 }] },
      { name: 'two', steps: [{ id: 'f', type: 'mongo.find', collection: 'users' }] }
    ])
    await kit.close()

    expect(outcome.status).toBe('passed')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.closed).toBe(true)
    expect(outcome.tests[1]!.steps[0]!.result.count).toBe(1)
  })

  it('fails the run with the message the plugin gave when config is missing', async () => {
    const kit = await harness(mongo)
    const outcome = await kit.run([{ name: 't', steps: [{ type: 'mongo.find', collection: 'users' }] }])
    await kit.close()

    expect(outcome.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.message).toContain('mongo.url is not configured')
  })
})

/* ---------------- case 2: schemas kept in .speq/ ------------------------ */

const schemaPlugin = definePlugin({
  name: 'speqkit-plugin-schema',
  setup(ctx) {
    // Read at setup: is there a root this early?
    const dir = join(ctx.host.root, 'schemas')

    const fileFor = (name: unknown) => join(dir, `${String(name)}.json`)

    ctx.defineAssertion('matches_schema', {
      schema: { type: 'object', properties: { schema: { type: 'string' } }, required: ['schema'], additionalProperties: false },

      // Shape is the schema's job; this is whether the reference means
      // anything. It runs in front of the run, not in the middle of it.
      validate(assertion) {
        if (typeof assertion.schema !== 'string') return
        if (existsSync(fileFor(assertion.schema))) return
        return [{
          path: 'schema',
          message: `no schema '${assertion.schema}.json' in ${dir}`,
          hint: `available: ${schemaNames(dir).join(', ') || '(none)'}`
        }]
      },

      evaluate(assert, input) {
        const file = fileFor(input.schema)
        if (!existsSync(file)) {
          return { passed: false, message: `no schema '${String(input.schema)}.json' in ${dir}` }
        }
        const schema = JSON.parse(readFileSync(file, 'utf8')) as { required?: string[] }
        const body = (assert.last?.body ?? {}) as Record<string, unknown>
        const missing = (schema.required ?? []).filter((k) => body[k] === undefined)
        return {
          passed: missing.length === 0,
          message: missing.length ? `missing ${missing.join(', ')}` : 'matches',
          expected: schema.required,
          actual: Object.keys(body)
        }
      }
    })
  }
})

const producer = definePlugin({
  name: 'producer',
  setup: (ctx) => ctx.defineStepType('respond', { execute: (_e, i) => ({ body: i.body }) })
})

describe('case 2 — schemas stored under the speq root', () => {
  it('finds the root during setup and reads the file at assert time', async () => {
    const kit = await harness(schemaPlugin, { with: [producer] })
    kit.file('schemas/user.json', JSON.stringify({ required: ['id', 'email'] }))

    await kit.step({ type: 'respond', body: { id: 1, email: 'a@b.c' } })
    const good = await kit.assert({ type: 'matches_schema', schema: 'user' })

    await kit.step({ type: 'respond', body: { id: 1 } })
    const bad = await kit.assert({ type: 'matches_schema', schema: 'user' })
    await kit.close()

    expect(good.passed).toBe(true)
    expect(bad).toMatchObject({ passed: false, message: 'missing email' })
  })

  it('says at validate time that the schema file is missing', async () => {
    const kit = await harness(schemaPlugin, { with: [producer] })
    kit.file('schemas/user.json', '{}')

    const diagnostics = kit.validate([
      { name: 't', steps: [{ type: 'respond' }], assert: [{ type: 'matches_schema', schema: 'nope' }], source: 'a.yaml' }
    ])
    await kit.close()

    expect(diagnostics).toEqual([
      {
        file: 'a.yaml',
        path: 'assert[0].schema',
        code: 'schema/invalid',
        message: expect.stringContaining("no schema 'nope.json'"),
        hint: 'available: user'
      }
    ])
  })

  it('passes a test whose reference is good', async () => {
    const kit = await harness(schemaPlugin, { with: [producer] })
    kit.file('schemas/user.json', '{}')

    const diagnostics = kit.validate([
      { name: 't', steps: [{ type: 'respond' }], assert: [{ type: 'matches_schema', schema: 'user' }], source: 'a.yaml' }
    ])
    await kit.close()

    expect(diagnostics).toEqual([])
  })
})

function schemaNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  } catch {
    return []
  }
}

/* ---------------- case 3: variables written by a test ------------------- */

describe('case 3 — a test writes a variable and reuses it', () => {
  function varsPlugin() {
    const bag = new Map<string, unknown>()
    return definePlugin({
      name: 'speqkit-plugin-vars',
      setup(ctx) {
        ctx.defineStepType('vars.set', {
          execute(_exec, input) {
            for (const [k, v] of Object.entries(input)) bag.set(k, v)
            return { ...input }
          }
        })
        ctx.defineValueProvider('vars', {
          prefix: 'vars',
          resolve(key) {
            if (!bag.has(key)) throw new Error(`\${vars:${key}} was never set`)
            return bag.get(key)
          }
        })
        ctx.defineStepType('vars.slow', {
          execute: (_e, input) => ({ got: input.value })
        })
        ctx.defineValueProvider('slow', { prefix: 'slow', resolve: async (key) => `async-${key}` })
      }
    })
  }

  const echo = definePlugin({
    name: 'echo',
    setup: (ctx) => ctx.defineStepType('echo', { execute: (_e, i) => ({ value: i.value }) })
  })

  it('reads back a variable a later step wrote', async () => {
    const kit = await harness(varsPlugin(), { with: [echo] })
    await kit.step({ type: 'vars.set', token: 'abc123' })
    const later = await kit.step({ type: 'echo', value: '${vars:token}' })
    await kit.close()

    expect(later.result.value).toBe('abc123')
  })

  it('carries it across tests, which step results do not', async () => {
    const kit = await harness(varsPlugin(), { with: [echo] })
    const outcome = await kit.run([
      { name: 'writes', steps: [{ type: 'vars.set', token: 'abc123' }] },
      { name: 'reads', steps: [{ id: 'r', type: 'echo', value: '${vars:token}' }] }
    ])
    await kit.close()

    expect(outcome.status).toBe('passed')
    expect(outcome.tests[1]!.steps[0]!.result.value).toBe('abc123')
  })

  it('cannot put a bare ${token} in the scope for the next sibling step', async () => {
    const kit = await harness(varsPlugin(), { with: [echo] })
    await kit.step({ type: 'vars.set', token: 'abc123' })
    const later = await kit.step({ type: 'echo', value: '${token}' })
    await kit.close()

    // THE GAP: a step type can bind only under its own id. There is no
    // exec.set(), and ctx.vars is a frozen copy.
    expect(later.status).toBe('error')
    expect(later.message).toContain("'token' is not defined")
  })

  it('shows a step only the innermost frame through exec.vars', async () => {
    const looker = definePlugin({
      name: 'looker',
      setup: (ctx) => {
        ctx.defineStepType('look', { execute: (exec) => ({ seen: Object.keys(exec.vars) }) })
        ctx.defineStepType('wrap', {
          execute: (exec, input) => exec.runSteps(input.steps as never[], { vars: { inner: 1 } }).then((r) => ({ r }))
        })
      }
    })
    const kit = await harness(looker)
    const outer = await kit.step({ type: 'look' }, { outer: 1 })
    const nested = await kit.step({ type: 'wrap', steps: [{ type: 'look' }] })
    await kit.close()

    expect(outer.result.seen).toEqual(['outer'])
    // THE GAP: `vars` is the innermost frame, not what is visible. Inside a
    // loop body the enclosing test's bindings are gone from it, though
    // `${...}` still resolves them.
    expect(((nested.result.r as { result: { seen: string[] } }[])[0]!).result.seen).toEqual(['inner'])
  })

  it('awaits a value provider that answers asynchronously', async () => {
    const kit = await harness(varsPlugin(), { with: [echo] })
    const step = await kit.step({ type: 'echo', value: '${slow:key}' })
    await kit.close()

    // Was the fourth gap, and the one that blocked the freeze: `resolve` is
    // declared as maybe-async and the kernel now awaits it, rather than
    // putting the Promise itself into the step's input.
    expect(step.result.value).toBe('async-key')
  })
})
