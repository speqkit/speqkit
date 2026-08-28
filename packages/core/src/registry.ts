import type {
  PluginSpec, PluginContext, StepTypeDef, AssertionTypeDef, ResourceDef,
  ReporterDef, ValueProviderDef, LoaderDef, HookName, HookPayload,
  EventListener, InputSchema, Host
} from '@speqkit/plugin-api'
import { PLUGIN_API_VERSION, STEPS_SCHEMA } from '@speqkit/plugin-api'
import { EventBus } from './events.js'
import { ResourceManager } from './resources.js'
import { detachedHost } from './host.js'

/**
 * Composition is behind this facade on purpose.
 *
 * The design calls for Cordis, and the shape below is deliberately its shape:
 * services, optional injection, deferred registration. It is implemented here
 * directly because on day one the registry is ~100 lines and Cordis's API is
 * explicitly unstable. Swapping the internals for Cordis is a change to this
 * file alone — `@speqkit/plugin-api` never sees it either way. That is the whole
 * point of the facade, and the reason the decision can wait until M2.
 */

export interface Registered<T> {
  owner: string
  def: T
}

export class Registry {
  readonly events = new EventBus()
  readonly resources = new ResourceManager()

  readonly stepTypes = new Map<string, Registered<StepTypeDef>>()
  readonly assertions = new Map<string, Registered<AssertionTypeDef>>()
  readonly reporters = new Map<string, Registered<ReporterDef>>()
  readonly valueProviders = new Map<string, Registered<ValueProviderDef>>()
  readonly loaders = new Map<string, Registered<LoaderDef>>()
  readonly hooks = new Map<HookName, { owner: string; fn: (p: HookPayload) => unknown }[]>()
  readonly configSchemas = new Map<string, InputSchema>()
  /** Where each loaded plugin came from: link, store or node_modules. */
  readonly sources = new Map<string, { spec: string; name: string; origin: string; path: string; version?: string }>()

  /**
   * What every plugin sees as `ctx.host`. Attached by `loadPlugins`, because
   * only then is there a project root and a config to answer with; until
   * then it is a stand-in that throws on use rather than on construction.
   */
  #host: Host = detachedHost()

  readonly #services = new Map<string, unknown>()
  readonly #pending: { plugin: string; services: string[]; fn: (r: Record<string, unknown>) => void }[] = []
  readonly #loaded: string[] = []

  #config: Record<string, unknown> = {}

  setConfig(config: Record<string, unknown>): void {
    this.#config = config
  }

  setHost(host: Host): void {
    this.#host = host
  }

  configFor(plugin: string): Record<string, unknown> {
    const key = shortName(plugin)
    const value = this.#config[key]
    return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  }

  loadedPlugins(): readonly string[] {
    return this.#loaded
  }

  service(name: string): unknown {
    return this.#services.get(name)
  }

  async register(spec: PluginSpec): Promise<void> {
    const declared = spec.apiVersion ?? PLUGIN_API_VERSION
    if (declared !== PLUGIN_API_VERSION) {
      throw new Error(
        `plugin '${spec.name}' targets @speqkit/plugin-api v${declared}, ` +
          `this kernel speaks v${PLUGIN_API_VERSION}. ` +
          `Upgrade the plugin, or pin an older speq.`
      )
    }
    if (this.#loaded.includes(spec.name)) return

    if (spec.configSchema) this.configSchemas.set(shortName(spec.name), spec.configSchema)
    await spec.setup(this.#context(spec.name))
    this.#loaded.push(spec.name)
  }

  /**
   * Phase two. Every plugin has registered; now fire the injections whose
   * services actually exist. A plugin that wanted a surface nobody loaded
   * simply contributes nothing, and stays perfectly usable.
   */
  settle(): void {
    for (const entry of this.#pending) {
      const resolved: Record<string, unknown> = {}
      const missing = entry.services.filter((s) => {
        const value = this.#services.get(s)
        if (value === undefined) return true
        resolved[s] = value
        return false
      })
      if (missing.length > 0) continue
      entry.fn(resolved)
    }
    this.#pending.length = 0
  }

  #context(pluginName: string): PluginContext {
    // An arrow, because the getter below is not one and would otherwise see
    // the object literal's `this` rather than the registry's.
    const host = () => this.#host
    const claim = <T>(map: Map<string, Registered<T>>, kind: string, key: string, def: T) => {
      const existing = map.get(key)
      if (existing) {
        throw new Error(
          `${kind} '${key}' is already provided by plugin '${existing.owner}'; ` +
            `plugin '${pluginName}' cannot redefine it`
        )
      }
      map.set(key, { owner: pluginName, def })
    }

    return {
      pluginName,
      // A getter, so a plugin that captures `ctx` during setup() still sees
      // whatever host the session attaches afterwards.
      get host() {
        return host()
      },
      config: () => this.configFor(pluginName) as never,

      defineStepType: (type, def) => claim(this.stepTypes, 'step type', type, def),
      defineAssertion: (type, def) => claim(this.assertions, 'assertion', type, def),
      defineResource: (name, def) => this.resources.define(name, pluginName, def as ResourceDef<unknown>),
      defineReporter: (name, def) => claim(this.reporters, 'reporter', name, def),
      defineValueProvider: (name, def) => claim(this.valueProviders, 'value provider', name, def),
      defineLoader: (name, def) => claim(this.loaders, 'loader', name, def),

      defineHook: (name: HookName, fn) => {
        const list = this.hooks.get(name) ?? []
        list.push({ owner: pluginName, fn })
        this.hooks.set(name, list)
      },

      provide: (service, value) => {
        const existing = this.#services.get(service)
        if (existing !== undefined) {
          throw new Error(`service '${service}' is already provided; '${pluginName}' cannot replace it`)
        }
        this.#services.set(service, value)
      },

      inject: (services, fn) => {
        this.#pending.push({ plugin: pluginName, services, fn })
      },

      onEvent: (listener: EventListener) => {
        this.events.subscribe(listener)
      },

      schema: { steps: STEPS_SCHEMA }
    }
  }

  async runHooks(name: HookName, payload: HookPayload): Promise<void> {
    for (const hook of this.hooks.get(name) ?? []) {
      try {
        await hook.fn(payload)
      } catch (err) {
        this.events.emit({
          type: 'diagnostic',
          level: 'warn',
          message: `hook ${name} from '${hook.owner}' failed: ${String(err)}`,
          source: hook.owner
        })
      }
    }
  }
}

/** `@speqkit/plugin-http` and `speqkit-plugin-http` both configure under `http`. */
export function shortName(pluginName: string): string {
  return pluginName
    .replace(/^@[^/]+\//, '')
    .replace(/^speqkit-plugin-/, '')
    .replace(/^plugin-/, '')
}
