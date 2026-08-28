import semver from 'semver'
import type { PackageManifest, Packument, RegistryClient } from './registry.js'
import { assertRegistrySpec, candidates, parseSpec } from './spec.js'

export interface ResolvedPackage {
  name: string
  version: string
  resolved: string
  integrity: string
  /** Dependency name to the exact version chosen for it. */
  dependencies: Record<string, string>
  /** Declared optional peers that were deliberately not installed. */
  optionalPeers: string[]
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
export async function resolveGraph(specs: string[], client: RegistryClient): Promise<ResolvedGraph> {
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
    return manifest
  }

  for (const spec of specs) {
    assertRegistrySpec(spec)
    const parsed = parseSpec(spec)
    const manifest = await need(parsed.name, parsed.range, parsed.short)
    roots.push({ spec: parsed.raw, name: manifest.name, version: manifest.version })
  }

  return { packages, roots }
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
