import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, assertRegistrySpec, extractTarGz, integrityOf, parseSpec, pick, verifyIntegrity, type Packument } from '@speq/installer'

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
    expect(parseSpec('@speq/plugin-http@^2.1.0')).toMatchObject({ name: '@speq/plugin-http', range: '^2.1.0' })
    expect(parseSpec('@speq/plugin-http')).toMatchObject({ name: '@speq/plugin-http', range: '*' })
    expect(parseSpec('http')).toMatchObject({ name: 'http', range: '*', short: true })
    expect(parseSpec('speq-plugin-kafka@1.2.3')).toMatchObject({ name: 'speq-plugin-kafka', range: '1.2.3', short: false })
  })

  it('says plainly that a git source is not supported yet, instead of 404ing on it', () => {
    expect(() => assertRegistrySpec('github:acme/speq-plugin-legacy')).toThrow(/github source[\s\S]*speq link/)
    expect(() => assertRegistrySpec('@speq/plugin-http@^2')).not.toThrow()
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
