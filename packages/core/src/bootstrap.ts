import { discoverRoot, type SpeqRoot } from './discovery.js'
import { loadConfig, type SpeqConfig } from './config.js'
import { loadPlugins } from './plugins.js'
import type { Registry } from './registry.js'

export interface BootstrapOptions {
  /** Explicit project root, as `--speq-root`. */
  root?: string
  /** Environment layer to apply, as `--env`. Falls back to `SPEQ_ENV`. */
  env?: string
}

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
export async function bootstrap(options: BootstrapOptions = {}): Promise<Session> {
  if (typeof options === 'string') {
    // Was `bootstrap(speqRoot)` until environments arrived. Silently ignoring
    // the argument would move the caller's root without saying so.
    throw new TypeError(`bootstrap() now takes options: bootstrap({ root: '${options}' })`)
  }
  const root = discoverRoot(options.root)
  const config = loadConfig(root.root, { env: options.env })
  const registry = await loadPlugins(config, root.root)
  return { root, config, registry }
}
