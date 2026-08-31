import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { definePlugin, type RunEvent, type TestDef } from '@speqkit/plugin-api'
import { Registry, discoverTests, runTests, validateTests } from 'speqkit'

/**
 * A suite used to be a file path, which is why nothing could be said about a
 * group of tests except by saying it again in each of them. These pin what a
 * suite is now: a thing with a lifetime, a parent, and something to declare.
 *
 * Driven through a JSON loader rather than the YAML one on purpose. Everything
 * here is the kernel's — the tree, the identity, the inheritance, the
 * expansion of a `cases` table — and a test that reached for `@speqkit/plugin-yaml`
 * to prove it would be proving it about one format.
 */

let trace: string[] = []
let root: string
const roots: string[] = []

beforeEach(() => {
  trace = []
  root = mkdtempSync(join(tmpdir(), 'speq-suites-'))
  roots.push(root)
})

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tools = definePlugin({
  name: 'tools',
  setup(ctx) {
    ctx.defineStepType('note', {
      execute: (_exec, input) => {
        trace.push(String(input.text))
        return { text: input.text }
      }
    })
    ctx.defineStepType('boom', {
      execute: () => {
        throw new Error('staging is down')
      }
    })
    ctx.defineLoader('json', {
      extensions: ['.json'],
      suiteFiles: ['suite'],
      load: (_file, content) => {
        const value = JSON.parse(content) as TestDef | TestDef[]
        return Array.isArray(value) ? value : [value]
      },
      loadSuite: (_file, content) => JSON.parse(content) as never
    })
  }
})

async function project(files: Record<string, unknown>) {
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(body))
  }
  const registry = new Registry()
  await registry.register(tools)
  registry.settle()

  const events: RunEvent[] = []
  registry.events.subscribe((event) => events.push(event))
  const tests = await discoverTests(registry, { root })
  return { registry, events, tests }
}

/** A test that does nothing but say it ran. */
function saying(name: string) {
  return { name, steps: [{ type: 'note', text: name }] }
}

describe('a directory that declares itself a suite', () => {
  it('runs its setup once before the first test and its cleanup after the last', async () => {
    const { registry, tests } = await project({
      'suites/suite.json': {
        setup: [{ type: 'note', text: 'up' }],
        cleanup: [{ type: 'note', text: 'down' }]
      },
      'suites/a.json': saying('a'),
      'suites/b.json': saying('b')
    })

    await runTests(registry, tests)

    // Once, whatever the files under it, and around all of them rather than
    // around each — which is the whole difference between a suite and a
    // directory that happens to hold two files.
    expect(trace).toEqual(['up', 'a', 'b', 'down'])
  })

  it('opens the outer suite before the inner one and closes it after', async () => {
    const { registry, tests } = await project({
      'suites/suite.json': { setup: [{ type: 'note', text: 'root up' }], cleanup: [{ type: 'note', text: 'root down' }] },
      'suites/menu/suite.json': { setup: [{ type: 'note', text: 'menu up' }], cleanup: [{ type: 'note', text: 'menu down' }] },
      'suites/menu/items.json': saying('items')
    })

    await runTests(registry, tests)

    expect(trace).toEqual(['root up', 'menu up', 'items', 'menu down', 'root down'])
  })

  it('names its parent, so a reporter can rebuild the tree', async () => {
    const { registry, events, tests } = await project({
      'suites/suite.json': { title: 'Everything' },
      'suites/menu/suite.json': {},
      'suites/menu/items.json': saying('items')
    })

    await runTests(registry, tests)
    const started = events.filter((e) => e.type === 'suite.started')

    // Nesting is expressed by naming the parent, never by adjacency: under
    // concurrency two trees are being walked at once.
    expect(started.map((e) => [e.suite, e.parent])).toEqual([
      ['suites', undefined],
      ['suites/menu', 'suites'],
      ['suites/menu/items.json', 'suites/menu']
    ])
    expect(started[0]!.title).toBe('Everything')
  })

  it('hands a test its meta, tags and pending, nearest winning', async () => {
    const { tests } = await project({
      'suites/suite.json': { meta: { epic: 'everything', owner: 'platform' }, tags: ['smoke'] },
      'suites/menu/suite.json': { meta: { epic: 'menu' }, tags: ['menu'] },
      'suites/menu/items.json': { name: 'items', tags: ['slow'], meta: { owner: 'mira' }, steps: [{ type: 'note', text: 'items' }] }
    })

    // Merged key by key for meta, and unioned for tags: a label added by a
    // directory and one added by the test are two labels, not a replacement.
    expect(tests[0]!.meta).toEqual({ epic: 'menu', owner: 'mira' })
    expect(tests[0]!.tags).toEqual(['smoke', 'menu', 'slow'])
  })

  it('parks every test under it, and builds nothing for them', async () => {
    const { registry, tests } = await project({
      'suites/suite.json': { pending: 'waiting on staging', setup: [{ type: 'note', text: 'up' }] },
      'suites/a.json': saying('a')
    })

    const outcome = await runTests(registry, tests)

    expect(outcome.tests[0]!.status).toBe('skipped')
    expect(outcome.tests[0]!.pending).toBe('waiting on staging')
    // Nothing was brought into existence for tests nobody is going to look at.
    expect(trace).toEqual([])
  })

  it('blocks every test below when its setup does not complete, and still cleans up', async () => {
    const { registry, events, tests } = await project({
      'suites/suite.json': { setup: [{ type: 'boom' }], cleanup: [{ type: 'note', text: 'down' }] },
      'suites/a.json': saying('a'),
      'suites/b.json': saying('b')
    })

    const outcome = await runTests(registry, tests)

    // Announced and counted rather than quietly missing: a report showing two
    // tests fewer than last week reads as two tests deleted.
    expect(outcome.tests.map((t) => t.status)).toEqual(['error', 'error'])
    expect(trace).toEqual(['down'])
    expect(events.some((e) => e.type === 'diagnostic' && /staging is down/.test(e.message))).toBe(true)
  })

  it('keeps what its setup bound to itself', async () => {
    const { registry, tests } = await project({
      'suites/suite.json': { setup: [{ id: 'seed', type: 'note', text: 'up' }] },
      'suites/a.json': { name: 'a', steps: [{ type: 'note', text: '${seed.text}' }] }
    })

    const outcome = await runTests(registry, tests)

    // A test that could read the suite's bindings would be a different test
    // when run alone, and running one test alone is how a failure gets looked
    // at. What crosses the line is a `suite`-scoped resource, which is declared.
    expect(outcome.tests[0]!.status).toBe('error')
    expect(outcome.tests[0]!.steps[0]!.message).toMatch(/seed/)
  })

  it('opens once however many files under it run at the same time', async () => {
    const { registry, events, tests } = await project({
      'suites/suite.json': { setup: [{ type: 'note', text: 'up' }], cleanup: [{ type: 'note', text: 'down' }] },
      'suites/a.json': saying('a'),
      'suites/b.json': saying('b'),
      'suites/c.json': saying('c'),
      'suites/d.json': saying('d')
    })

    await runTests(registry, tests, { concurrency: 4 })

    // Four workers reach the same parent inside one tick. Without the open
    // being memoised on the node, all four find it unopened and all four run
    // its setup.
    expect(trace.filter((t) => t === 'up')).toEqual(['up'])
    expect(trace.filter((t) => t === 'down')).toEqual(['down'])
    expect(trace[0]).toBe('up')
    expect(trace.at(-1)).toBe('down')
    expect(events.filter((e) => e.type === 'suite.started' && e.suite === 'suites')).toHaveLength(1)
  })

  it('is never a test itself', async () => {
    const { tests } = await project({ 'suites/suite.json': { meta: { epic: 'menu' } } })

    // It has no steps, so a kernel that read it as a test would report an
    // empty test as broken on every run.
    expect(tests).toEqual([])
  })
})

describe('one test, many inputs', () => {
  it('becomes one test per case, each named and each with its own givens', async () => {
    const { tests } = await project({
      'suites/create.json': {
        name: 'menu.create',
        variables: { currency: 'GBP', region: 'uk' },
        cases: [
          { id: 'eur', variables: { currency: 'EUR' } },
          { id: 'usd', variables: { currency: 'USD' } }
        ],
        steps: [{ type: 'note', text: '${currency}' }]
      }
    })

    expect(tests.map((t) => t.name)).toEqual(['menu.create[eur]', 'menu.create[usd]'])
    // The case's givens are laid over the test's, not instead of them.
    expect(tests[0]!.variables).toEqual({ currency: 'EUR', region: 'uk' })
    expect(tests.map((t) => t.group)).toEqual(['menu.create', 'menu.create'])
  })

  it('carries the group into the run, so a report can put the rows back together', async () => {
    const { registry, events, tests } = await project({
      'suites/create.json': {
        name: 'menu.create',
        cases: [{ id: 'eur' }, { id: 'usd' }],
        steps: [{ type: 'note', text: 'made' }]
      }
    })

    const outcome = await runTests(registry, tests)

    expect(outcome.tests.map((t) => t.group)).toEqual(['menu.create', 'menu.create'])
    expect(events.filter((e) => e.type === 'test.started').map((e) => e.group))
      .toEqual(['menu.create', 'menu.create'])
  })

  it('lets one case be parked, labelled or retitled without touching the others', async () => {
    const { tests } = await project({
      'suites/create.json': {
        name: 'menu.create',
        title: 'creates an item',
        tags: ['menu'],
        cases: [
          { id: 'eur' },
          { id: 'jpy', pending: 'no yen in staging', tags: ['slow'], title: 'creates an item, in yen' }
        ],
        steps: [{ type: 'note', text: 'made' }]
      }
    })

    expect(tests[0]!.pending).toBeUndefined()
    expect(tests[1]!.pending).toBe('no yen in staging')
    expect(tests[1]!.tags).toEqual(['menu', 'slow'])
    expect(tests[1]!.title).toBe('creates an item, in yen')
    expect(tests[0]!.title).toBe('creates an item')
  })

  it('addresses one case by name, which is the point of the name', async () => {
    const files = {
      'suites/create.json': {
        name: 'menu.create',
        cases: [{ id: 'eur' }, { id: 'usd' }],
        steps: [{ type: 'note', text: 'made' }]
      },
      'suites/other.json': saying('other')
    }
    const { registry } = await project(files)

    const one = await discoverTests(registry, { root, names: ['menu.create[usd]'] })

    // After reading a report, the thing anybody wants to run is that row.
    expect(one.map((t) => t.name)).toEqual(['menu.create[usd]'])
  })

  it('leaves a table it cannot expand alone, and says why', async () => {
    const { registry, tests } = await project({
      'suites/dupes.json': {
        name: 'menu.create',
        cases: [{ id: 'eur' }, { id: 'eur' }],
        steps: [{ type: 'note', text: 'made' }]
      },
      'suites/nameless.json': {
        name: 'menu.update',
        cases: [{ currency: 'EUR' }],
        steps: [{ type: 'note', text: 'made' }]
      },
      'suites/empty.json': { name: 'menu.delete', cases: [], steps: [{ type: 'note', text: 'made' }] }
    })

    // Two cases called `eur` would be two tests with one name, and the second
    // would overwrite the first in every report. Expanding first and checking
    // afterwards would leave nothing to point at.
    expect(tests.map((t) => t.name)).toEqual(['menu.create', 'menu.delete', 'menu.update'])

    const problems = validateTests(registry, tests).map((d) => `${d.path}: ${d.message}`)
    expect(problems).toContain("cases[1].id: duplicate case id 'eur'")
    expect(problems).toContain('cases[0].id: a case needs an id')
    expect(problems).toContain('cases: cases is empty, so this test never runs')
  })
})

describe('what a suite declares is checked before the run', () => {
  it('reports an unknown step type in a suite manifest', async () => {
    const { registry, tests } = await project({
      'suites/suite.json': { setup: [{ type: 'summon' }] },
      'suites/a.json': saying('a')
    })

    const problems = validateTests(registry, tests)

    // A suite whose setup cannot start blocks every test below it. Finding
    // that out in the middle of a run is finding it out at the worst moment.
    expect(problems).toContainEqual(
      expect.objectContaining({ file: 'suites/suite.json', path: 'setup[0].type' })
    )
  })
})
