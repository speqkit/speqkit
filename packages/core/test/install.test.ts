import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { Store, install, readLock, type Packument, type RegistryClient } from '@speqkit/installer'
import { Registry, addPluginToConfig, removePluginFromConfig, resolvePlugin, runTests } from 'speqkit'
import type { PluginSpec } from '@speqkit/plugin-api'

/**
 * The installer, end to end, with no network and no npm.
 *
 * The tarballs are built by the system `tar`, not by us, so the reader is
 * tested against a real archiver rather than against its own writer. What is
 * being pinned is the whole chain M2 exists for: resolve a range, verify a
 * hash, extract, lay the store out so Node's own resolution finds the
 * dependencies, write a lock, and have the kernel load the result.
 */

let work: string
let storeRoot: string
let project: string
let previousHome: string | undefined

const PACKAGES: Record<string, { version: string; files: Record<string, string>; manifest: Record<string, unknown> }> = {
  'tiny-dep': {
    version: '1.0.0',
    manifest: { name: 'tiny-dep', version: '1.0.0', type: 'module', main: 'index.js' },
    files: { 'index.js': `export const greeting = 'hello from tiny-dep'\n` }
  },
  '@fake/contract': {
    version: '1.2.0',
    manifest: { name: '@fake/contract', version: '1.2.0', type: 'module', main: 'index.js' },
    files: { 'index.js': `export const API = 1\n` }
  },
  '@fake/plugin-alpha': {
    version: '2.1.0',
    manifest: {
      name: '@fake/plugin-alpha',
      version: '2.1.0',
      type: 'module',
      exports: { '.': './src/plugin.js' },
      dependencies: { 'tiny-dep': '^1.0.0' },
      peerDependencies: { '@fake/contract': '^1.0.0', 'heavy-driver': '>=1' },
      peerDependenciesMeta: { 'heavy-driver': { optional: true } }
    },
    files: {
      // Imports a dependency and a peer: both have to be reachable from
      // inside the store for this module to even evaluate.
      'src/plugin.js':
        `import { greeting } from 'tiny-dep'\n` +
        `import { API } from '@fake/contract'\n` +
        `export default {\n` +
        `  name: '@fake/plugin-alpha',\n` +
        `  apiVersion: API,\n` +
        `  setup(ctx) {\n` +
        `    ctx.defineStepType('alpha', { execute: () => ({ said: greeting }) })\n` +
        `  }\n` +
        `}\n`
    }
  }
}

const tarballs = new Map<string, Uint8Array>()

function buildTarball(name: string): Uint8Array {
  const cached = tarballs.get(name)
  if (cached) return cached

  const spec = PACKAGES[name]!
  // npm wraps everything in `package/`; reproduce that exactly.
  const staging = mkdtempSync(join(work, 'pack-'))
  const dir = join(staging, 'package')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(spec.manifest, null, 2))
  for (const [file, content] of Object.entries(spec.files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), content)
  }

  const bytes = new Uint8Array(execFileSync('tar', ['-czf', '-', '-C', staging, 'package'], {
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer'
  }))
  tarballs.set(name, bytes)
  return bytes
}

function fakeRegistry(): RegistryClient {
  return {
    async packument(name): Promise<Packument> {
      const spec = PACKAGES[name]
      if (!spec) throw new Error(`no package '${name}' in the registry at (fake)`)
      const bytes = buildTarball(name)
      return {
        name,
        'dist-tags': { latest: spec.version },
        versions: {
          [spec.version]: {
            ...(spec.manifest as { name: string; version: string }),
            dist: {
              tarball: `fake://${name}/-/${spec.version}.tgz`,
              integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
            }
          }
        }
      } as Packument
    },
    async tarball(url) {
      const name = url.slice('fake://'.length, url.indexOf('/-/'))
      return buildTarball(name)
    }
  }
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'speq-install-'))
  storeRoot = join(work, 'home')
  project = join(work, 'service', '.speq')
  mkdirSync(join(project, 'suites'), { recursive: true })
  writeFileSync(
    join(project, 'speq.yaml'),
    `version: 1\n\n` +
      `# why this plugin is here — a comment that must survive 'speq add'\n` +
      `plugins:\n  - "@fake/plugin-alpha"\n`
  )
  previousHome = process.env.SPEQ_HOME
  process.env.SPEQ_HOME = storeRoot
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.SPEQ_HOME
  else process.env.SPEQ_HOME = previousHome
  rmSync(work, { recursive: true, force: true })
})

describe('the installer puts plugins on disk without npm', () => {
  it('resolves, verifies, extracts and locks', async () => {
    const warnings: string[] = []
    const result = await install({
      root: project,
      store: new Store(storeRoot),
      client: fakeRegistry(),
      presets: () => [],
      plugins: () => ['@fake/plugin-alpha'],
      onEvent: (e) => {
        if (e.type === 'warning') warnings.push(e.message)
      }
    })

    expect(result.plugins).toEqual([{ spec: '@fake/plugin-alpha', name: '@fake/plugin-alpha', version: '2.1.0' }])
    expect(result.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual([
      '@fake/contract@1.2.0',
      '@fake/plugin-alpha@2.1.0',
      'tiny-dep@1.0.0'
    ])
    expect(result.packages.every((p) => p.source === 'downloaded')).toBe(true)

    // A required peer is installed, because `definePlugin` is a runtime
    // import: a missing peer is a load failure, not a lint warning.
    // An optional one is reported and left alone.
    expect(warnings.join('\n')).toContain("can use 'heavy-driver'")

    const lock = readLock(project)!
    expect(lock.lockfileVersion).toBe(1)
    expect(Object.keys(lock.packages)).toEqual([
      '@fake/contract@1.2.0',
      '@fake/plugin-alpha@2.1.0',
      'tiny-dep@1.0.0'
    ])
    expect(lock.packages['@fake/plugin-alpha@2.1.0']!.dependencies).toEqual({
      '@fake/contract': '1.2.0',
      'tiny-dep': '1.0.0'
    })
    expect(lock.packages['tiny-dep@1.0.0']!.integrity).toMatch(/^sha512-/)
  })

  it('lays the store out so ordinary Node resolution finds the dependencies', async () => {
    const store = new Store(storeRoot)
    const entry = join(store.pathFor('@fake/plugin-alpha', '2.1.0'), 'src', 'plugin.js')
    const mod = (await import(pathToFileURL(entry).href)) as { default: PluginSpec }

    // Evaluating at all proves both symlinks resolve from inside the store.
    expect(mod.default.name).toBe('@fake/plugin-alpha')
  })

  it('loads through the kernel, from the lock rather than from node_modules', async () => {
    const source = resolvePlugin('@fake/plugin-alpha', project)
    expect(source.origin).toBe('store')
    expect(source.version).toBe('2.1.0')

    const mod = (await import(pathToFileURL(source.path).href)) as { default: PluginSpec }
    const registry = new Registry()
    await registry.register(mod.default)
    registry.settle()

    const outcome = await runTests(registry, [{ name: 'installed plugin runs', steps: [{ id: 'a', type: 'alpha' }] }])
    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result).toEqual({ said: 'hello from tiny-dep' })
  })

  it('is a no-op the second time, and downloads nothing', async () => {
    const result = await install({
      root: project,
      store: new Store(storeRoot),
      client: fakeRegistry(),
      presets: () => [],
      plugins: () => ['@fake/plugin-alpha']
    })
    expect(result.packages.every((p) => p.source === 'cached')).toBe(true)
    expect(result.lockChanged).toBe(false)
  })
})

describe('--frozen is the reason the lock exists', () => {
  it('replays the lock without asking the registry anything', async () => {
    const refuser: RegistryClient = {
      packument: () => Promise.reject(new Error('the registry must not be consulted under --frozen')),
      tarball: () => Promise.reject(new Error('the registry must not be consulted under --frozen'))
    }
    const result = await install({
      root: project,
      store: new Store(storeRoot),
      client: refuser,
      frozen: true,
      presets: () => [],
      plugins: () => ['@fake/plugin-alpha']
    })
    expect(result.packages).toHaveLength(3)
  })

  it('fails when speq.yaml has drifted from the lock', async () => {
    await expect(
      install({
        root: project,
        store: new Store(storeRoot),
        client: fakeRegistry(),
        frozen: true,
        presets: () => [],
        plugins: () => ['@fake/plugin-alpha', '@fake/plugin-beta']
      })
    ).rejects.toThrow(/does not match speq.yaml[\s\S]*plugin-beta/)
  })

  it('refuses a tarball that does not hash to what the registry published', async () => {
    const tampering: RegistryClient = {
      packument: (name) => fakeRegistry().packument(name),
      tarball: async () => new Uint8Array([1, 2, 3, 4])
    }
    await expect(
      install({
        root: mkdtempSync(join(work, 'other-')),
        store: new Store(join(work, 'cold-store')),
        client: tampering,
        presets: () => [],
        plugins: () => ['@fake/plugin-alpha']
      })
    ).rejects.toThrow(/integrity check failed/)
  })
})

describe('speq.yaml is edited, not rewritten', () => {
  it('keeps the comments a human wrote when a plugin is added', () => {
    addPluginToConfig(project, 'yaml')
    const after = readFileSync(join(project, 'speq.yaml'), 'utf8')

    expect(after).toContain("# why this plugin is here")
    expect(parseYaml(after).plugins).toEqual(['@fake/plugin-alpha', 'yaml'])

    // `http` and `@speqkit/plugin-http` name the same plugin, and so must remove.
    addPluginToConfig(project, '@speqkit/plugin-http@^2.0.0')
    expect(removePluginFromConfig(project, 'http').removed).toBe('@speqkit/plugin-http@^2.0.0')
    expect(removePluginFromConfig(project, 'yaml').removed).toBe('yaml')
    expect(parseYaml(readFileSync(join(project, 'speq.yaml'), 'utf8')).plugins).toEqual(['@fake/plugin-alpha'])
  })
})

describe('the version the CLI prints', () => {
  /**
   * `speq version` reports a literal, because the standalone binary has no
   * package.json to read at run time. A literal that nobody re-reads is a
   * literal that goes stale at the first release, so this is where it is
   * re-read.
   */
  it('is the version in packages/core/package.json', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { version: string }
    const source = readFileSync(fileURLToPath(new URL('../src/bin.ts', import.meta.url)), 'utf8')

    expect(source).toContain(`const VERSION = '${manifest.version}'`)
  })
})
