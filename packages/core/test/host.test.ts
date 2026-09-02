import { describe, expect, it, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry, bootstrap } from 'speqkit'
import type { Host } from '@speqkit/plugin-api'

/**
 * A plugin uses the kernel; it does not depend on it.
 *
 * `plugin-cli` used to open with `import { bootstrap, runTests } from
 * 'speqkit'`. That put the kernel in a plugin's published
 * `dependencies`, so the installer materialised a second copy of it into the
 * store, and it made the plugin call `bootstrap()` inside a process that had
 * already booted one — two registries, every plugin loaded twice, and the
 * kernel the user installed quietly replaced by whatever speq.lock pinned.
 *
 * `ctx.host` is the answer, and the two tests below are what keep it true:
 * one that the host really is the running session, and one that no plugin in
 * this repository has reached for the kernel again.
 */

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/**
 * A plugin written the way a stranger's plugin is: a file on disk, loaded by
 * path, with nothing from this workspace resolvable from where it sits. It
 * cannot import the kernel even if it wanted to — which is the point.
 */
const PROBE = `
export const seen = { setups: 0, host: undefined }

export default {
  name: 'probe',
  setup(ctx) {
    seen.setups += 1
    seen.host = ctx.host
    ctx.provide('probe', seen)
    ctx.defineLoader('json', {
      extensions: ['.json'],
      load: (file, content) => JSON.parse(content)
    })
    ctx.defineStepType('noop', {
      schema: { type: 'object', properties: { label: { type: 'string' } } },
      execute: () => ({ ok: true })
    })
    // Registered after 'noop' and listed before it: capabilities are ordered
    // by name, so two runs of one project produce the same document.
    ctx.defineStepType('echo', { execute: () => ({ ok: true }) })
    ctx.defineAssertion('is-ok', {
      schema: { type: 'object', properties: { expected: {} }, required: ['expected'] },
      evaluate: () => ({ passed: true, message: 'ok' })
    })
    ctx.defineValueProvider('clock', { prefix: 'now', resolve: () => 1 })
  }
}
`

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'speq-host-'))
  scratch.push(root)
  mkdirSync(join(root, 'suites'))
  mkdirSync(join(root, 'environments'))
  writeFileSync(join(root, 'probe.mjs'), PROBE)
  writeFileSync(join(root, 'speq.yaml'), 'version: 1\nplugins:\n  - ./probe.mjs\n')
  writeFileSync(join(root, 'environments', 'ci.yaml'), 'probe:\n  loud: true\n')
  writeFileSync(
    join(root, 'suites', 'smoke.json'),
    JSON.stringify([{ name: 'a test', steps: [{ id: 'one', type: 'noop' }] }])
  )
  return root
}

interface Probe {
  setups: number
  host: Host
}

describe('ctx.host', () => {
  it('is the session the plugin is already running inside', async () => {
    const root = project()
    const session = await bootstrap({ root })
    const probe = session.registry.service('probe') as Probe

    expect(probe.setups).toBe(1)
    expect(probe.host.root).toBe(root)
    expect(probe.host.reportDir).toBe(join(root, 'reports'))
    expect(probe.host.env).toBeUndefined()
  })

  it('drives discovery, validation and a run without booting a second kernel', async () => {
    const root = project()
    const session = await bootstrap({ root })
    const probe = session.registry.service('probe') as Probe
    const host = probe.host

    const tests = await host.discover()
    expect(tests.map((t) => t.name)).toEqual(['a test'])
    expect(host.validate(tests)).toEqual([])

    const outcome = await host.run(tests)
    expect(outcome.status).toBe('passed')
    expect(outcome.passed).toBe(1)

    // The load-bearing assertion. A plugin that bootstrapped for itself would
    // have re-run every setup() here, into a registry this session never sees.
    expect(probe.setups).toBe(1)
    expect(session.registry.loadedPlugins()).toEqual(['probe'])
  })

  /**
   * The schemas have existed in the registry since the plugin registered and
   * never left it, so an editor offering completion, a palette in a panel and
   * a prompt describing speq to a model each carried a copy of the vocabulary
   * — one that goes stale the moment somebody installs a plugin, and goes
   * stale silently, because a suite written against the wrong vocabulary looks
   * exactly like a suite with a typo in it.
   */
  it('hands out the grammar the loaded plugins define, schemas included', async () => {
    const root = project()
    const session = await bootstrap({ root })
    const host = (session.registry.service('probe') as Probe).host

    const capabilities = host.capabilities()

    expect(capabilities.apiVersion).toBe(1)
    expect(capabilities.plugins.map((plugin) => plugin.name)).toEqual(['probe'])

    // A step type the kernel has never heard of, described in full by the
    // session that loaded it.
    expect(capabilities.stepTypes).toEqual([
      { name: 'echo', plugin: 'probe', schema: undefined },
      {
        name: 'noop',
        plugin: 'probe',
        schema: { type: 'object', properties: { label: { type: 'string' } } }
      }
    ])
    expect(capabilities.assertions).toEqual([
      {
        name: 'is-ok',
        plugin: 'probe',
        schema: { type: 'object', properties: { expected: {} }, required: ['expected'] }
      }
    ])
    // The prefix, because `${now:...}` is what gets written; the name it was
    // registered under is nobody's business but the registry's.
    expect(capabilities.valueProviders).toEqual([
      { name: 'clock', plugin: 'probe', prefix: 'now' }
    ])
    expect(capabilities.loaders).toEqual([
      { name: 'json', plugin: 'probe', extensions: ['.json'], suiteFiles: undefined }
    ])
  })

  it('writes runs where speq report looks for them, and replays them', async () => {
    const root = project()
    const session = await bootstrap({ root })
    const host = (session.registry.service('probe') as Probe).host

    const outcome = await host.run(await host.discover())
    const runs = host.runs()
    expect(runs.map((r) => r.runId)).toEqual([outcome.runId])
    expect(runs[0]!.dir).toBe(join(root, 'reports', outcome.runId))

    const events = await host.replay(runs[0]!, [])
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'passed' })
  })

  it('carries the environment the session was started with', async () => {
    const root = project()
    const session = await bootstrap({ root, env: 'ci' })
    expect((session.registry.service('probe') as Probe).host.env).toBe('ci')
  })

  it('says so plainly when a registry was built without a session', async () => {
    const registry = new Registry()
    let host: Host | undefined
    await registry.register({
      name: 'detached',
      setup(ctx) {
        // Captured, not used: a plugin holding ctx.host through setup() is the
        // normal case, and it must not explode until something actually asks.
        host = ctx.host
      }
    })
    expect(host).toBeDefined()
    expect(() => host!.root).toThrow(/no session/)
    expect(() => host!.runs()).toThrow(/bootstrap\(\)/)
  })
})

describe('no plugin depends on the kernel', () => {
  /**
   * The structural guard. Everything above proves the contract is sufficient;
   * this proves nobody went around it. `@speqkit/plugin-cli` is the reference
   * every third-party plugin is copied from, so a kernel dependency here
   * would not stay here.
   */
  function pluginPackages(): { dir: string; manifest: Record<string, never> }[] {
    const out = []
    for (const dir of readdirSync('packages')) {
      try {
        const manifest = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'))
        if (manifest.keywords?.includes('speqkit-plugin')) out.push({ dir, manifest })
      } catch {
        continue
      }
    }
    return out
  }

  it('names the kernel in nothing a user of the plugin would install', () => {
    const offenders: string[] = []

    for (const { manifest } of pluginPackages()) {
      // `devDependencies` is deliberately not here. A plugin's tests run a
      // real kernel through `@speqkit/test-kit` — that is the whole point of
      // the kit — and nothing a consumer installs is affected by it. What
      // must stay clean is the graph the installer walks.
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        // Both names: the kernel was published as `@speqkit/core` in the
        // working tree before it became `speqkit`, and a plugin copied from
        // anything written back then would name the old one.
        for (const kernel of ['speqkit', '@speqkit/core']) {
          if (manifest[field]?.[kernel]) offenders.push(`${manifest.name} ${field} ${kernel}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('imports the kernel in no plugin source', () => {
    const offenders: string[] = []

    for (const { dir, manifest } of pluginPackages()) {
      const src = join('packages', dir, 'src')
      for (const file of readdirSync(src)) {
        if (!file.endsWith('.ts')) continue
        const source = readFileSync(join(src, file), 'utf8')
        if (/from '(speqkit|@speqkit\/core)'/.test(source)) {
          offenders.push(`${manifest.name} src/${file}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
