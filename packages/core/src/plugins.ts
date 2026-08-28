import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginSpec as PluginModule } from '@speq/plugin-api'
import { Store, parseSpec, candidates, readLinks, readLock } from '@speq/installer'
import { Registry } from './registry.js'
import type { SpeqConfig } from './config.js'

export type PluginOrigin = 'path' | 'link' | 'store' | 'node_modules'

export interface PluginSource {
  spec: string
  name: string
  origin: PluginOrigin
  path: string
  version?: string
}

/**
 * Four places a plugin can come from, tried in this order:
 *
 *   path          an explicit ./ or / in speq.yaml
 *   link          `speq link` — the plugin being developed right now wins
 *   store         ~/.speq, pinned by speq.lock. The normal case in CI
 *   node_modules  ordinary resolution, for workspaces and Node projects
 *
 * The store comes before node_modules so that a lock actually locks. The
 * fallback stays because the framework must remain usable in a repository
 * that already is a Node project and has not run `speq install`.
 */
export async function loadPlugins(config: SpeqConfig, root: string): Promise<Registry> {
  const registry = new Registry()
  registry.setConfig(config.settings)

  for (const spec of config.plugins) {
    const source = resolvePlugin(spec, root)
    const mod = (await import(pathToFileURL(source.path).href)) as Record<string, unknown>
    const plugin = (mod.default ?? mod) as PluginModule

    if (!plugin || typeof plugin.setup !== 'function') {
      throw new Error(`'${spec}' does not look like a speq plugin: no default export with a setup()`)
    }
    registry.sources.set(plugin.name, { ...source, name: plugin.name })
    await registry.register(plugin)
  }

  registry.settle()
  return registry
}

export function resolvePlugin(spec: string, root: string): PluginSource {
  const parsed = parseSpec(spec)
  const tried: string[] = []

  if (parsed.name.startsWith('.') || isAbsolute(parsed.name)) {
    const path = isAbsolute(parsed.name) ? parsed.name : resolve(root, parsed.name)
    return { spec, name: parsed.name, origin: 'path', path: entryOf(path) }
  }

  const links = readLinks(root)
  for (const candidate of candidates(parsed.name)) {
    const target = links[candidate]
    if (target) {
      return { spec, name: candidate, origin: 'link', path: entryOf(target) }
    }
  }

  const locked = lockedVersion(root, spec, parsed.name)
  if (locked) {
    const store = new Store()
    if (store.has(locked.name, locked.version)) {
      const require = createRequire(join(store.virtualDir(locked.name, locked.version), 'noop.js'))
      try {
        return {
          spec,
          name: locked.name,
          origin: 'store',
          path: require.resolve(locked.name),
          version: locked.version
        }
      } catch (err) {
        tried.push(`store: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    } else {
      tried.push(`store: ${locked.name}@${locked.version} is in speq.lock but not in ${store.root}`)
    }
  }

  const require = createRequire(join(root, 'noop.js'))
  for (const candidate of candidates(parsed.name)) {
    try {
      return { spec, name: candidate, origin: 'node_modules', path: require.resolve(candidate) }
    } catch (err) {
      tried.push(`${candidate}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }

  throw new Error(
    `cannot load plugin '${spec}'. Tried:\n  ${tried.join('\n  ')}\n` +
      `Run 'speq install' if it is declared but not yet fetched.`
  )
}

/** The lock records what each spec turned out to mean; trust it over guessing. */
function lockedVersion(root: string, spec: string, name: string): { name: string; version: string } | undefined {
  let lock
  try {
    lock = readLock(root)
  } catch {
    return undefined
  }
  if (!lock) return undefined

  const exact = lock.plugins.find((p) => p.spec === spec)
  if (exact) return { name: exact.name, version: exact.version }

  const guessed = candidates(name)
  const byName = lock.plugins.find((p) => guessed.includes(p.name))
  return byName ? { name: byName.name, version: byName.version } : undefined
}

/**
 * A package directory to the module that should be imported.
 *
 * Deliberately a subset of Node's resolution: `exports["."]`, then `main`,
 * then `index.js`. It is used only where Node's own algorithm cannot be —
 * a linked directory that lives nowhere near a node_modules.
 */
function entryOf(dir: string): string {
  if (!existsSync(dir)) throw new Error(`plugin path does not exist: ${dir}`)
  if (/\.[cm]?[jt]sx?$/.test(dir)) return dir

  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return join(dir, 'index.js')

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exports?: unknown
    main?: string
  }
  const entry = pickExport(manifest.exports) ?? manifest.main ?? 'index.js'
  return resolve(dir, entry)
}

function pickExport(exports: unknown): string | undefined {
  if (typeof exports === 'string') return exports
  if (!exports || typeof exports !== 'object') return undefined
  const record = exports as Record<string, unknown>
  const dot = record['.'] ?? record
  if (typeof dot === 'string') return dot
  if (!dot || typeof dot !== 'object') return undefined
  const conditions = dot as Record<string, unknown>
  for (const key of ['import', 'module', 'default', 'require']) {
    const value = conditions[key]
    if (typeof value === 'string') return value
  }
  return undefined
}
