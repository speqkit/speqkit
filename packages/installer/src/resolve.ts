import { gunzipSync as gunzip } from 'node:zlib'
import semver from 'semver'
import type { PackageManifest, Packument, RegistryClient } from './registry.js'
import { candidates, classifySpec, parseSpec } from './spec.js'
import { assertBuilt, fetchCommit, gitVersion, parseGitSpec, readManifest, resolveCommit, type GitManifest, type GitSource } from './git.js'
import { Store, integrityOf } from './store.js'
import { readTar } from './tar.js'

export interface ResolvedPackage {
  name: string
  version: string
  resolved: string
  integrity: string
  /** Dependency name to the exact version chosen for it. */
  dependencies: Record<string, string>
  /** Declared optional peers that were deliberately not installed. */
  optionalPeers: string[]
  /**
   * A checkout already on disk, for a package that came from a repository.
   * Never written to the lock: the lock records the commit, and a path on
   * the machine that installed is meaningless on the machine that replays.
   */
  localDir?: string
  /** Bytes already downloaded, so a URL tarball is not fetched twice. */
  bytes?: Uint8Array
}

export interface ResolveOptions {
  /** Where a git checkout is cached between resolving and materialising. */
  store?: Store
}

export interface ResolvedGraph {
  /** Keyed `name@version`. */
  packages: Map<string, ResolvedPackage>
  /** The spec written in speq.yaml, to the package it turned out to mean. */
  roots: { spec: string; name: string; version: string }[]
}

/**
 * Resolves plugin specs into an exact, closed graph.
 *
 * Non-optional peer dependencies are installed rather than merely warned
 * about, because `@speqkit/plugin-api` is a peer of every plugin and
 * `definePlugin` is a real runtime import: a plugin whose peer is missing does
 * not fail a lint, it fails to load. Optional peers — Playwright's browser
 * driver, a database client — stay the user's decision.
 */
export async function resolveGraph(
  specs: string[],
  client: RegistryClient,
  options: ResolveOptions = {}
): Promise<ResolvedGraph> {
  const gitCache = (options.store ?? new Store()).gitCache()
  const packages = new Map<string, ResolvedPackage>()
  const packuments = new Map<string, Promise<Packument>>()
  const chosen = new Map<string, string>()
  const roots: ResolvedGraph['roots'] = []

  const packument = (name: string): Promise<Packument> => {
    let pending = packuments.get(name)
    if (!pending) {
      pending = client.packument(name)
      packuments.set(name, pending)
    }
    return pending
  }

  /** Short names are guessed only at the top level; a dependency is exact. */
  async function findPackument(name: string, short: boolean): Promise<Packument> {
    if (!short) return packument(name)
    const tried: string[] = []
    for (const candidate of candidates(name)) {
      try {
        return await packument(candidate)
      } catch (err) {
        tried.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    throw new Error(`cannot resolve plugin '${name}'. Tried:\n  ${tried.join('\n  ')}`)
  }

  async function need(name: string, range: string, short = false): Promise<PackageManifest> {
    const requirementKey = `${name}\t${range}`
    const already = chosen.get(requirementKey)
    if (already) return (await findPackument(name, short)).versions[already]!

    const doc = await findPackument(name, short)
    const manifest = pick(doc, range)
    chosen.set(requirementKey, manifest.version)

    const key = `${manifest.name}@${manifest.version}`
    if (!packages.has(key)) {
      const entry: ResolvedPackage = {
        name: manifest.name,
        version: manifest.version,
        resolved: manifest.dist.tarball,
        integrity: manifest.dist.integrity ?? (manifest.dist.shasum ? `sha1-${manifest.dist.shasum}` : ''),
        dependencies: {},
        optionalPeers: []
      }
      // Registered before recursing, so a dependency cycle terminates.
      packages.set(key, entry)

      await walkDependencies(entry, manifest)
    }
    return manifest
  }

  /**
   * A package's own requirements, wherever the package itself came from.
   *
   * They are resolved from the registry even for a plugin installed out of a
   * repository: `dependencies` in a package.json means registry ranges, and a
   * repository that wants to pin a dependency to another repository is asking
   * for a resolver this is deliberately not.
   */
  async function walkDependencies(entry: ResolvedPackage, manifest: PackageManifest | GitManifest): Promise<void> {
    for (const [depName, depRange] of Object.entries(manifest.dependencies ?? {})) {
      entry.dependencies[depName] = (await need(depName, depRange)).version
    }
    for (const [peerName, peerRange] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peerName]?.optional) {
        entry.optionalPeers.push(peerName)
        continue
      }
      entry.dependencies[peerName] = (await need(peerName, peerRange)).version
    }
  }

  /** A repository at a commit, as a package the rest of the graph can use. */
  async function needGit(source: GitSource): Promise<{ name: string; version: string }> {
    const commit = resolveCommit(source)
    const dir = fetchCommit(source, commit, gitCache)
    const manifest = readManifest(dir, source)
    assertBuilt(dir, manifest, source)

    const version = gitVersion(manifest.version, commit)
    const key = `${manifest.name}@${version}`
    if (!packages.has(key)) {
      const entry: ResolvedPackage = {
        name: manifest.name,
        version,
        // npm's spelling, and self-describing: the lock needs no new field to
        // record that this one is not a registry package.
        resolved: `git+${source.url}#${commit}`,
        integrity: '',
        dependencies: {},
        optionalPeers: [],
        localDir: dir
      }
      packages.set(key, entry)
      await walkDependencies(entry, manifest)
    }
    return { name: manifest.name, version }
  }

  /** A packed tarball at a URL. Hashed here, because nothing else vouches. */
  async function needTarball(url: string): Promise<{ name: string; version: string }> {
    const bytes = await client.tarball(url)
    const manifest = manifestFromTarball(bytes, url)

    const key = `${manifest.name}@${manifest.version}`
    if (!packages.has(key)) {
      const entry: ResolvedPackage = {
        name: manifest.name,
        version: manifest.version,
        resolved: url,
        // No registry published a hash for this, so the hash is of what we
        // actually received. It still pins: a replay that downloads different
        // bytes from the same URL fails, which is the whole job of a lock.
        integrity: integrityOf(bytes),
        dependencies: {},
        optionalPeers: [],
        bytes
      }
      packages.set(key, entry)
      await walkDependencies(entry, manifest)
    }
    return { name: manifest.name, version: manifest.version }
  }

  for (const spec of specs) {
    const kind = classifySpec(spec)
    if (kind === 'git') {
      const source = parseGitSpec(spec)!
      const root = await needGit(source)
      roots.push({ spec: spec.trim(), ...root })
      continue
    }
    if (kind === 'tarball') {
      const root = await needTarball(spec.trim())
      roots.push({ spec: spec.trim(), ...root })
      continue
    }
    const parsed = parseSpec(spec)
    const manifest = await need(parsed.name, parsed.range, parsed.short)
    roots.push({ spec: parsed.raw, name: manifest.name, version: manifest.version })
  }

  return { packages, roots }
}

/** The package.json inside a tarball, without unpacking it anywhere. */
function manifestFromTarball(bytes: Uint8Array, url: string): PackageManifest {
  const entry = readTar(gunzip(bytes), 1).find((e) => e.path === 'package.json')
  if (!entry) throw new Error(`${url} does not look like a packed package: no package.json inside`)

  const manifest = JSON.parse(Buffer.from(entry.body).toString('utf8')) as PackageManifest
  if (!manifest.name || !manifest.version) {
    throw new Error(`${url}: the package.json inside needs both a name and a version`)
  }
  return manifest
}

/** A range, or a dist-tag such as `latest` or `next`. */
export function pick(doc: Packument, range: string): PackageManifest {
  const tags = doc['dist-tags'] ?? {}
  const versions = Object.keys(doc.versions ?? {})
  if (versions.length === 0) throw new Error(`package '${doc.name}' has no published versions`)

  if (range === '*' || range === '' || range === 'latest') {
    const latest = tags.latest ?? semver.rsort(versions.filter((v) => semver.valid(v)))[0]
    if (latest && doc.versions[latest]) return doc.versions[latest]!
  }
  if (tags[range] && doc.versions[tags[range]!]) return doc.versions[tags[range]!]!

  if (!semver.validRange(range)) {
    throw new Error(`'${range}' is not a version range or a tag published for '${doc.name}'`)
  }
  const best = semver.maxSatisfying(versions, range)
  if (!best) {
    // What the maintainer points `latest` at, not the highest number: a
    // published prerelease is not what "the newest" means to anyone.
    const stable = semver.rsort(versions.filter((v) => semver.valid(v) && !semver.prerelease(v)))[0]
    const newest = tags.latest ?? stable ?? versions.at(-1)
    throw new Error(
      `no version of '${doc.name}' satisfies '${range}'; the newest published is ${newest}`
    )
  }
  return doc.versions[best]!
}
