import { describe, expect, it, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry, bootstrap } from '@speqkit/core'
import type { Host } from '@speqkit/plugin-api'

/**
 * A plugin uses the kernel; it does not depend on it.
 *
 * `plugin-cli` used to open with `import { bootstrap, runTests } from
 * '@speqkit/core'`. That put the kernel in a plugin's published
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
    ctx.defineStepType('noop', { execute: () => ({ ok: true }) })
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
  it('names @speqkit/core in no plugin manifest', () => {
    const offenders: string[] = []

    for (const dir of readdirSync('packages')) {
      const file = join('packages', dir, 'package.json')
      let manifest
      try {
        manifest = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      if (!manifest.keywords?.includes('speqkit-plugin')) continue

      for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
        if (manifest[field]?.['@speqkit/core']) offenders.push(`${manifest.name} ${field}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
