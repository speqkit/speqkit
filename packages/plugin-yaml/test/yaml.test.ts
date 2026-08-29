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
