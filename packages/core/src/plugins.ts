import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginSpec } from '@speq/plugin-api'
import { Registry } from './registry.js'
import type { SpeqConfig } from './config.js'

/**
 * Short names are a convenience only: `http` means `@speq/plugin-http`.
 * A third-party plugin is always named in full, so nothing in the ecosystem
 * has to be blessed by us to be usable.
 */
function candidates(spec: string): string[] {
  if (spec.startsWith('.') || isAbsolute(spec)) return [spec]
  if (spec.includes('/') || spec.startsWith('speq-plugin-')) return [spec]
  return [`@speq/plugin-${spec}`, `speq-plugin-${spec}`, spec]
}

export async function loadPlugins(config: SpeqConfig, root: string): Promise<Registry> {
  const registry = new Registry()
  registry.setConfig(config.settings)

  for (const spec of config.plugins) {
    const mod = await importPlugin(spec, root)
    const plugin = (mod.default ?? mod) as PluginSpec
    if (!plugin || typeof plugin.setup !== 'function') {
      throw new Error(`'${spec}' does not look like a speq plugin: no default export with a setup()`)
    }
    await registry.register(plugin)
  }

  registry.settle()
  return registry
}

async function importPlugin(spec: string, root: string): Promise<Record<string, unknown>> {
  const require = createRequire(join(root, 'noop.js'))
  const tried: string[] = []

  for (const candidate of candidates(spec)) {
    try {
      if (candidate.startsWith('.') || isAbsolute(candidate)) {
        const path = isAbsolute(candidate) ? candidate : resolve(root, candidate)
        return (await import(pathToFileURL(path).href)) as Record<string, unknown>
      }
      const resolved = require.resolve(candidate)
      return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>
    } catch (err) {
      tried.push(`${candidate}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }

  throw new Error(
    `cannot load plugin '${spec}'. Tried:\n  ${tried.join('\n  ')}\n` +
      `Run 'speq install' if it is declared but not yet fetched.`
  )
}
