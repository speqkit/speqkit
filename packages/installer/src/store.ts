import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { extractTarGz } from './tar.js'

/**
 * The store is why a Go repository stays a Go repository.
 *
 * Plugins are never written into the project. They live once per machine,
 * keyed by name and version, and the project commits nothing but `speq.lock`.
 * The layout is pnpm's, and for pnpm's reason: a dependency is a symlink that
 * sits *inside* the depending package's own directory, so Node's ordinary
 * resolution — which follows real paths — still finds it, and two plugins
 * wanting different versions of the same library each get their own.
 *
 *   ~/.speq/store/@speq+plugin-http@2.1.4/node_modules/@speq/plugin-http/
 *                                        /node_modules/semver -> ../../semver@7.6.3/...
 */
export class Store {
  readonly root: string

  constructor(root?: string) {
    this.root = root ?? defaultStoreRoot()
  }

  /** The directory the package's own files live in. */
  pathFor(name: string, version: string): string {
    return join(this.virtualDir(name, version), 'node_modules', name)
  }

  virtualDir(name: string, version: string): string {
    return join(this.root, 'store', `${name.replace(/\//g, '+')}@${version}`)
  }

  has(name: string, version: string): boolean {
    return existsSync(join(this.pathFor(name, version), 'package.json'))
  }

  /**
   * Extract a verified tarball. Writes to a temporary directory and renames,
   * so an interrupted install can never leave a half-package that `has()`
   * would happily call cached.
   */
  add(name: string, version: string, tarball: Uint8Array): string {
    const target = this.pathFor(name, version)
    if (this.has(name, version)) return target

    const staging = `${this.virtualDir(name, version)}.tmp-${process.pid}-${Date.now()}`
    rmSync(staging, { recursive: true, force: true })
    const stagedPackage = join(staging, 'node_modules', name)

    for (const entry of extractTarGz(tarball)) {
      const file = join(stagedPackage, entry.path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, entry.body, { mode: entry.mode & 0o777 })
    }

    mkdirSync(dirname(this.virtualDir(name, version)), { recursive: true })
    rmSync(this.virtualDir(name, version), { recursive: true, force: true })
    renameSync(staging, this.virtualDir(name, version))
    return target
  }

  /**
   * Make `dep` importable from inside `pkg`. Relative on purpose: the whole
   * store stays movable, and a machine that syncs its home directory does not
   * end up with links pointing at someone else's username.
   */
  link(pkg: { name: string; version: string }, dep: { name: string; version: string }): void {
    const linkPath = join(this.virtualDir(pkg.name, pkg.version), 'node_modules', dep.name)
    if (existsSync(linkPath) || isBrokenLink(linkPath)) rmSync(linkPath, { recursive: true, force: true })

    mkdirSync(dirname(linkPath), { recursive: true })
    const target = relative(dirname(linkPath), this.pathFor(dep.name, dep.version))
    symlinkSync(target, linkPath, 'dir')
  }

  /** Everything currently in the store, for `speq doctor`. */
  contents(): { name: string; version: string }[] {
    const dir = join(this.root, 'store')
    if (!existsSync(dir)) return []
    const out: { name: string; version: string }[] = []
    for (const entry of readdirSync(dir)) {
      const at = entry.lastIndexOf('@')
      if (at <= 0) continue
      out.push({ name: entry.slice(0, at).replace(/\+/g, '/'), version: entry.slice(at + 1) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
}

export function defaultStoreRoot(): string {
  return process.env.SPEQ_HOME ?? join(homedir(), '.speq')
}

/**
 * npm publishes `sha512-<base64>`; older packages only have a sha1 shasum.
 * A tarball that matches neither is not installed — a plugin nobody can
 * verify is a plugin nobody should be running in CI.
 */
export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  const [algorithm, expected] = integrity.includes('-')
    ? [integrity.slice(0, integrity.indexOf('-')), integrity.slice(integrity.indexOf('-') + 1)]
    : ['sha1', integrity]

  const encoding = algorithm === 'sha1' && !expected.includes('=') ? 'hex' : 'base64'
  const actual = createHash(algorithm).update(bytes).digest(encoding as 'hex' | 'base64')

  if (actual !== expected) {
    throw new Error(
      `integrity check failed: expected ${algorithm}-${expected}, got ${algorithm}-${actual}. ` +
        `The download does not match what the registry published.`
    )
  }
}

export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function isBrokenLink(path: string): boolean {
  try {
    // lstat sees the link itself; existsSync followed the link and said no.
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
