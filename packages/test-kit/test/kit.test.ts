import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'

/**
 * The kit's promise is that a green test here means the plugin works inside
 * speq. These tests pin the parts of that promise the kit itself has to keep:
 * the real kernel underneath, a scope that survives between calls, and a
 * project root so `ctx.host` is not the stub that throws.
 */

let open: Harness | undefined
afterEach(async () => {
  await open?.close()
  open = undefined
})

async function kitFor(...args: Parameters<typeof harness>): Promise<Harness> {
  open = await harness(...args)
  return open
}

const greeter = definePlugin({
  name: 'speqkit-plugin-greeter',
  configSchema: { type: 'object', properties: { greeting: { type: 'string' } } },
  setup(ctx) {
    ctx.defineStepType('greet', {
      schema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
      execute(exec, input) {
        const greeting = (ctx.config<{ greeting?: string }>().greeting ?? 'hello')
        const message = `${greeting}, ${String(input.to)}`
        exec.attach('greeting.txt', message, 'text/plain')
        return { message, length: message.length }
      }
    })
    ctx.defineAssertion('says', {
      evaluate: (assert, input) => ({
        passed: assert.last?.message === input.expected,
        message: `got ${String(assert.last?.message)}`,
        expected: input.expected,
        actual: assert.last?.message
      })
    })
  }
})

describe('a step type runs against the real kernel', () => {
  it('executes it and hands back the result', async () => {
    const kit = await kitFor(greeter)
    const step = await kit.step({ type: 'greet', to: 'world' })

    expect(step.status).toBe('passed')
    expect(step.result).toEqual({ message: 'hello, world', length: 12 })
  })

  it('reads the plugin block out of the config, by short name', async () => {
    const kit = await kitFor(greeter, { config: { greeter: { greeting: 'привет' } } })
    const step = await kit.step({ type: 'greet', to: 'мир' })

    expect(step.result.message).toBe('привет, мир')
  })

  it('keeps bindings between calls, so the second step can read the first', async () => {
    const kit = await kitFor(greeter)
    await kit.step({ id: 'first', type: 'greet', to: 'world' })
    const second = await kit.step({ type: 'greet', to: '${first.length}' })

    expect(second.result.message).toBe('hello, 12')
  })

  it('resolves variables handed in for the call', async () => {
    const kit = await kitFor(greeter)
    const step = await kit.step({ type: 'greet', to: '${who}' }, { who: 'Ada' })

    expect(step.result.message).toBe('hello, Ada')
  })

  it('reports a throw as an error, with the message the plugin gave', async () => {
    const angry = definePlugin({
      name: 'angry',
      setup: (ctx) => ctx.defineStepType('boom', {
        execute() { throw new Error('the socket is closed') }
      })
    })
    const kit = await kitFor(angry)
    const step = await kit.step({ type: 'boom' })

    expect(step.status).toBe('error')
    expect(step.message).toBe('the socket is closed')
  })

  it('collects what the step attached, without touching the disk', async () => {
    const kit = await kitFor(greeter)
    const step = await kit.step({ type: 'greet', to: 'world' })

    expect(step.artifacts).toEqual([
      { name: 'greeting.txt', contentType: 'text/plain', body: 'hello, world' }
    ])
    expect(existsSync(join(kit.root, 'reports'))).toBe(false)
  })
})

describe('an assertion is evaluated the way the runner evaluates it', () => {
  it('applies to the last step by default', async () => {
    const kit = await kitFor(greeter)
    await kit.step({ type: 'greet', to: 'world' })
    const outcome = await kit.assert({ type: 'says', expected: 'hello, world' })

    expect(outcome.passed).toBe(true)
  })

  it('resolves ${...} in the assertion input, as a test file would', async () => {
    const kit = await kitFor(greeter)
    await kit.step({ id: 'hi', type: 'greet', to: 'world' })
    const outcome = await kit.assert({ type: 'says', expected: '${hi.message}' })

    expect(outcome).toMatchObject({ passed: true, actual: 'hello, world' })
  })

  it('takes a result to assert over when there was no step', async () => {
    const kit = await kitFor(greeter)
    const outcome = await kit.assert({ type: 'says', expected: 'x' }, { last: { message: 'y' } })

    expect(outcome).toMatchObject({ passed: false, actual: 'y' })
  })

  it('names what exists when the assertion does not', async () => {
    const kit = await kitFor(greeter)
    await expect(kit.assert({ type: 'sings' })).rejects.toThrow(/unknown assertion 'sings'.*says/s)
  })
})

describe('resources are held open across calls', () => {
  const log: string[] = []
  const stateful = definePlugin({
    name: 'stateful',
    setup(ctx) {
      ctx.defineResource<string>('pool', {
        scope: 'run',
        setup: () => { log.push('pool up'); return 'POOL' },
        teardown: () => { log.push('pool down') }
      })
      ctx.defineResource<string>('tx', {
        scope: 'test',
        async setup(res) {
          await res.resource('pool')
          log.push('tx up')
          return 'TX'
        },
        teardown: () => { log.push('tx down') }
      })
    }
  })

  it('acquires a resource that a bare Registry has no scope for', async () => {
    log.length = 0
    const kit = await kitFor(stateful)

    expect(await kit.resource('tx')).toBe('TX')
    expect(await kit.resource('tx')).toBe('TX')
    expect(log).toEqual(['pool up', 'tx up'])
  })

  it('tears the test scope down on endTest, and the rest on close', async () => {
    log.length = 0
    const kit = await kitFor(stateful)
    await kit.resource('tx')

    await kit.endTest()
    expect(log).toEqual(['pool up', 'tx up', 'tx down'])

    await kit.close()
    expect(log).toEqual(['pool up', 'tx up', 'tx down', 'pool down'])
  })
})

describe('the plugin gets a kernel, not the stub that throws', () => {
  const nosy = definePlugin({
    name: 'nosy',
    setup(ctx) {
      ctx.defineStepType('where', { execute: () => ({ root: ctx.host.root }) })
    }
  })

  it('answers host.root with the harness root', async () => {
    const kit = await kitFor(nosy)
    const step = await kit.step({ type: 'where' })

    expect(step.result.root).toBe(kit.root)
  })

  it('discovers test files the harness wrote, through the loaded loader', async () => {
    const loader = definePlugin({
      name: 'lines',
      setup(ctx) {
        ctx.defineStepType('echo', { execute: (_e, i) => ({ value: i.value }) })
        ctx.defineLoader('lines', {
          extensions: ['.txt'],
          load: (file, content) =>
            content.trim().split('\n').map((name) => ({ name, steps: [{ type: 'echo', value: name }], source: file }))
        })
      }
    })
    const kit = await kitFor(loader)
    kit.file('suites/smoke.txt', 'first\nsecond\n')

    const tests = await kit.discover()
    expect(tests.map((t) => t.name)).toEqual(['first', 'second'])
  })
})

describe('whole tests run through the runner', () => {
  it('reports the outcome, the assertions and the events', async () => {
    const kit = await kitFor(greeter)
    const outcome = await kit.run([
      { name: 'greets', steps: [{ id: 'a', type: 'greet', to: 'world' }], assert: [{ type: 'says', expected: 'hello, world' }] }
    ])

    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.assertions[0]!.passed).toBe(true)
    expect(kit.eventsOf('step.finished')[0]).toMatchObject({ stepType: 'greet', status: 'passed' })
  })

  it('writes artifacts under the root when it was asked to', async () => {
    const kit = await kitFor(greeter, { artifacts: true })
    const outcome = await kit.run([{ name: 'greets', steps: [{ type: 'greet', to: 'world' }] }])

    const path = outcome.artifacts[0]!.path!
    expect(path.startsWith(join(kit.root, 'reports'))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('hello, world')
  })

  it('checks a test against the schemas the plugin declared', async () => {
    const kit = await kitFor(greeter)
    const diagnostics = kit.validate([{ name: 't', steps: [{ type: 'greet' }], source: 'a.yaml' }])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain("missing required field 'to'")
  })
})

describe('a plugin can be loaded next to the surface it contributes into', () => {
  it('fires the injection when the peer plugin is there', async () => {
    const registered: string[] = []
    const surface = definePlugin({
      name: 'surface',
      setup: (ctx) => ctx.provide('cli', { register: (n: string) => registered.push(n) })
    })
    const contributor = definePlugin({
      name: 'contributor',
      setup: (ctx) => ctx.inject(['cli'], (r) => {
        (r.cli as { register(n: string): void }).register('seed')
      })
    })

    await kitFor(contributor, { with: [surface] })
    expect(registered).toEqual(['seed'])
  })

  it('loads the plugin alone without complaint when the surface is absent', async () => {
    const contributor = definePlugin({
      name: 'contributor',
      setup: (ctx) => ctx.inject(['cli'], () => { throw new Error('should not run') })
    })

    const kit = await kitFor(contributor)
    expect(kit.registry.loadedPlugins()).toEqual(['contributor'])
  })
})

describe('the harness cleans up after itself', () => {
  it('removes the temporary root it made', async () => {
    const kit = await harness(greeter)
    const root = kit.root
    kit.file('suites/a.txt', 'x')
    await kit.close()

    expect(existsSync(root)).toBe(false)
  })

  it('refuses to keep working once closed', async () => {
    const kit = await harness(greeter)
    await kit.close()

    await expect(kit.step({ type: 'greet', to: 'world' })).rejects.toThrow('closed')
  })
})
