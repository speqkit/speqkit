import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { VERSIONS, assertName, packageNameFor, scaffold } from 'create-speqkit-plugin'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

const scratch: string[] = []
function tempDir(prefix = tmpdir()): string {
  const dir = mkdtempSync(join(prefix, 'speq-scaffold-'))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function generated(name = 'demo', options: Parameters<typeof scaffold>[0] | undefined = undefined) {
  const dir = tempDir()
  const result = scaffold({ name, dir, ...options })
  const read = (path: string) => readFileSync(join(dir, path), 'utf8')
  return { ...result, read, pkg: JSON.parse(read('package.json')) as Record<string, never> }
}

describe('naming', () => {
  it('turns a short name into the conventional package name', () => {
    expect(packageNameFor('kafka')).toBe('speqkit-plugin-kafka')
    expect(packageNameFor('kafka', '@acme')).toBe('@acme/speqkit-plugin-kafka')
    expect(packageNameFor('kafka', 'acme')).toBe('@acme/speqkit-plugin-kafka')
  })

  it('refuses a name that would not survive being a directory and a package', () => {
    for (const bad of ['Kafka', '@acme/kafka', 'my_thing', '2fast', 'my--thing', 'thing-']) {
      expect(() => assertName(bad), bad).toThrow(/will not work as a plugin name/)
    }
    for (const good of ['http', 'kafka', 'my-thing', 'k8s']) {
      expect(() => assertName(good), good).not.toThrow()
    }
  })
})

describe('what lands on disk', () => {
  it('writes source, tests, config and a README, and nothing else', () => {
    const { files } = generated()
    expect(files).toEqual([
      '.github/workflows/release.yml', '.gitignore', 'README.md', 'package.json',
      'src/index.ts', 'test/plugin.test.ts', 'tsconfig.json', 'vitest.config.ts'
    ])
  })

  it('takes the contract as a peer and never as a dependency', () => {
    const { pkg } = generated()
    expect(pkg.peerDependencies).toEqual({ '@speqkit/plugin-api': VERSIONS['@speqkit/plugin-api'] })
    expect(pkg.dependencies).toBeUndefined()
  })

  it('keeps the kernel a devDependency, so no plugin ships a second copy of it', () => {
    const { pkg, read } = generated()
    expect(pkg.devDependencies).toHaveProperty('speqkit')
    expect(read('src/index.ts')).not.toContain("from 'speqkit'")
  })

  it('carries the keyword the plugin is found by', () => {
    expect(generated().pkg.keywords).toContain('speqkit-plugin')
  })

  it('names the step type after the plugin, and the config block too', () => {
    const { read } = generated('kafka')
    expect(read('src/index.ts')).toContain("ctx.defineStepType('kafka.ping'")
    expect(read('test/plugin.test.ts')).toContain('config: { kafka: { greeting:')
  })

  it('quotes a hyphenated config key, which is not a bare identifier', () => {
    const { read } = generated('my-thing')
    expect(read('test/plugin.test.ts')).toContain("config: { 'my-thing': { greeting:")
  })

  it('publishes a scoped package with public access spelled out', () => {
    const { pkg, packageName } = generated('kafka', { name: 'kafka', scope: '@acme' })
    expect(packageName).toBe('@acme/speqkit-plugin-kafka')
    // In the manifest rather than in a README sentence: npm defaults a scoped
    // package to `restricted`, and a plugin that published fine and 404s for
    // everyone else is the kind of failure nobody reports, they just leave.
    expect(pkg.publishConfig).toEqual({ access: 'public' })
  })

  it('ships the release workflow, so delivery is not left to the author', () => {
    const { read } = generated('kafka')
    const workflow = read('.github/workflows/release.yml')
    expect(workflow).toContain('speqkit/speqkit/.github/workflows/plugin-release.yml@main')
    expect(workflow).toContain('NPM_TOKEN')
    // Bumping the version is the whole gesture, so main is the trigger.
    expect(workflow).toContain('branches: [main]')
  })

  it('refuses a directory that already has something in it', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'notes.txt'), 'mine')

    expect(() => scaffold({ name: 'demo', dir })).toThrow(/already has files/)
    expect(() => scaffold({ name: 'demo', dir, force: true })).not.toThrow()
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })
})

describe('the versions it pins do not go stale', () => {
  // The generated project asks npm for these by number, and this package is
  // published on its own — so at the moment it runs there is no workspace to
  // read them from. This is the check that keeps the hard-coded list honest.
  it.each([
    ['speqkit', 'core'],
    ['@speqkit/plugin-api', 'plugin-api'],
    ['@speqkit/test-kit', 'test-kit']
  ])('%s matches the version in the workspace', (dep, dir) => {
    const pkg = JSON.parse(readFileSync(join(repo, 'packages', dir, 'package.json'), 'utf8')) as { version: string }
    expect(VERSIONS[dep as keyof typeof VERSIONS]).toBe(`^${pkg.version}`)
  })
})

describe('the plugin it generates actually works', () => {
  // Generated into the repository rather than /tmp so Node resolution finds
  // vitest; the aliases stand in for the install a real author would run.
  it('passes its own tests, inside the real kernel', () => {
    const host = tempDir(repo)
    const dir = join(host, 'plugin')
    mkdirSync(dir, { recursive: true })
    scaffold({ name: 'demo', dir })

    writeFileSync(
      join(dir, 'vitest.config.ts'),
      `import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { alias: [
    { find: '@speqkit/plugin-api', replacement: ${JSON.stringify(join(repo, 'packages/plugin-api/src/index.ts'))} },
    { find: '@speqkit/test-kit', replacement: ${JSON.stringify(join(repo, 'packages/test-kit/src/index.ts'))} },
    { find: /^speqkit$/, replacement: ${JSON.stringify(join(repo, 'packages/core/src/index.ts'))} }
  ] },
  test: { include: ['test/**/*.test.ts'] }
})
`
    )

    const result = spawnSync('node', [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--root', dir], {
      encoding: 'utf8',
      env: { ...process.env, CI: '1' }
    })

    expect(result.stdout + result.stderr).toContain('8 passed')
    expect(result.status).toBe(0)
  }, 60_000)
})
