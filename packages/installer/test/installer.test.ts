import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Store, classifySpec, extractTarGz, gitVersion, install, integrityOf, parseGitSpec, parseSpec, pick,
  readLock, verifyIntegrity,
  type Packument, type RegistryClient
} from '@speqkit/installer'

const scratch: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** A single-entry tar, hand-built, so the nasty cases can actually be tested. */
function tarEntry(name: string, body: string, typeflag = '0'): Uint8Array {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'utf8')
  header.write('0000000\0', 108, 8, 'utf8')
  header.write('0000000\0', 116, 8, 'utf8')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  header.write('00000000000\0', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write(typeflag, 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')

  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')

  const content = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  content.write(body, 0, 'utf8')
  return new Uint8Array(Buffer.concat([header, content, Buffer.alloc(1024)]))
}

describe('reading a tarball is where an installer gets a security hole', () => {
  it('reads what the system archiver writes, and strips npm’s package/ prefix', () => {
    const dir = tempDir('speq-tar-')
    mkdirSync(join(dir, 'package', 'src'), { recursive: true })
    writeFileSync(join(dir, 'package', 'package.json'), '{"name":"x"}')
    writeFileSync(join(dir, 'package', 'src', 'index.js'), 'export default 1\n')

    const bytes = new Uint8Array(
      execFileSync('tar', ['-czf', '-', '-C', dir, 'package'], { encoding: 'buffer', maxBuffer: 1 << 24 })
    )
    const entries = extractTarGz(bytes)
    const paths = entries.map((e) => e.path).sort()

    expect(paths).toEqual(['package.json', 'src/index.js'])
    expect(Buffer.from(entries.find((e) => e.path === 'src/index.js')!.body).toString()).toBe('export default 1\n')
  })

  it('refuses an entry that climbs out of the directory it is written to', () => {
    const evil = gzipSync(Buffer.from(tarEntry('package/../../../.ssh/authorized_keys', 'pwned\n')))
    expect(() => extractTarGz(new Uint8Array(evil))).toThrow(/escapes the directory/)
  })

  it('refuses a link entry rather than following it', () => {
    const evil = gzipSync(Buffer.from(tarEntry('package/link', '', '2')))
    expect(() => extractTarGz(new Uint8Array(evil))).toThrow(/link entry/)
  })

  it('refuses an absolute path', () => {
    const evil = gzipSync(Buffer.from(tarEntry('/etc/passwd', 'root\n', '0')))
    expect(() => extractTarGz(new Uint8Array(evil), { strip: 0 })).toThrow(/escapes the directory/)
  })
})

describe('integrity is checked, not assumed', () => {
  it('accepts what the registry published and rejects anything else', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const integrity = integrityOf(bytes)

    expect(() => verifyIntegrity(bytes, integrity)).not.toThrow()
    expect(() => verifyIntegrity(new Uint8Array([9, 9, 9]), integrity)).toThrow(/integrity check failed/)
  })
})

describe('version selection', () => {
  const doc = {
    name: 'thing',
    'dist-tags': { latest: '2.1.0', next: '3.0.0-beta.1' },
    versions: {
      '1.9.0': manifest('1.9.0'),
      '2.0.0': manifest('2.0.0'),
      '2.1.0': manifest('2.1.0'),
      '3.0.0-beta.1': manifest('3.0.0-beta.1')
    }
  } as unknown as Packument

  it('takes the newest version a range allows', () => {
    expect(pick(doc, '^2.0.0').version).toBe('2.1.0')
    expect(pick(doc, '1.x').version).toBe('1.9.0')
  })

  it('understands dist-tags, including ones that are not latest', () => {
    expect(pick(doc, '*').version).toBe('2.1.0')
    expect(pick(doc, 'latest').version).toBe('2.1.0')
    expect(pick(doc, 'next').version).toBe('3.0.0-beta.1')
  })

  it('says what does exist when nothing satisfies the range', () => {
    expect(() => pick(doc, '^9.0.0')).toThrow(/no version of 'thing' satisfies '\^9.0.0'.*newest published is 2.1.0/)
  })
})

describe('plugin specs', () => {
  it('separates a version range from a scoped name', () => {
    expect(parseSpec('@speqkit/plugin-http@^2.1.0')).toMatchObject({ name: '@speqkit/plugin-http', range: '^2.1.0' })
    expect(parseSpec('@speqkit/plugin-http')).toMatchObject({ name: '@speqkit/plugin-http', range: '*' })
    expect(parseSpec('http')).toMatchObject({ name: 'http', range: '*', short: true })
    expect(parseSpec('speqkit-plugin-kafka@1.2.3')).toMatchObject({ name: 'speqkit-plugin-kafka', range: '1.2.3', short: false })
  })

  it('tells the four kinds of source apart', () => {
    expect(classifySpec('@speqkit/plugin-http@^2')).toBe('registry')
    expect(classifySpec('github:acme/speqkit-plugin-legacy#v2')).toBe('git')
    expect(classifySpec('git+ssh://git@github.com/acme/private.git#main')).toBe('git')
    expect(classifySpec('https://acme.dev/plugin-1.0.0.tgz')).toBe('tarball')
    expect(classifySpec('./local/plugin')).toBe('path')
  })

  it('refuses to guess what is behind a URL that is not a tarball', () => {
    expect(() => classifySpec('https://github.com/acme/plugin')).toThrow(/not a tarball[\s\S]*github:owner\/repo/)
  })

  /**
   * The `@` in `git@github.com` is not a version range, and splitting on it
   * produces a package called `git+ssh://git` that nothing will ever find.
   */
  it('does not read a version range out of an ssh URL', () => {
    expect(parseSpec('git+ssh://git@github.com/acme/private.git#v1')).toMatchObject({
      name: 'git+ssh://git@github.com/acme/private.git#v1',
      range: '*'
    })
  })
})

describe('a plugin can come from a repository', () => {
  it('expands the host shorthands, and keeps the ref apart from the URL', () => {
    expect(parseGitSpec('github:acme/plugin')).toMatchObject({
      url: 'https://github.com/acme/plugin.git',
      ref: undefined
    })
    expect(parseGitSpec('gitlab:team/plugin#main')).toMatchObject({
      url: 'https://gitlab.com/team/plugin.git',
      ref: 'main'
    })
    expect(parseGitSpec('bitbucket:team/plugin.git#8f2c1ad')).toMatchObject({
      url: 'https://bitbucket.org/team/plugin.git',
      ref: '8f2c1ad'
    })
    expect(parseGitSpec('git+ssh://git@acme.internal/qa/plugin.git#v1')).toMatchObject({
      url: 'ssh://git@acme.internal/qa/plugin.git',
      ref: 'v1'
    })
    expect(parseGitSpec('@speqkit/plugin-http@^2')).toBeUndefined()
  })

  it('says what a malformed shorthand should have looked like', () => {
    expect(() => parseGitSpec('github:acme')).toThrow(/github:owner\/repo#ref/)
  })

  /**
   * Two commits can carry the same `version`, and the store is keyed by name
   * and version. Build metadata keeps them apart without breaking the range
   * matching that a dependent package does against the same number.
   */
  it('keys a checkout by the commit, as semver build metadata', () => {
    expect(gitVersion('1.4.0', '8f2c1ade9b7c4d5e6f70819a2b3c4d5e6f708192')).toBe('1.4.0+8f2c1ade9b7c')
    expect(gitVersion('1.4.0+stale', '8f2c1ade9b7c4d5e6f70819a2b3c4d5e6f708192')).toBe('1.4.0+8f2c1ade9b7c')
  })
})

describe('the store keeps itself movable', () => {
  it('links a dependency with a relative path, not an absolute one', () => {
    const store = new Store(tempDir('speq-store-'))
    for (const [name, version] of [['host', '1.0.0'], ['dep', '2.0.0']] as const) {
      mkdirSync(store.pathFor(name, version), { recursive: true })
      writeFileSync(join(store.pathFor(name, version), 'package.json'), `{"name":"${name}","version":"${version}"}`)
    }

    store.link({ name: 'host', version: '1.0.0' }, { name: 'dep', version: '2.0.0' })
    const link = join(store.virtualDir('host', '1.0.0'), 'node_modules', 'dep')

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link).startsWith('/')).toBe(false)
    expect(store.contents()).toEqual([
      { name: 'dep', version: '2.0.0' },
      { name: 'host', version: '1.0.0' }
    ])
  })
})

function manifest(version: string) {
  return { name: 'thing', version, dist: { tarball: `fake://thing/${version}`, integrity: 'sha512-x' } }
}

/**
 * The end-to-end path, against a real repository on disk.
 *
 * `git+file://` is a real remote as far as git is concerned, so this exercises
 * exactly the code that runs for `github:` — ls-remote, a shallow fetch of one
 * commit, the checkout, the store — without a network or a fixture host.
 */
describe('installing a plugin out of a repository', () => {
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'speq', GIT_AUTHOR_EMAIL: 'speq@example.com',
        GIT_COMMITTER_NAME: 'speq', GIT_COMMITTER_EMAIL: 'speq@example.com'
      }
    }).trim()

  /** A repository holding a plugin with its build output committed. */
  function repository(options: { built?: boolean } = {}): { dir: string; commit: string } {
    const dir = tempDir('speq-repo-')
    git(['init', '--quiet', '--initial-branch', 'main'], dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'speqkit-plugin-legacy', version: '1.4.0', type: 'module', main: 'dist/index.js' })
    )
    if (options.built !== false) {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'index.js'), 'export default { name: "legacy", setup() {} }\n')
    }
    git(['add', '.'], dir)
    git(['commit', '--quiet', '-m', 'the plugin'], dir)
    git(['tag', 'v1.4.0'], dir)
    return { dir, commit: git(['rev-parse', 'HEAD'], dir) }
  }

  /** Nothing here may reach the registry: the package came from git. */
  const noRegistry: RegistryClient = {
    packument: (name) => Promise.reject(new Error(`the registry was asked for '${name}' and should not have been`)),
    tarball: (url) => Promise.reject(new Error(`the registry was asked for '${url}' and should not have been`))
  }

  async function installFrom(spec: string, options: { frozen?: boolean; root?: string; store?: Store } = {}) {
    const root = options.root ?? tempDir('speq-root-')
    const store = options.store ?? new Store(tempDir('speq-store-'))
    const result = await install({
      root,
      store,
      client: noRegistry,
      frozen: options.frozen,
      presets: () => [],
      plugins: () => [spec]
    })
    return { root, store, result }
  }

  it('resolves a tag to a commit, and stores the checkout under it', async () => {
    const repo = repository()
    const { root, store, result } = await installFrom(`git+file://${repo.dir}#v1.4.0`)

    const version = `1.4.0+${repo.commit.slice(0, 12)}`
    expect(result.plugins).toEqual([
      { spec: `git+file://${repo.dir}#v1.4.0`, name: 'speqkit-plugin-legacy', version }
    ])
    expect(store.has('speqkit-plugin-legacy', version)).toBe(true)
    expect(
      readFileSync(join(store.pathFor('speqkit-plugin-legacy', version), 'dist', 'index.js'), 'utf8')
    ).toContain('setup')

    // The commit, not the tag. A tag moves; CI installing `#v1.4.0` next month
    // has to get the commit that was reviewed this month.
    const lock = readLock(root)!
    expect(lock.packages[`speqkit-plugin-legacy@${version}`]!.resolved).toBe(`git+file://${repo.dir}#${repo.commit}`)
  })

  it('does not leave the repository history inside the store', async () => {
    const repo = repository()
    const { store } = await installFrom(`git+file://${repo.dir}#v1.4.0`)
    const version = `1.4.0+${repo.commit.slice(0, 12)}`
    expect(existsSync(join(store.pathFor('speqkit-plugin-legacy', version), '.git'))).toBe(false)
  })

  /**
   * The failure this prevents is silent and late: a repository with no build
   * output installs perfectly and then fails to load, minutes later, inside a
   * plugin loader with no idea why.
   */
  it('refuses a repository whose entry point was never committed', async () => {
    const repo = repository({ built: false })
    await expect(installFrom(`git+file://${repo.dir}#v1.4.0`)).rejects.toThrow(
      /entry point 'dist\/index.js' is not in the repository[\s\S]*does not run build or prepare scripts/
    )
  })

  it('replays the pinned commit under --frozen, with the ref long gone', async () => {
    const repo = repository()
    const spec = `git+file://${repo.dir}#v1.4.0`
    const { root } = await installFrom(spec)

    // The tag is deleted and the store is thrown away: the only thing left
    // pointing at the code is the commit written into the lock.
    git(['tag', '-d', 'v1.4.0'], repo.dir)
    const store = new Store(tempDir('speq-store-'))
    const { result } = await installFrom(spec, { root, store, frozen: true })

    const version = `1.4.0+${repo.commit.slice(0, 12)}`
    expect(result.plugins.map((p) => p.version)).toEqual([version])
    expect(store.has('speqkit-plugin-legacy', version)).toBe(true)
  })

  it('says which ref it could not find, rather than failing inside git', async () => {
    const repo = repository()
    await expect(installFrom(`git+file://${repo.dir}#v9.9.9`)).rejects.toThrow(
      /'v9.9.9' is not a branch, tag or commit/
    )
  })
})
