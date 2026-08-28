import { discoverRoot, type SpeqRoot } from './discovery.js'
import { loadConfig, type SpeqConfig } from './config.js'
import { loadPlugins } from './plugins.js'
import type { Registry } from './registry.js'

export interface Session {
  root: SpeqRoot
  config: SpeqConfig
  registry: Registry
}

/**
 * The four steps that constitute the whole kernel: find the project, read the
 * config, load the plugins, hand over control. Everything a user recognises as
 * the framework is contributed after this point.
 */
export async function bootstrap(speqRoot?: string): Promise<Session> {
  const root = discoverRoot(speqRoot)
  const config = loadConfig(root.root)
  const registry = await loadPlugins(config, root.root)
  return { root, config, registry }
}
