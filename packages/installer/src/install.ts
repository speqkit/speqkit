import { Store, verifyIntegrity } from './store.js'
import { npmRegistry, type Packument, type RegistryClient } from './registry.js'
import { resolveGraph, type ResolvedPackage } from './resolve.js'
import { keyOf, parseKey, readLock, writeLock, type LockFile, type LockedRoot } from './lock.js'
import { readLinks } from './links.js'
import { parseSpec } from './spec.js'

export type InstallEvent =
  | { type: 'resolving'; specs: number }
  | { type: 'package'; name: string; version: string; source: 'cached' | 'downloaded' }
  | { type: 'linked'; name: string; path: string }
  | { type: 'warning'; message: string }
  | { type: 'lock'; file: string; changed: boolean }

export interface InstallOptions {
  /** The `.speq` directory: where speq.yaml, speq.lock and links.yaml live. */
  root: string
  /**
   * The `extends` list from the local file, read without flattening.
   * A preset is an ordinary package, so it has to be on disk before the
   * config that names it can be read — which is why this is a callback and
   * not a list, and why `plugins` below is called only afterwards.
   */
  presets(): string[] | Promise<string[]>
  /** The flattened plugin list. Called once the presets are installed. */
  plugins(): string[] | Promise<string[]>
  store?: Store
  client?: RegistryClient
  /** CI mode: install exactly the lock, and fail if it disagrees with the config. */
  frozen?: boolean
  onEvent?: (event: InstallEvent) => void
}

export interface InstallResult {
  packages: { name: string; version: string; source: 'cached' | 'downloaded' }[]
  plugins: LockedRoot[]
  presets: LockedRoot[]
  links: Record<string, string>
  lockChanged: boolean
}

interface Graph {
  packages: Map<string, ResolvedPackage>
  presets: LockedRoot[]
  plugins: LockedRoot[]
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  const store = options.store ?? new Store()
  const emit = options.onEvent ?? (() => {})
  const client = memoize(options.client ?? npmRegistry())
  const links = readLinks(options.root)
  const lock = readLock(options.root)

  if (options.frozen && !lock) {
    throw new Error(`--frozen needs a lockfile, and there is none in ${options.root}. Run 'speq install' first.`)
  }

  // Pass one: presets only. Nothing else can be read until they are here.
  const presetSpecs = await options.presets()
  const installed: InstallResult['packages'] = []

  if (presetSpecs.length > 0) {
    const presetGraph = options.frozen
      ? closure(lock!, matchRoots(lock!.presets, presetSpecs, 'preset'))
      : (await resolveGraph(presetSpecs, client)).packages
    await materialiseAll(presetGraph, store, client, emit, installed)
  }

  // Pass two: the real plugin list, now that `extends` can be followed.
  const pluginSpecs = (await options.plugins()).filter((spec) => !isLinked(spec, links, emit))

  const graph: Graph = options.frozen
    ? frozenGraph(lock!, presetSpecs, pluginSpecs)
    : await freshGraph(presetSpecs, pluginSpecs, client, emit)

  await materialiseAll(graph.packages, store, client, emit, installed)

  // Linking happens once every package is present, so a dependency's own
  // directory already exists when something points at it.
  for (const pkg of graph.packages.values()) {
    for (const [depName, depVersion] of Object.entries(pkg.dependencies)) {
      if (!store.has(depName, depVersion)) {
        emit({ type: 'warning', message: `${pkg.name} wants ${depName}@${depVersion}, which is not in the store` })
        continue
      }
      store.link(pkg, { name: depName, version: depVersion })
    }
  }

  let lockChanged = false
  if (!options.frozen) {
    const next: LockFile = {
      lockfileVersion: 1,
      presets: graph.presets,
      plugins: graph.plugins,
      packages: lockPackages(graph.packages)
    }
    lockChanged =
      JSON.stringify(next.packages) !== JSON.stringify(lock?.packages ?? {}) ||
      JSON.stringify(next.plugins) !== JSON.stringify(lock?.plugins ?? []) ||
      JSON.stringify(next.presets) !== JSON.stringify(lock?.presets ?? [])
    emit({ type: 'lock', file: writeLock(options.root, next), changed: lockChanged })
  }

  return { packages: installed, plugins: graph.plugins, presets: graph.presets, links, lockChanged }
}

/** A linked plugin is read from disk every time; there is nothing to pin. */
function isLinked(spec: string, links: Record<string, string>, emit: (e: InstallEvent) => void): boolean {
  const name = parseSpec(spec).name
  const hit = Object.entries(links).find(([linked]) => linked === name || linked.endsWith(`/plugin-${name}`) || linked === `speqkit-plugin-${name}`)
  if (!hit) return false
  emit({ type: 'linked', name: hit[0], path: hit[1] })
  return true
}

async function freshGraph(
  presetSpecs: string[],
  pluginSpecs: string[],
  client: RegistryClient,
  emit: (event: InstallEvent) => void
): Promise<Graph> {
  emit({ type: 'resolving', specs: presetSpecs.length + pluginSpecs.length })
  const resolved = await resolveGraph([...presetSpecs, ...pluginSpecs], client)

  for (const pkg of resolved.packages.values()) {
    for (const peer of pkg.optionalPeers) {
      emit({ type: 'warning', message: `${pkg.name} can use '${peer}', which is optional and was not installed` })
    }
  }
  return {
    packages: resolved.packages,
    presets: resolved.roots.slice(0, presetSpecs.length),
    plugins: resolved.roots.slice(presetSpecs.length)
  }
}

/**
 * `--frozen` replays the lock and refuses to think for itself.
 *
 * The failure it exists to catch is someone editing speq.yaml and not
 * re-running install: in CI that has to stop the build, not quietly resolve a
 * different plugin set than the one that was reviewed.
 */
function frozenGraph(lock: LockFile, presetSpecs: string[], pluginSpecs: string[]): Graph {
  const presets = matchRoots(lock.presets, presetSpecs, 'preset')
  const plugins = matchRoots(lock.plugins, pluginSpecs, 'plugin')
  return { packages: closure(lock, [...presets, ...plugins]), presets, plugins }
}

function matchRoots(locked: LockedRoot[], asked: string[], kind: string): LockedRoot[] {
  const drift = [
    ...asked.filter((s) => !locked.some((l) => l.spec === s)).map((s) => `  + ${kind} ${s} in speq.yaml, missing from the lock`),
    ...locked.filter((l) => !asked.includes(l.spec)).map((l) => `  - ${kind} ${l.spec} in the lock, missing from speq.yaml`)
  ]
  if (drift.length > 0) {
    throw new Error(`speq.lock does not match speq.yaml:\n${drift.join('\n')}\nRun 'speq install' and commit the result.`)
  }
  return locked
}

/** Everything the given roots reach through the lock's recorded edges. */
function closure(lock: LockFile, roots: LockedRoot[]): Map<string, ResolvedPackage> {
  const out = new Map<string, ResolvedPackage>()
  const queue = roots.map((r) => keyOf(r.name, r.version))

  while (queue.length > 0) {
    const key = queue.shift()!
    if (out.has(key)) continue
    const entry = lock.packages[key]
    if (!entry) {
      throw new Error(`speq.lock is incomplete: '${key}' is referenced but not described. Run 'speq install'.`)
    }
    const { name, version } = parseKey(key)
    out.set(key, {
      name,
      version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      dependencies: entry.dependencies ?? {},
      optionalPeers: []
    })
    for (const [depName, depVersion] of Object.entries(entry.dependencies ?? {})) {
      queue.push(keyOf(depName, depVersion))
    }
  }
  return out
}

async function materialiseAll(
  packages: Map<string, ResolvedPackage>,
  store: Store,
  client: RegistryClient,
  emit: (event: InstallEvent) => void,
  into: InstallResult['packages']
): Promise<void> {
  for (const pkg of packages.values()) {
    if (into.some((p) => p.name === pkg.name && p.version === pkg.version)) continue

    if (store.has(pkg.name, pkg.version)) {
      emit({ type: 'package', name: pkg.name, version: pkg.version, source: 'cached' })
      into.push({ name: pkg.name, version: pkg.version, source: 'cached' })
      continue
    }

    const bytes = await client.tarball(pkg.resolved)
    if (pkg.integrity) verifyIntegrity(bytes, pkg.integrity)
    else emit({ type: 'warning', message: `${pkg.name}@${pkg.version} publishes no integrity hash` })

    store.add(pkg.name, pkg.version, bytes)
    emit({ type: 'package', name: pkg.name, version: pkg.version, source: 'downloaded' })
    into.push({ name: pkg.name, version: pkg.version, source: 'downloaded' })
  }
}

function lockPackages(packages: Map<string, ResolvedPackage>): LockFile['packages'] {
  const out: LockFile['packages'] = {}
  // Sorted here as well as in writeLock: this object is compared against the
  // file that was read back, and an unsorted one reports a change that is
  // nothing but map ordering.
  const sorted = [...packages.values()].sort((a, b) => keyOf(a.name, a.version).localeCompare(keyOf(b.name, b.version)))
  for (const pkg of sorted) {
    out[keyOf(pkg.name, pkg.version)] = {
      resolved: pkg.resolved,
      integrity: pkg.integrity,
      ...(Object.keys(pkg.dependencies).length
        ? { dependencies: Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b))) }
        : {})
    }
  }
  return out
}

/** Presets and plugins are resolved in two passes; the registry sees one. */
function memoize(client: RegistryClient): RegistryClient {
  const cache = new Map<string, Promise<Packument>>()
  return {
    packument(name) {
      let pending = cache.get(name)
      if (!pending) {
        pending = client.packument(name)
        cache.set(name, pending)
      }
      return pending
    },
    tarball: (url) => client.tarball(url)
  }
}
