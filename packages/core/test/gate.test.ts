import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definePlugin, type RunEvent, type ResourceScope } from '@speq/plugin-api'
import { Registry, runTests } from '@speq/core'

/**
 * The second half of the architecture gate. `@speq/plugin-playwright` is a
 * real plugin written against the published API; these tests pin the two
 * kernel guarantees it depends on, with fakes, so they run in milliseconds and
 * need no browser.
 */

const scratch: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speq-gate-'))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

async function registryWith(...plugins: Parameters<Registry['register']>[0][]) {
  const registry = new Registry()
  for (const plugin of plugins) await registry.register(plugin)
  registry.settle()
  return registry
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

const camera = definePlugin({
  name: 'camera',
  setup(ctx) {
    ctx.defineStepType('snap', {
      execute(exec, input) {
        const name = String(input.name ?? 'screenshot.png')
        exec.attach(name, PNG, 'image/png')
        return { name, bytes: PNG.byteLength }
      }
    })
  }
})

describe('a binary artifact survives the run', () => {
  it('writes the bytes and tells every reporter where they went', async () => {
    const registry = await registryWith(camera)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))
    const dir = tempDir()

    const outcome = await runTests(
      registry,
      [{ name: 'takes a shot', steps: [{ type: 'snap' }] }],
      { artifactDir: dir, runId: 'run-1' }
    )

    expect(outcome.status).toBe('passed')
    const record = outcome.artifacts[0]!
    expect(record.bytes).toBe(PNG.byteLength)
    expect(record.contentType).toBe('image/png')
    expect(record.path).toContain(join('run-1', 'artifacts'))

    // The point of the whole exercise: the bytes are still the bytes.
    expect(new Uint8Array(readFileSync(record.path!))).toEqual(PNG)

    const attached = events.find((e) => e.type === 'artifact.attached')
    expect(attached).toMatchObject({ name: 'screenshot.png', bytes: PNG.byteLength, path: record.path })
  })

  it('keeps two artifacts of the same name as two files', async () => {
    const registry = await registryWith(camera)
    const dir = tempDir()
    const outcome = await runTests(
      registry,
      [{ name: 'twice', steps: [{ type: 'snap' }, { type: 'snap' }] }],
      { artifactDir: dir, runId: 'run-2' }
    )
    const [first, second] = outcome.artifacts
    expect(first!.path).not.toBe(second!.path)
    expect(second!.path).toContain('screenshot-2.png')
  })

  it('touches no disk at all when the caller gave it nowhere to write', async () => {
    const registry = await registryWith(camera)
    const outcome = await runTests(registry, [{ name: 'in memory', steps: [{ type: 'snap' }] }])
    const record = outcome.artifacts[0]!
    expect(record.path).toBeUndefined()
    expect(record.body).toEqual(PNG)
  })

  it('attributes each artifact to the test that produced it', async () => {
    const registry = await registryWith(camera)
    const outcome = await runTests(registry, [
      { name: 'one', steps: [{ type: 'snap', name: 'a.png' }] },
      { name: 'two', steps: [{ type: 'snap', name: 'b.png' }] }
    ])
    expect(outcome.tests[0]!.artifacts.map((a) => a.name)).toEqual(['a.png'])
    expect(outcome.tests[1]!.artifacts.map((a) => a.name)).toEqual(['b.png'])
  })
})

describe('all three resource scopes are real', () => {
  // The exact shape @speq/plugin-playwright declares: a browser for the run,
  // a fixture for the file, a page per test — the third depending on the
  // second depending on the first.
  const log: string[] = []
  const lifecycle = definePlugin({
    name: 'lifecycle',
    setup(ctx) {
      const declare = (name: string, scope: ResourceScope, needs?: string) =>
        ctx.defineResource<string>(name, {
          scope,
          async setup(res) {
            if (needs) await res.resource(needs)
            log.push(`${name} up`)
            return name
          },
          teardown: () => void log.push(`${name} down`)
        })

      declare('browser', 'run')
      declare('fixture', 'suite', 'browser')
      declare('page', 'test', 'fixture')

      ctx.defineStepType('visit', {
        async execute(exec) {
          return { page: await exec.resource<string>('page') }
        }
      })
    }
  })

  it('opens once per scope and tears down in reverse order', async () => {
    log.length = 0
    const registry = await registryWith(lifecycle)
    const events: RunEvent[] = []
    registry.events.subscribe((e) => events.push(e))

    const step = { type: 'visit' }
    const outcome = await runTests(registry, [
      { name: 'a1', source: 'suites/a.yaml', steps: [step] },
      { name: 'a2', source: 'suites/a.yaml', steps: [step] },
      { name: 'b1', source: 'suites/b.yaml', steps: [step] }
    ])

    expect(outcome.status).toBe('passed')
    expect(log).toEqual([
      'browser up',   // once, for the whole run
      'fixture up',   // once for suites/a.yaml
      'page up', 'page down',
      'page up', 'page down',
      'fixture down', // a.yaml is finished, b.yaml has not started
      'fixture up',
      'page up', 'page down',
      'fixture down',
      'browser down'
    ])

    const suites = events.filter((e) => e.type === 'suite.started').map((e) => e.suite)
    expect(suites).toEqual(['suites/a.yaml', 'suites/b.yaml'])
    expect(outcome.tests.map((t) => t.suite)).toEqual(['suites/a.yaml', 'suites/a.yaml', 'suites/b.yaml'])
  })

  it('tears the outer scopes down even when a test blows up', async () => {
    log.length = 0
    const exploding = definePlugin({
      name: 'exploding',
      setup(ctx) {
        ctx.defineStepType('boom', {
          execute() {
            throw new Error('driver crashed')
          }
        })
      }
    })
    const registry = await registryWith(lifecycle, exploding)
    const outcome = await runTests(registry, [
      { name: 'x', source: 'suites/a.yaml', steps: [{ type: 'visit' }, { type: 'boom' }] }
    ])

    expect(outcome.status).toBe('error')
    expect(log).toEqual(['browser up', 'fixture up', 'page up', 'page down', 'fixture down', 'browser down'])
  })

  it('names the resources that exist when a plugin asks for one that does not', async () => {
    const confused = definePlugin({
      name: 'confused',
      setup(ctx) {
        ctx.defineStepType('grab', {
          execute: async (exec) => ({ value: await exec.resource('webdriver') })
        })
      }
    })
    const registry = await registryWith(lifecycle, confused)
    const outcome = await runTests(registry, [{ name: 'x', steps: [{ type: 'grab' }] }])

    expect(outcome.status).toBe('error')
    const message = outcome.tests[0]!.steps[0]!.message!
    expect(message).toContain("unknown resource 'webdriver'")
    expect(message).toContain('browser')
  })
})
