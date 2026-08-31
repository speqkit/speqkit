import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'
import yaml from '@speqkit/plugin-yaml'

/**
 * The authoring format is a plugin point, so it is tested through the same
 * door any other loader would be: files written under the harness root, and
 * `discover()` asking the loaders what is in them.
 */

let kit: Harness
afterEach(async () => { await kit.close() })

const steps = definePlugin({
  name: 'steps',
  setup: (ctx) => ctx.defineStepType('echo', { execute: (_e, i) => ({ value: i.value }) })
})

async function kitWithYaml(): Promise<Harness> {
  kit = await harness(yaml, { with: [steps] })
  return kit
}

describe('reading a suite file', () => {
  it('carries the whole test, not only its body', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/lifecycle.yaml', [
      'name: a tenant can be renamed',
      'variables:',
      '  slug: "${gen:uuid}"',
      'setup:',
      '  - type: echo',
      '    value: register',
      'steps:',
      '  - type: echo',
      '    value: rename',
      'cleanup:',
      '  - type: echo',
      '    value: deregister'
    ].join('\n'))

    // A loader that dropped these would leave the kernel's own lifecycle
    // unreachable from the format everybody writes tests in.
    const [test] = await kit.discover()
    expect(test).toMatchObject({
      variables: { slug: '${gen:uuid}' },
      setup: [{ type: 'echo', value: 'register' }],
      cleanup: [{ type: 'echo', value: 'deregister' }]
    })
  })

  it('loads a test, its steps and its assertions', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/smoke.yaml', [
      'name: logs in',
      'tags: [smoke]',
      'steps:',
      '  - id: hello',
      '    type: echo',
      '    value: hi',
      'assert:',
      '  - type: equals',
      '    expected: hi'
    ].join('\n'))

    const [test] = await kit.discover()
    expect(test).toMatchObject({
      name: 'logs in',
      tags: ['smoke'],
      steps: [{ id: 'hello', type: 'echo', value: 'hi' }],
      assert: [{ type: 'equals', expected: 'hi' }],
      source: 'suites/smoke.yaml'
    })
  })

  it('reads several documents out of one file', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/two.yaml', 'name: first\nsteps: [{type: echo}]\n---\nname: second\nsteps: [{type: echo}]\n')

    expect((await kit.discover()).map((t) => t.name)).toEqual(['first', 'second'])
  })

  it('falls back to the file name when the document has none', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/checkout.yaml', 'steps: [{type: echo}]\n')

    expect((await kit.discover())[0]!.name).toBe('checkout')
  })

  it('claims .yml as well as .yaml', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/a.yml', 'name: short\nsteps: [{type: echo}]\n')

    expect((await kit.discover())[0]!.name).toBe('short')
  })

  it('skips an empty document rather than inventing a test', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/blank.yaml', '# nothing here\n')

    expect(await kit.discover()).toEqual([])
  })

  it('names the file when the YAML will not parse', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/broken.yaml', 'name: [unclosed\n')

    await expect(kit.discover()).rejects.toThrow(/broken\.yaml/)
  })
})

describe('the test form', () => {
  it('takes the identity from id and the headline from title', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/items.yaml', [
      'id: menu.items-create.creates-item',
      'title: POST /categories/{id}/items creates an item',
      'steps: [{type: echo}]'
    ].join('\n'))

    // The identity is what a report is compared against next quarter; the
    // title is what a person reads. Collapsing them into one field means
    // rewording the sentence renames the test.
    const [test] = await kit.discover()
    expect(test).toMatchObject({
      name: 'menu.items-create.creates-item',
      title: 'POST /categories/{id}/items creates an item'
    })
  })

  it('carries a key outside the spine as an annotation', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/owned.yaml', [
      'name: t', 'owner: mira', 'epic: menu', 'severity: blocker', 'steps: [{type: echo}]'
    ].join('\n'))

    // Nothing was declared. That is the trade: the kernel carries what it does
    // not understand rather than making every team's field a contract of ours.
    expect((await kit.discover())[0]!.meta).toEqual({ owner: 'mira', epic: 'menu', severity: 'blocker' })
  })

  it('reads an explicit meta block the same way', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/explicit.yaml', 'name: t\nmeta:\n  owner: mira\nsteps: [{type: echo}]\n')

    expect((await kit.discover())[0]!.meta).toEqual({ owner: 'mira' })
  })

  it('leaves the spine out of the annotations', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/spine.yaml', 'id: a\ntitle: b\ntags: [c]\nsteps: [{type: echo}]\n')

    expect((await kit.discover())[0]!.meta).toBeUndefined()
  })
})

describe('a directory that describes itself', () => {
  it('hands its annotations to every test under it', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/menu/suite.yaml', 'epic: menu\nowner: mira\n')
    kit.file('suites/menu/items/lists.yaml', 'name: lists\nsteps: [{type: echo}]\n')

    // Written once on the directory that is the menu group, rather than
    // copied into twelve files where the thirteenth is forgotten.
    expect((await kit.discover())[0]!.meta).toEqual({ epic: 'menu', owner: 'mira' })
  })

  it('lets the nearer file and then the test sharpen it', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/suite.yaml', 'epic: everything\nowner: platform\n')
    kit.file('suites/menu/suite.yaml', 'epic: menu\n')
    kit.file('suites/menu/lists.yaml', 'name: lists\nowner: mira\nsteps: [{type: echo}]\n')

    expect((await kit.discover())[0]!.meta).toEqual({ epic: 'menu', owner: 'mira' })
  })

  it('is never a test itself', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/suite.yaml', 'epic: menu\n')

    // It has no steps, so a loader that treated it as a test would report an
    // empty test as broken on every run.
    expect(await kit.discover()).toEqual([])
  })

  it('answers the same for one file as for the whole suite', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/menu/suite.yaml', 'epic: menu\n')
    kit.file('suites/menu/lists.yaml', 'name: lists\nsteps: [{type: echo}]\n')

    // A report must not depend on how the run was started.
    const alone = await kit.discover({ test: 'suites/menu/lists.yaml' })
    expect(alone[0]!.meta).toEqual({ epic: 'menu' })
  })

  it('still answers to the name the first release gave it', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/menu/init.yaml', 'epic: menu\n')
    kit.file('suites/menu/lists.yaml', 'name: lists\nsteps: [{type: echo}]\n')

    // `suite.yaml` is the name. A project written against `init.yaml` would
    // otherwise start running its manifest as an empty test, which is a
    // worse way to find out about a rename than a line in a changelog.
    expect((await kit.discover())[0]!.meta).toEqual({ epic: 'menu' })
  })

  it('declares the suite itself, not only what its tests inherit', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/menu/suite.yaml', [
      'title: The menu',
      'tags: [menu]',
      'pending: waiting on staging',
      'setup:',
      '  - type: echo',
      '    value: tenant',
      'cleanup:',
      '  - type: echo',
      '    value: drop',
      ''
    ].join('\n'))
    kit.file('suites/menu/lists.yaml', 'name: lists\nsteps: [{type: echo}]\n')

    // The loader reads the fields and stops there. What a suite means — the
    // tree, when its setup runs, what is inherited — is the kernel's, which
    // is what lets a loader for another format declare suites too.
    const suite = (await kit.discover())[0]!.suites![0]!
    expect(suite.name).toBe('suites/menu')
    expect(suite.title).toBe('The menu')
    expect(suite.tags).toEqual(['menu'])
    expect(suite.pending).toBe('waiting on staging')
    expect(suite.setup).toEqual([{ type: 'echo', value: 'tenant' }])
    expect(suite.cleanup).toEqual([{ type: 'echo', value: 'drop' }])
  })

  it('carries a cases table through untouched, for the kernel to expand', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/menu/create.yaml', [
      'id: menu.create',
      'cases:',
      '  - id: eur',
      '    variables: { currency: EUR }',
      '  - id: usd',
      '    variables: { currency: USD }',
      'steps: [{type: echo, value: "${currency}"}]',
      ''
    ].join('\n'))

    // `cases` is spine, so it is not filed into meta — and the loader does not
    // expand it, because the identity scheme is not a format's to invent.
    const tests = await kit.discover()
    expect(tests.map((t) => t.name)).toEqual(['menu.create[eur]', 'menu.create[usd]'])
    expect(tests[0]!.meta).toBeUndefined()
  })
})

describe('what discovery does with what was loaded', () => {
  it('keeps only the tests carrying a wanted tag', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/tagged.yaml', [
      'name: fast', 'tags: [smoke]', 'steps: [{type: echo}]',
      '---', 'name: slow', 'tags: [nightly]', 'steps: [{type: echo}]'
    ].join('\n'))

    expect((await kit.discover({ tags: ['smoke'] })).map((t) => t.name)).toEqual(['fast'])
  })

  it('runs what it read, end to end', async () => {
    const kit = await kitWithYaml()
    kit.file('suites/run.yaml', 'name: t\nsteps:\n  - id: a\n    type: echo\n    value: hi\n')

    const outcome = await kit.run(await kit.discover())
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result).toEqual({ value: 'hi' })
  })
})
